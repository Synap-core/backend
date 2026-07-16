/**
 * Generic trusted-issuer federation endpoints.
 *
 * The Pod knows only approved issuers, opaque issuer subjects, and its own
 * local membership. It never receives an external orchestrator's Pod ID or a
 * product-specific account identifier.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import jwt from "jsonwebtoken";
import { createLogger } from "@synap-core/core";
import { authMiddleware } from "@synap/auth";
import {
  activateFederatedMember,
  assertFederatedAccessTarget,
  bindExistingFederatedIdentity,
  consumeFederatedAssertionReceipt,
  consumeIssuerIdentityLinkReceipt,
  createIssuerIdentityLinkReceipt,
  and,
  arrayContains,
  eq,
  getDb,
  projectPodUserAccess,
  PodOwnerAlreadyClaimedError,
  FederatedApplicationConnectionService,
  seedAdminUser,
  type PodUserAccess,
  TrustedIssuerService,
  TRUSTED_ISSUER_CAPABILITIES,
} from "@synap/database";
import {
  federatedIdentityLinks,
  federatedApplicationConnections,
  projectMembers,
  projects,
  users,
  workspaceMembers,
  workspaces,
} from "@synap/database/schema";
import {
  normalizeIssuerUrl,
  normalizeApplicationCallbackUrl,
  normalizeApplicationClientId,
  normalizeApplicationConnectionScopes,
  normalizeApplicationOrigin,
  normalizePublisherUrl,
  hashOpaqueApplicationConnectionValue,
  verifyIssuerJwt,
  verifyTrustedIssuerJwt,
} from "@synap/api";
import { configuredPodAdminBase } from "../pod-admin-config.js";

const logger = createLogger({ module: "federation" });
export const federationRouter = new Hono();

const MAX_ASSERTION_LENGTH = 16_384;
const MAX_FEDERATED_ASSERTION_LIFETIME_SECONDS = 300;

const assertionEnvelope = z.object({
  assertion: z.string().min(1).max(MAX_ASSERTION_LENGTH),
});
const workspaceScopeSchema = z.object({
  kind: z.literal("workspace"),
  id: z.string().uuid(),
});
const projectScopeSchema = z.object({
  kind: z.literal("project"),
  id: z.string().uuid(),
});
const grantScopeSchema = z.discriminatedUnion("kind", [
  workspaceScopeSchema,
  projectScopeSchema,
]);
const requestedScopeSchema = z.discriminatedUnion("kind", [
  // Pod-wide access does not create a synthetic membership record. It means
  // the issuer is asking the Pod to select from the user's already-authorized
  // local scopes; the Pod still checks that at least one is active.
  z.object({ kind: z.literal("pod") }),
  workspaceScopeSchema,
  projectScopeSchema,
]);
const shortLivedAssertionClaims = {
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(1).max(512),
};
const identityLinkClaimsSchema = z.object({
  ...shortLivedAssertionClaims,
  iss: z.string().url(),
  sub: z.string().min(1).max(512),
  email: z.string().email(),
  type: z.literal("federated_assertion"),
  purpose: z.literal("identity-link"),
  intentId: z.string().min(1).max(512),
  nonce: z.string().min(16).max(1024),
  /** Optional registered application client id (authorized party). */
  azp: z.string().min(3).max(128).optional(),
});
const receiptClaimsSchema = z.object({
  ...shortLivedAssertionClaims,
  iss: z.string().url(),
  sub: z.string().min(1).max(512),
  type: z.literal("federated_assertion"),
  purpose: z.literal("identity-link-receipt"),
  intentId: z.string().min(1).max(512),
  nonce: z.string().min(16).max(1024),
  /** Optional registered app client carried from the direct-proof intent. */
  azp: z.string().min(3).max(128).optional(),
});
const exchangeClaimsSchema = z.object({
  ...shortLivedAssertionClaims,
  iss: z.string().url(),
  sub: z.string().min(1).max(512),
  type: z.literal("federated_assertion"),
  purpose: z.literal("user-exchange"),
  requestedScope: requestedScopeSchema.optional(),
  /** Optional registered application client id (authorized party). */
  azp: z.string().min(3).max(128).optional(),
});
const applicationConnectionProposalSchema = z.object({
  issuerUrl: z.string().url().max(2_048),
  azp: z.string().min(3).max(128),
  displayName: z.string().trim().min(1).max(160),
  publisherUrl: z.string().url().max(2_048).optional(),
  origin: z.string().url().max(2_048),
  callbackUrl: z.string().url().max(4_096),
  requestedScopes: z
    .array(z.enum(["auth:exchange-user", "identity:link-user"]))
    .min(1)
    .max(2)
    .default(["auth:exchange-user", "identity:link-user"]),
});
const applicationConnectionStartSchema =
  applicationConnectionProposalSchema.extend({
    requestId: z.string().uuid(),
    /**
     * Generic issuer-qualified subject commitment. It is checked against the
     * later signed assertion before the Pod links any local identity.
     */
    issuerSubject: z.string().trim().min(1).max(512),
    continuationHash: z.string().regex(/^[a-f0-9]{64}$/i),
    redemptionHash: z.string().regex(/^[a-f0-9]{64}$/i),
    // This short-lived browser proof is used only to pass the Pod-owned
    // native-login boundary. It is never persisted and is sent in the
    // Location fragment, which browsers do not include in requests.
    redemptionSecret: z.string().regex(/^[A-Za-z0-9_-]{32,512}$/),
    // HTML form submissions encode compound fields as strings. Keep the
    // wire-format concern here rather than teaching the generic service about
    // a browser transport.
    requestedScopes: z.preprocess(
      (value) => {
        if (typeof value !== "string") return value;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      },
      z
        .array(z.enum(["auth:exchange-user", "identity:link-user"]))
        .min(1)
        .max(2)
    ),
  });
const grantClaimsSchema = z.object({
  ...shortLivedAssertionClaims,
  iss: z.string().url(),
  sub: z.string().min(1).max(512),
  email: z.string().email(),
  name: z.string().max(500).optional(),
  type: z.literal("federated_assertion"),
  purpose: z.literal("access-grant"),
  commandId: z.string().min(1).max(512),
  scope: grantScopeSchema,
  role: z.enum(["admin", "editor", "viewer"]),
});
const bootstrapClaimsSchema = z.object({
  ...shortLivedAssertionClaims,
  iss: z.string().url(),
  sub: z.string().min(1).max(512),
  email: z.string().email(),
  name: z.string().max(500).optional(),
  type: z.literal("federated_assertion"),
  purpose: z.literal("initial-owner-bootstrap"),
  commandId: z.string().min(1).max(512),
});

const bootstrapIssuerCapabilities = [
  TRUSTED_ISSUER_CAPABILITIES.USER_EXCHANGE,
  TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK,
  TRUSTED_ISSUER_CAPABILITIES.MEMBERSHIP_GRANT,
  TRUSTED_ISSUER_CAPABILITIES.SOURCE_CONFIG_WRITE,
] as const;

type Assertion = Record<string, unknown> & { iss?: unknown };

const applicationConnectionService =
  new FederatedApplicationConnectionService();

function podAudience(): string | null {
  const value = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  return value || null;
}

/**
 * Trusted issuer URLs are persistent Pod-local identity keys. The JWT claim
 * must already have the exact canonical spelling used by the registry.
 */
function canonicalIssuerUrl(value: string): string | null {
  const normalized = normalizeIssuerUrl(value);
  return normalized === value ? normalized : null;
}

/**
 * App federation uses a query value so an exact origin/client pairing can be
 * checked during CORS preflight. It is not trusted by itself: below we require
 * it to equal the verified issuer assertion's signed `azp` claim.
 */
function requestedApplicationClientId(c: Context): string | null {
  const value = c.req.query("application_id");
  return value ? normalizeApplicationClientId(value) : null;
}

function requestedApplicationIssuerUrl(c: Context): string | null {
  const value = c.req.query("issuer_url");
  return value ? canonicalIssuerUrl(value) : null;
}

function isApplicationFederationAttempt(
  c: Context,
  azp: string | undefined
): boolean {
  return Boolean(
    azp || c.req.query("application_id") || c.req.query("issuer_url")
  );
}

function requestOriginMatchesConnection(
  c: Context,
  allowedOrigins: string[]
): boolean {
  const origin = c.req.header("origin");
  // Native clients and server-to-server callers do not have browser CORS. The
  // JWT/issuer checks remain their authentication boundary. Browser callers
  // must match the exact URL approved for this issuer/client connection.
  return !origin || allowedOrigins.includes(origin);
}

/**
 * Application-plane check (orthogonal to trusted-issuer crypto).
 *
 * Trusted issuer verification already ran on the JWT. This function only
 * answers: “for this signed app client (`azp`), has the owner approved the
 * calling browser Origin (and the capability)?” It does NOT re-bind the
 * connection to a particular issuer — issuer trust is plane 1; origin
 * allowlist is plane 2.
 *
 * Legacy issuer-only assertions (no azp / application query) skip this and
 * use issuer-wide capabilities instead.
 */
async function requireRegisteredApplicationConnection(input: {
  c: Context;
  issuerId: string;
  issuerUrl: string;
  azp: string | undefined;
  capability:
    | typeof TRUSTED_ISSUER_CAPABILITIES.USER_EXCHANGE
    | typeof TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK;
  purpose: "sign-in" | "identity-link";
  /**
   * Browser bootstrap binds the URL query to the signed `azp`. Server-to-Pod
   * receipts may skip browser Origin binding (requireBrowserBinding: false).
   */
  requireBrowserBinding?: boolean;
}): Promise<Response | null> {
  const requestedClientId = requestedApplicationClientId(input.c);
  const requestedIssuerUrl = requestedApplicationIssuerUrl(input.c);
  const isApplicationAttempt = isApplicationFederationAttempt(
    input.c,
    input.azp
  );
  if (!isApplicationAttempt) return null;

  if (!input.azp) {
    return input.c.json(
      {
        error: "This application is missing a signed registered identifier",
        code: "APPLICATION_IDENTIFIER_REQUIRED",
      },
      403
    );
  }
  const clientId = normalizeApplicationClientId(input.azp);
  if (!clientId) {
    return input.c.json(
      { error: "Invalid federated application identifier" },
      401
    );
  }
  if (
    input.requireBrowserBinding !== false &&
    (requestedClientId !== clientId || requestedIssuerUrl !== input.issuerUrl)
  ) {
    return input.c.json(
      {
        error: `This application identifier does not match the signed ${input.purpose} assertion`,
        code: "APPLICATION_IDENTIFIER_REQUIRED",
      },
      403
    );
  }

  const db = await getDb();
  // Lookup by client + origin only — not issuerId. The same app client may
  // have been registered while bootstrapping CP as issuer; transport admission
  // must not fail if JWT issuer trust is already satisfied independently.
  const originHeader = input.c.req.header("origin");
  const originNormalized = originHeader
    ? normalizeApplicationOrigin(originHeader)
    : null;

  // Server-to-server (no Origin): admit if any approved connection for this
  // client has the capability. Browser callers must match an approved origin.
  const connection = originNormalized
    ? await db.query.federatedApplicationConnections.findFirst({
        where: and(
          eq(federatedApplicationConnections.clientId, clientId),
          eq(federatedApplicationConnections.status, "approved"),
          arrayContains(federatedApplicationConnections.allowedOrigins, [
            originNormalized,
          ])
        ),
        columns: { allowedOrigins: true, allowedScopes: true },
      })
    : await db.query.federatedApplicationConnections.findFirst({
        where: and(
          eq(federatedApplicationConnections.clientId, clientId),
          eq(federatedApplicationConnections.status, "approved")
        ),
        columns: { allowedOrigins: true, allowedScopes: true },
      });

  if (
    !connection ||
    !connection.allowedScopes.includes(input.capability) ||
    (input.requireBrowserBinding !== false &&
      originNormalized &&
      !requestOriginMatchesConnection(input.c, connection.allowedOrigins))
  ) {
    return input.c.json(
      {
        error:
          "This Pod has not approved this browser origin for this application",
        code: "BROWSER_ORIGIN_NOT_APPROVED",
        azp: clientId,
        origin: originNormalized,
        remediation: "approve_browser_origin",
      },
      403
    );
  }
  return null;
}

function podAdminConnectionReviewTarget(
  requestId: string,
  redemptionSecret: string
):
  | { ok: true; url: string }
  | {
      ok: false;
      code: "POD_ADMIN_URL_REQUIRED" | "POD_ADMIN_URL_INVALID";
    } {
  const result = configuredPodAdminBase();
  if (!result.ok) return result;
  const base = result.base;

  // Pod Admin's native-login route redeems the generic request against the
  // locally authenticated Pod user before it exposes the review surface.
  base.pathname = "/connection-requests/new";
  base.search = "";
  base.searchParams.set("requestId", requestId);
  // A fragment is never sent to Pod Admin, its proxy, or application logs.
  // The client immediately scrubs it after reading the one-time proof.
  base.hash = new URLSearchParams({ redeem: redemptionSecret }).toString();
  return { ok: true, url: base.toString() };
}

function podAdminConnectionFailureTarget(code: string): string | null {
  const result = configuredPodAdminBase();
  if (!result.ok) return null;
  result.base.pathname = "/connection-requests/error";
  result.base.search = "";
  result.base.searchParams.set("code", code);
  return result.base.toString();
}

function applicationConnectionStartFailure(
  c: Context,
  status: 400 | 415 | 503,
  code: string,
  error: string
): Response {
  // Explicit API callers retain a JSON contract. A browser form submit must
  // never strand an owner on raw API JSON; use the configured Pod Admin error
  // surface whenever it is safe to do so.
  if (c.req.header("accept")?.includes("application/json")) {
    return c.json(
      {
        error,
        code,
        remediation:
          code === "POD_ADMIN_URL_REQUIRED" || code === "POD_ADMIN_URL_INVALID"
            ? "configure_pod_admin_url"
            : "review_pod_connection_setup",
      },
      status
    );
  }
  const target = podAdminConnectionFailureTarget(code);
  if (target) return c.redirect(target, 303);
  return c.html(
    "<!doctype html><title>Pod connection needs configuration</title><main><h1>Pod connection needs configuration</h1><p>This Pod cannot open its secure Admin console yet.</p><p>A Pod owner needs to configure this Pod's Admin URL before secure application access can be set up.</p></main>",
    status
  );
}

function normalizeApplicationConnectionProposal(input: {
  issuerUrl: string;
  azp: string;
  displayName: string;
  publisherUrl?: string;
  origin: string;
  callbackUrl: string;
  requestedScopes: string[];
}) {
  const issuerUrl = canonicalIssuerUrl(input.issuerUrl);
  const clientId = normalizeApplicationClientId(input.azp);
  const origin = normalizeApplicationOrigin(input.origin);
  const callbackUrl = origin
    ? normalizeApplicationCallbackUrl(input.callbackUrl, origin)
    : null;
  const publisherUrl = normalizePublisherUrl(input.publisherUrl);
  const requestedScopes = normalizeApplicationConnectionScopes(
    input.requestedScopes
  );
  if (
    !issuerUrl ||
    !clientId ||
    !origin ||
    !callbackUrl ||
    !requestedScopes ||
    (input.publisherUrl && !publisherUrl)
  ) {
    return null;
  }
  return {
    issuerUrl,
    clientId,
    displayName: input.displayName.trim(),
    publisherUrl,
    requestedOrigin: origin,
    requestedCallbackUrl: callbackUrl,
    requestedScopes,
  };
}

async function startApplicationConnectionRequest(input: {
  requestId: string;
  issuerUrl: string;
  issuerSubject: string;
  azp: string;
  displayName: string;
  publisherUrl?: string;
  origin: string;
  callbackUrl: string;
  requestedScopes: string[];
  continuationHash: string;
  redemptionHash: string;
}) {
  const proposal = normalizeApplicationConnectionProposal(input);
  if (!proposal) return null;
  return applicationConnectionService.createAwaitingLocalAuth({
    ...proposal,
    requestId: input.requestId,
    issuerSubject: input.issuerSubject.trim(),
    continuationHash: input.continuationHash.toLowerCase(),
    redemptionHash: input.redemptionHash.toLowerCase(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1_000),
    requestMetadata: { requestedVia: "browser-pod-admin-handoff" },
  });
}

/**
 * Keep issuer assertions short-lived before the shared verifier admits their
 * JTI to its replay cache. Signature verification below still makes these
 * decoded claims authoritative; this early shape check only prevents a
 * non-expiring or oversized assertion from consuming replay-cache capacity.
 */
export function decodeShortLivedAssertion(token: string): Assertion | null {
  if (token.length === 0 || token.length > MAX_ASSERTION_LENGTH) return null;

  try {
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return null;
    }
    const claims = decoded as Record<string, unknown>;
    const iat = claims.iat;
    const exp = claims.exp;
    const jti = claims.jti;
    if (
      typeof iat !== "number" ||
      typeof exp !== "number" ||
      !Number.isSafeInteger(iat) ||
      !Number.isSafeInteger(exp) ||
      typeof jti !== "string" ||
      jti.length === 0 ||
      jti.length > 512
    ) {
      return null;
    }
    if (exp <= iat || exp - iat > MAX_FEDERATED_ASSERTION_LIFETIME_SECONDS) {
      return null;
    }
    return claims as Assertion;
  } catch {
    return null;
  }
}

function hasIssuerCapability(
  issuer: { status: string; allowedScopes: string[] } | null,
  capability: string
): boolean {
  return Boolean(
    issuer &&
    issuer.status === "approved" &&
    issuer.allowedScopes.includes(capability)
  );
}

/**
 * Make each issuer assertion durable-single-use before the route performs a
 * Pod mutation or mints a session. Federation routes deliberately defer JTI
 * consumption to this receipt so a transient database failure does not poison
 * a valid retry; the receipt closes restart and multi-process replay windows.
 */
async function consumeFederatedAssertion(
  c: Context,
  issuerId: string,
  claims: { jti: string; exp: number },
  replayContext?: string
): Promise<Response | null> {
  try {
    const result = await consumeFederatedAssertionReceipt({
      issuerId,
      jti: claims.jti,
      expiresAt: new Date(claims.exp * 1_000),
      ...(replayContext ? { replayContext } : {}),
    });
    if (result === "consumed" || result === "recovered") return null;
    if (result === "expired") {
      return c.json({ error: "Federated assertion has expired" }, 401);
    }
    return c.json({ error: "Federated assertion has already been used" }, 409);
  } catch (error) {
    logger.error(
      { error, issuerId },
      "Could not record federated assertion replay receipt"
    );
    return c.json(
      { error: "Federated assertion replay protection is unavailable" },
      503
    );
  }
}

function hasValidBootstrapToken(providedToken: string | undefined): boolean {
  const expectedToken = process.env.PROVISIONING_TOKEN;
  if (!expectedToken || !providedToken) return false;

  // Hashing produces fixed-size values for the constant-time comparison, so
  // the boundary does not reveal token length or the first differing byte.
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  const providedHash = createHash("sha256").update(providedToken).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

type ResolveKratosIdentityResult =
  | { status: "resolved"; identityId: string; created: boolean }
  | { status: "unavailable" | "failed" };

/** Resolve or create a local Kratos identity for a generic issuer projection. */
async function resolveOrCreateKratosIdentity(input: {
  email: string;
  name?: string;
  createdVia: string;
}): Promise<ResolveKratosIdentityResult> {
  const kratosAdminUrl =
    process.env.KRATOS_ADMIN_URL || "http://localhost:4434";
  const existing = await fetch(
    `${kratosAdminUrl}/admin/identities?credentials_identifier=${encodeURIComponent(input.email)}`,
    { signal: AbortSignal.timeout(8_000) }
  ).catch(() => null);
  if (!existing?.ok) return { status: "unavailable" };

  const identities = (await existing.json().catch(() => [])) as Array<{
    id?: unknown;
  }>;
  const existingIdentityId = identities.find(
    (identity): identity is { id: string } => typeof identity.id === "string"
  )?.id;
  if (existingIdentityId) {
    return {
      status: "resolved",
      identityId: existingIdentityId,
      created: false,
    };
  }

  const created = await fetch(`${kratosAdminUrl}/admin/identities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema_id: "default",
      traits: {
        email: input.email,
        ...(input.name ? { name: input.name } : {}),
      },
      credentials: {
        password: {
          config: { password: randomBytes(32).toString("base64url") },
        },
      },
      metadata_public: { createdVia: input.createdVia },
      verifiable_addresses: [
        {
          value: input.email,
          verified: true,
          via: "email",
          status: "completed",
        },
      ],
    }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!created?.ok) return { status: "failed" };
  const identity = (await created.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  return typeof identity?.id === "string"
    ? { status: "resolved", identityId: identity.id, created: true }
    : { status: "failed" };
}

/**
 * Fast-fail before creating a pending issuer record. The transactionally
 * locked guard in `seedAdminUser` remains the source of truth for races.
 */
async function hasDifferentHumanPodOwner(
  issuerId: string | undefined,
  issuerSubject: string
): Promise<boolean> {
  const db = await getDb();
  const ownerRows = await db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(eq(workspaces.systemSlug, "pod-admin"), eq(users.userType, "human"))
    );
  const ownerIds = new Set(
    ownerRows
      .filter((owner) => owner.role === "owner" || owner.role === "admin")
      .map((owner) => owner.userId)
  );
  if (ownerIds.size === 0) return false;
  if (!issuerId) return true;

  const matchingLink = await db.query.federatedIdentityLinks.findFirst({
    where: and(
      eq(federatedIdentityLinks.issuerId, issuerId),
      eq(federatedIdentityLinks.issuerSubject, issuerSubject)
    ),
    columns: { userId: true },
  });
  return (
    !matchingLink ||
    [...ownerIds].some((ownerId) => ownerId !== matchingLink.userId)
  );
}

async function accessForUser(userId: string): Promise<PodUserAccess> {
  const db = await getDb();
  const [memberships, projectMemberships] = await Promise.all([
    db
      .select({
        workspaceId: workspaceMembers.workspaceId,
        role: workspaceMembers.role,
        systemSlug: workspaces.systemSlug,
        workspaceArchivedAt: workspaces.archivedAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, userId)),
    db
      .select({
        projectId: projectMembers.projectId,
        workspaceId: projects.workspaceId,
        role: projectMembers.role,
        status: projects.status,
        workspaceArchivedAt: workspaces.archivedAt,
        workspaceSystemSlug: workspaces.systemSlug,
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .leftJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projectMembers.userId, userId)),
  ]);
  return projectPodUserAccess(memberships, projectMemberships);
}

function canUseScope(
  access: PodUserAccess,
  scope: z.infer<typeof requestedScopeSchema> | undefined
): boolean {
  const hasActiveScope =
    access.workspaceScopes.length > 0 || access.projectScopes.length > 0;
  if (!scope || scope.kind === "pod") {
    return (
      hasActiveScope || access.podRole === "owner" || access.podRole === "admin"
    );
  }
  return scope.kind === "workspace"
    ? access.workspaceScopes.some((entry) => entry.workspaceId === scope.id)
    : access.projectScopes.some((entry) => entry.projectId === scope.id);
}

async function mintKratosSession(
  identityId: string
): Promise<{ sessionToken: string; session: Record<string, unknown> } | null> {
  const kratosAdminUrl =
    process.env.KRATOS_ADMIN_URL || "http://localhost:4434";
  const response = await fetch(
    `${kratosAdminUrl}/admin/identities/${identityId}/sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(8_000),
    }
  ).catch(() => null);
  if (!response?.ok) return null;
  const data = (await response.json().catch(() => null)) as {
    session_token?: string;
    session?: Record<string, unknown>;
  } | null;
  return data?.session_token
    ? { sessionToken: data.session_token, session: data.session ?? {} }
    : null;
}

/** Best-effort compensation when a newly-created auth identity cannot be granted Pod access. */
async function deleteKratosIdentity(
  kratosAdminUrl: string,
  identityId: string
): Promise<boolean> {
  const response = await fetch(
    `${kratosAdminUrl}/admin/identities/${encodeURIComponent(identityId)}`,
    {
      method: "DELETE",
      signal: AbortSignal.timeout(8_000),
    }
  ).catch(() => null);
  if (response?.ok || response?.status === 404) return true;

  logger.error(
    { identityId, kratosStatus: response?.status },
    "Federated grant compensation could not delete a newly-created Pod identity"
  );
  return false;
}

function setSessionCookie(c: Context, sessionToken: string): void {
  const forwardedProto = c.req
    .header("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const isSecure =
    forwardedProto === "https" ||
    c.req.header("x-scheme") === "https" ||
    c.req.url.startsWith("https") ||
    (process.env.PUBLIC_URL ?? "").startsWith("https://") ||
    process.env.NODE_ENV === "production";
  c.header(
    "Set-Cookie",
    `ory_kratos_session=${sessionToken}; Path=/; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=None`
  );
}

/**
 * Connection request CORS is deliberately endpoint-local and credentialless.
 * It is separate from global first-party CORS: an approved self-hosted app
 * needs to finish its own opaque continuation, but must never receive cookies
 * or a blanket Pod API allowlist.
 */
function setCredentiallessApplicationConnectionCors(
  c: Context,
  allowedOrigin: string | null
): boolean {
  const origin = c.req.header("origin");
  // This endpoint never relies on ambient cookies, even when a first-party
  // global CORS policy happened to add credentialed headers earlier.
  c.res.headers.delete("Access-Control-Allow-Credentials");
  if (!origin || !allowedOrigin || origin !== allowedOrigin) {
    c.res.headers.delete("Access-Control-Allow-Origin");
    return false;
  }
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  c.header("Access-Control-Max-Age", "600");
  c.header("Vary", "Origin");
  // Do not set Allow-Credentials. A continuation is authorized solely by its
  // two opaque values, never by an ambient Pod cookie.
  return true;
}

function isApplicationConnectionJsonRequest(c: Context): boolean {
  return (
    c.req
      .header("content-type")
      ?.toLowerCase()
      .startsWith("application/json") ?? false
  );
}

async function setStoredApplicationConnectionCors(
  c: Context
): Promise<boolean> {
  const requestId = z.string().uuid().safeParse(c.req.param("requestId"));
  if (!requestId.success) return false;
  const request = await applicationConnectionService.getRequest(requestId.data);
  return setCredentiallessApplicationConnectionCors(
    c,
    request?.requestedOrigin ?? null
  );
}

/**
 * Browser app → Pod Admin: start a top-level, credentialless handoff.
 *
 * This intentionally accepts an HTML form rather than a cross-origin fetch:
 * the browser follows the Pod-owned redirect to its configured Admin surface,
 * where local Kratos authentication happens. The request is created only as
 * `awaiting_local_auth`; redemption is what binds it to a Pod-local user.
 */
federationRouter.post("/application-connections/requests/start", async (c) => {
  const origin = c.req.header("origin");
  const normalizedOrigin = origin ? normalizeApplicationOrigin(origin) : null;
  if (!origin || normalizedOrigin !== origin) {
    return applicationConnectionStartFailure(
      c,
      400,
      "INVALID_APPLICATION_ORIGIN",
      "A canonical application Origin header is required"
    );
  }
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return applicationConnectionStartFailure(
      c,
      415,
      "INVALID_APPLICATION_HANDOFF",
      "Application setup must use a top-level form submission"
    );
  }
  const parsed = applicationConnectionStartSchema.safeParse(
    await c.req.parseBody().catch(() => null)
  );
  if (!parsed.success || parsed.data.origin !== origin) {
    return applicationConnectionStartFailure(
      c,
      400,
      "INVALID_APPLICATION_HANDOFF",
      "A canonical issuer, registered application, exact origin, callback, and continuation hash are required"
    );
  }
  if (
    hashOpaqueApplicationConnectionValue(parsed.data.redemptionSecret) !==
    parsed.data.redemptionHash.toLowerCase()
  ) {
    return applicationConnectionStartFailure(
      c,
      400,
      "INVALID_APPLICATION_HANDOFF",
      "Invalid application connection proof"
    );
  }
  const reviewTarget = podAdminConnectionReviewTarget(
    parsed.data.requestId,
    parsed.data.redemptionSecret
  );
  if (!reviewTarget.ok) {
    return applicationConnectionStartFailure(
      c,
      503,
      reviewTarget.code,
      "This Pod needs a secure Pod Admin URL before application access can be set up"
    );
  }
  try {
    const request = await startApplicationConnectionRequest(parsed.data);
    if (!request) {
      return applicationConnectionStartFailure(
        c,
        400,
        "INVALID_APPLICATION_HANDOFF",
        "Application origin and callback must be exact HTTPS URLs"
      );
    }
    return c.redirect(reviewTarget.url, 303);
  } catch (error) {
    logger.error({ error }, "Could not start Pod Admin connection handoff");
    return applicationConnectionStartFailure(
      c,
      503,
      "POD_CONNECTION_START_FAILED",
      "Could not start Pod Admin setup"
    );
  }
});

federationRouter.options(
  "/application-connections/requests/:requestId/:operation",
  async (c) => {
    const operation = c.req.param("operation");
    if (operation !== "status" && operation !== "complete") {
      return c.json({ error: "Not found" }, 404);
    }
    await setStoredApplicationConnectionCors(c);
    return c.body(null, 204);
  }
);

/**
 * The requesting application may poll this capability-guarded status while an
 * owner reviews on another device. It never returns callback data or tokens.
 */
federationRouter.post(
  "/application-connections/requests/:requestId/status",
  async (c) => {
    if (
      !isApplicationConnectionJsonRequest(c) ||
      !(await setStoredApplicationConnectionCors(c))
    ) {
      return c.json(
        { error: "Invalid application connection origin or content type" },
        400
      );
    }
    const requestId = z.string().uuid().safeParse(c.req.param("requestId"));
    const body = z
      .object({ continuation: z.string().min(32).max(512) })
      .safeParse(await c.req.json().catch(() => null));
    if (!requestId.success || !body.success) {
      return c.json(
        { error: "Invalid application connection status request" },
        400
      );
    }
    const status = await applicationConnectionService.getStatusForContinuation({
      requestId: requestId.data,
      continuationHash: hashOpaqueApplicationConnectionValue(
        body.data.continuation
      ),
    });
    if (!status) {
      return c.json({ error: "Application connection request not found" }, 404);
    }
    return c.json({
      status: status.status,
      expiresAt: status.expiresAt.toISOString(),
      ...(status.completion
        ? {
            receiptId: status.completion.receiptId,
            receiptExpiresAt: status.completion.expiresAt.toISOString(),
          }
        : {}),
    });
  }
);

/**
 * Requesting application → Pod: finish an owner-approved generic identity
 * link. The app proves only its opaque continuation and a fresh issuer
 * assertion; the Pod-local user was fixed by the native Pod Admin redemption
 * step, not by the owner who reviewed this request.
 */
federationRouter.post(
  "/application-connections/requests/:requestId/complete",
  async (c) => {
    if (
      !isApplicationConnectionJsonRequest(c) ||
      !(await setStoredApplicationConnectionCors(c))
    ) {
      return c.json(
        { error: "Invalid application connection origin or content type" },
        400
      );
    }
    const requestId = z.string().uuid().safeParse(c.req.param("requestId"));
    const body = z
      .object({
        continuation: z.string().min(32).max(512),
        assertion: z.string().min(1).max(MAX_ASSERTION_LENGTH).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!requestId.success || !body.success) {
      return c.json(
        { error: "Invalid application connection completion" },
        400
      );
    }
    const continuationHash = hashOpaqueApplicationConnectionValue(
      body.data.continuation
    );
    const existing =
      await applicationConnectionService.getStatusForContinuation({
        requestId: requestId.data,
        continuationHash,
      });
    if (!existing) {
      // Do not expose whether a request id, decision, or continuation failed.
      return c.json(
        { error: "Application connection completion is invalid or expired" },
        400
      );
    }
    if (existing.completion) {
      return c.json({
        status: "completed",
        receiptId: existing.completion.receiptId,
        expiresAt: existing.completion.expiresAt.toISOString(),
      });
    }
    if (existing.status === "completing") {
      const recovered =
        await applicationConnectionService.recoverStaleCompletion({
          requestId: requestId.data,
          continuationHash,
        });
      if (!recovered) {
        return c.json(
          { error: "Application connection is completing; retry shortly" },
          409
        );
      }
    }
    if (!body.data.assertion) {
      return c.json({ error: "Identity-link assertion is required" }, 400);
    }
    const request = await applicationConnectionService.getCompletableRequest({
      requestId: requestId.data,
      continuationHash,
    });
    if (!request) {
      return c.json(
        { error: "Application connection is not approved for completion" },
        409
      );
    }
    // Service admission guarantees this value, but retain a local narrow for
    // the compiler and for defence-in-depth if a future service changes.
    const requesterUserId = request.requestedByUserId;
    if (!requesterUserId) {
      return c.json(
        { error: "Application connection cannot be completed" },
        409
      );
    }
    const audience = podAudience();
    if (!audience) return c.json({ error: "PUBLIC_URL is required" }, 500);
    const decoded = decodeShortLivedAssertion(body.data.assertion);
    const candidateIssuerUrl =
      decoded && typeof decoded.iss === "string"
        ? canonicalIssuerUrl(decoded.iss)
        : null;
    if (!candidateIssuerUrl || candidateIssuerUrl !== request.issuerUrl) {
      return c.json({ error: "Invalid issuer identity-link assertion" }, 401);
    }
    const issuer = await new TrustedIssuerService().getByUrl(
      candidateIssuerUrl
    );
    if (!issuer || issuer.status !== "approved") {
      return c.json({ error: "Issuer is not approved" }, 401);
    }

    let payload: Assertion | null;
    try {
      payload = await verifyIssuerJwt<Assertion>(
        body.data.assertion,
        issuer.issuerUrl,
        audience,
        { consumeJti: false }
      );
    } catch {
      return c.json({ error: "Invalid issuer identity-link assertion" }, 401);
    }
    const claims = identityLinkClaimsSchema.safeParse(payload);
    if (
      !claims.success ||
      canonicalIssuerUrl(claims.data.iss) !== request.issuerUrl ||
      claims.data.sub !== request.issuerSubject ||
      claims.data.azp !== request.clientId ||
      !request.requestedScopes.includes("identity:link-user")
    ) {
      return c.json({ error: "Invalid issuer identity-link assertion" }, 401);
    }
    const applicationAdmission = await requireRegisteredApplicationConnection({
      c,
      issuerId: issuer.id,
      issuerUrl: request.issuerUrl,
      azp: claims.data.azp,
      capability: TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK,
      purpose: "identity-link",
      requireBrowserBinding: false,
    });
    if (applicationAdmission) return applicationAdmission;

    // Reserve before consuming the JTI. A concurrent caller that loses this
    // request-scoped lease has not spent its one-time issuer assertion and can
    // retry with the same fresh proof. The replay context below permits only
    // this exact request to recover a later post-consumption server failure.
    const reservation = await applicationConnectionService.reserveCompletion({
      requestId: request.id,
      continuationHash,
    });
    if (reservation?.kind === "completed") {
      return c.json({
        status: "completed",
        receiptId: reservation.completion.receiptId,
        expiresAt: reservation.completion.expiresAt.toISOString(),
      });
    }
    if (!reservation) {
      return c.json(
        { error: "Application connection is completing; retry shortly" },
        409
      );
    }

    const assertionResult = await consumeFederatedAssertion(
      c,
      issuer.id,
      claims.data,
      `application-connection:${request.id}`
    );
    if (assertionResult) {
      await applicationConnectionService
        .releaseCompletion({ requestId: request.id, continuationHash })
        .catch((releaseError) =>
          logger.error(
            { releaseError, requestId: request.id },
            "Could not release rejected application connection reservation"
          )
        );
      return assertionResult;
    }

    try {
      const reservedRequest = reservation.request;
      const requesterUserId = reservedRequest.requestedByUserId;
      if (!requesterUserId) {
        throw new Error("Application connection requester is unavailable");
      }
      // A receipt renewal proves the original committed subject again and
      // mints a fresh short-lived receipt. It intentionally does not call the
      // binding operation: `createIssuerIdentityLinkReceipt` below verifies
      // that the original issuer subject still maps to this Pod user.
      if (!reservedRequest.completedAt) {
        const binding = await bindExistingFederatedIdentity({
          issuerId: issuer.id,
          issuerSubject: claims.data.sub,
          kratosIdentityId: requesterUserId,
          linkedByUserId: requesterUserId,
        });
        if (binding.status !== "bound") {
          await applicationConnectionService.releaseCompletion({
            requestId: request.id,
            continuationHash,
          });
          return c.json(
            {
              error: "Could not link this Pod identity",
              reason: binding.reason,
            },
            409
          );
        }
      }
      const receipt = await createIssuerIdentityLinkReceipt({
        issuerId: issuer.id,
        issuerSubject: claims.data.sub,
        userId: requesterUserId,
        intentId: claims.data.intentId,
        nonce: claims.data.nonce,
        expiresAt: new Date(
          Math.min(claims.data.exp * 1_000, Date.now() + 5 * 60_000)
        ),
      });
      const finalized = await applicationConnectionService.finalizeCompletion({
        requestId: request.id,
        continuationHash,
        completion: receipt,
      });
      if (!finalized) {
        throw new Error("Could not persist completed application connection");
      }
      return c.json({
        status: "completed",
        receiptId: receipt.receiptId,
        expiresAt: receipt.expiresAt.toISOString(),
      });
    } catch (error) {
      await applicationConnectionService
        .releaseCompletion({ requestId: request.id, continuationHash })
        .catch((releaseError) =>
          logger.error(
            { releaseError, requestId: request.id },
            "Could not release application connection completion reservation"
          )
        );
      logger.error(
        { error, requestId: request.id, issuerId: issuer.id },
        "Could not complete application connection identity link"
      );
      return c.json(
        { error: "Could not complete application connection" },
        503
      );
    }
  }
);

/** Browser → Pod: a direct Pod session links one issuer subject. */
federationRouter.post("/identity-links", authMiddleware, async (c) => {
  const userId = c.get("userId" as never) as string | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const parsed = assertionEnvelope.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!parsed.success) return c.json({ error: "assertion is required" }, 400);
  const audience = podAudience();
  if (!audience) return c.json({ error: "PUBLIC_URL is required" }, 500);

  const decoded = decodeShortLivedAssertion(parsed.data.assertion);
  const issuerUrl =
    decoded && typeof decoded.iss === "string"
      ? canonicalIssuerUrl(decoded.iss)
      : null;
  if (!issuerUrl) {
    return c.json({ error: "Invalid issuer identity-link assertion" }, 401);
  }

  const db = await getDb();
  const localUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, email: true },
  });
  const issuerService = new TrustedIssuerService();
  let issuer = await issuerService.getByUrl(issuerUrl);
  if (!issuer || issuer.status !== "approved") {
    return c.json(
      {
        error:
          "This issuer is not approved to link Pod identities. Start a Pod Admin application-connection request so an owner can review the exact issuer and browser application.",
        code: "ISSUER_APPROVAL_REQUIRED",
      },
      403
    );
  }

  // Identity binding is attempted only after an already-approved issuer has
  // passed the Pod's cryptographic verifier.
  const payload = await verifyIssuerJwt<Assertion>(
    parsed.data.assertion,
    issuer.issuerUrl,
    audience,
    { consumeJti: false }
  );
  const claims = identityLinkClaimsSchema.safeParse(payload);
  if (
    !claims.success ||
    canonicalIssuerUrl(claims.data.iss) !== issuerUrl ||
    !localUser ||
    localUser.email.trim().toLowerCase() !==
      claims.data.email.trim().toLowerCase()
  ) {
    return c.json({ error: "Invalid issuer identity-link assertion" }, 401);
  }

  const applicationAttempt = isApplicationFederationAttempt(c, claims.data.azp);
  if (
    !applicationAttempt &&
    !hasIssuerCapability(issuer, TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK)
  ) {
    return c.json(
      { error: "This issuer is not approved to link Pod identities" },
      403
    );
  }
  const identityLinkApplicationAdmission =
    await requireRegisteredApplicationConnection({
      c,
      issuerId: issuer.id,
      issuerUrl,
      azp: claims.data.azp,
      capability: TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK,
      purpose: "identity-link",
    });
  if (identityLinkApplicationAdmission) return identityLinkApplicationAdmission;
  const approvedIssuer = issuer;
  const assertionResult = await consumeFederatedAssertion(
    c,
    approvedIssuer.id,
    claims.data
  );
  if (assertionResult) return assertionResult;

  const binding = await bindExistingFederatedIdentity({
    issuerId: approvedIssuer.id,
    issuerSubject: claims.data.sub,
    kratosIdentityId: userId,
    linkedByUserId: userId,
  });
  if (binding.status !== "bound") {
    return c.json(
      { error: "Could not link this Pod identity", reason: binding.reason },
      409
    );
  }
  const receipt = await createIssuerIdentityLinkReceipt({
    issuerId: approvedIssuer.id,
    issuerSubject: claims.data.sub,
    userId,
    intentId: claims.data.intentId,
    nonce: claims.data.nonce,
  });
  return c.json({
    success: true,
    receiptId: receipt.receiptId,
    expiresAt: receipt.expiresAt,
  });
});

/** Issuer server → Pod: consume a one-time browser proof and get current access. */
federationRouter.post("/identity-links/consume", async (c) => {
  const body = z
    .object({
      receiptId: z.string().uuid(),
      assertion: z.string().min(1).max(MAX_ASSERTION_LENGTH),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success)
    return c.json({ error: "receiptId and assertion are required" }, 400);
  const audience = podAudience();
  if (!audience) return c.json({ error: "PUBLIC_URL is required" }, 500);
  if (!decodeShortLivedAssertion(body.data.assertion)) {
    return c.json({ error: "Invalid identity-link receipt assertion" }, 401);
  }
  const decoded = decodeShortLivedAssertion(body.data.assertion);
  const candidateIssuerUrl =
    decoded && typeof decoded.iss === "string"
      ? canonicalIssuerUrl(decoded.iss)
      : null;
  const issuer = candidateIssuerUrl
    ? await new TrustedIssuerService().getByUrl(candidateIssuerUrl)
    : null;
  if (!issuer || issuer.status !== "approved") {
    return c.json({ error: "Issuer is not approved" }, 401);
  }

  let payload: Assertion | null;
  try {
    payload = await verifyIssuerJwt<Assertion>(
      body.data.assertion,
      issuer.issuerUrl,
      audience,
      { consumeJti: false }
    );
  } catch {
    return c.json({ error: "Invalid identity-link receipt assertion" }, 401);
  }
  const claims = receiptClaimsSchema.safeParse(payload);
  const issuerUrl = claims.success ? canonicalIssuerUrl(claims.data.iss) : null;
  if (!claims.success || !issuerUrl || issuerUrl !== issuer.issuerUrl)
    return c.json({ error: "Invalid identity-link receipt assertion" }, 401);
  const applicationAttempt = Boolean(claims.data.azp);
  if (
    !applicationAttempt &&
    !issuer.allowedScopes.includes(TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK)
  ) {
    return c.json({ error: "Issuer is not approved" }, 401);
  }
  const applicationAdmission = await requireRegisteredApplicationConnection({
    c,
    issuerId: issuer.id,
    issuerUrl,
    azp: claims.data.azp,
    capability: TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK,
    purpose: "identity-link",
    requireBrowserBinding: false,
  });
  if (applicationAdmission) return applicationAdmission;
  const assertionResult = await consumeFederatedAssertion(
    c,
    issuer.id,
    claims.data
  );
  if (assertionResult) return assertionResult;
  const receipt = await consumeIssuerIdentityLinkReceipt({
    issuerId: issuer.id,
    issuerSubject: claims.data.sub,
    intentId: claims.data.intentId,
    nonce: claims.data.nonce,
    receiptId: body.data.receiptId,
  });
  if (receipt.status !== "consumed" && receipt.status !== "already-consumed") {
    return c.json(
      { error: "Identity-link receipt is expired or already consumed" },
      409
    );
  }
  const access = await accessForUser(receipt.userId);
  if (!canUseScope(access, undefined)) {
    return c.json({ error: "Linked Pod user has no active access" }, 403);
  }
  return c.json({ success: true, access });
});

/** Issuer server → Pod: project one exact local membership command. */
federationRouter.post("/access-grants", async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing issuer assertion" }, 401);
  }
  const assertion = authHeader.slice(7).trim();
  if (!decodeShortLivedAssertion(assertion)) {
    return c.json({ error: "Invalid federated access grant" }, 401);
  }
  const audience = podAudience();
  if (!audience) return c.json({ error: "PUBLIC_URL is required" }, 500);
  const payload = await verifyTrustedIssuerJwt<Assertion>(assertion, {
    audience,
    requiredScope: TRUSTED_ISSUER_CAPABILITIES.MEMBERSHIP_GRANT,
    consumeJti: false,
  });
  const claims = grantClaimsSchema.safeParse(payload);
  const issuerUrl = claims.success ? canonicalIssuerUrl(claims.data.iss) : null;
  if (!claims.success || !issuerUrl)
    return c.json({ error: "Invalid federated access grant" }, 401);
  const issuer = await new TrustedIssuerService().getByUrl(issuerUrl);
  if (
    !issuer ||
    issuer.status !== "approved" ||
    !issuer.allowedScopes.includes(TRUSTED_ISSUER_CAPABILITIES.MEMBERSHIP_GRANT)
  ) {
    return c.json({ error: "Issuer is not approved" }, 401);
  }
  const assertionResult = await consumeFederatedAssertion(
    c,
    issuer.id,
    claims.data
  );
  if (assertionResult) return assertionResult;

  try {
    await assertFederatedAccessTarget(
      claims.data.scope.kind === "workspace"
        ? {
            scopeKind: "workspace",
            workspaceId: claims.data.scope.id,
          }
        : {
            scopeKind: "project",
            projectId: claims.data.scope.id,
          }
    );
  } catch (error) {
    logger.warn(
      { error, issuerId: issuer.id, scope: claims.data.scope },
      "Federated access grant requested an unavailable Pod target"
    );
    return c.json({ error: "Requested Pod access target is unavailable" }, 409);
  }

  const email = claims.data.email.trim().toLowerCase();
  const kratosIdentity = await resolveOrCreateKratosIdentity({
    email,
    name: claims.data.name,
    createdVia: "federated-access-grant",
  });
  if (kratosIdentity.status === "unavailable")
    return c.json({ error: "Pod auth service is unavailable" }, 503);
  if (kratosIdentity.status !== "resolved")
    return c.json({ error: "Could not resolve Pod identity" }, 502);
  try {
    const result =
      claims.data.scope.kind === "workspace"
        ? await activateFederatedMember({
            commandId: claims.data.commandId,
            issuerId: issuer.id,
            issuerSubject: claims.data.sub,
            kratosIdentityId: kratosIdentity.identityId,
            email,
            name: claims.data.name,
            scopeKind: "workspace",
            workspaceId: claims.data.scope.id,
            role: claims.data.role,
          })
        : await activateFederatedMember({
            commandId: claims.data.commandId,
            issuerId: issuer.id,
            issuerSubject: claims.data.sub,
            kratosIdentityId: kratosIdentity.identityId,
            email,
            name: claims.data.name,
            scopeKind: "project",
            projectId: claims.data.scope.id,
            role: claims.data.role,
          });
    return c.json({ success: true, ...result });
  } catch (error) {
    const compensationSucceeded =
      !kratosIdentity.created ||
      (await deleteKratosIdentity(
        process.env.KRATOS_ADMIN_URL || "http://localhost:4434",
        kratosIdentity.identityId
      ));
    logger.warn(
      {
        error,
        issuerId: issuer.id,
        kratosIdentityCreated: kratosIdentity.created,
        compensationSucceeded,
      },
      "Federated access grant rejected"
    );
    if (!compensationSucceeded) {
      return c.json(
        {
          error:
            "Federated access grant failed and the newly-created Pod identity could not be rolled back",
        },
        502
      );
    }
    return c.json(
      {
        error: error instanceof Error ? error.message : "Access grant rejected",
      },
      409
    );
  }
});

/** Issuer assertion → Pod session. This is the canonical federation login path. */
federationRouter.post("/exchange", async (c) => {
  const parsed = assertionEnvelope.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!parsed.success) return c.json({ error: "assertion is required" }, 400);
  const audience = podAudience();
  if (!audience) return c.json({ error: "PUBLIC_URL is required" }, 500);
  const decoded = decodeShortLivedAssertion(parsed.data.assertion);
  if (!decoded) {
    return c.json({ error: "Invalid federated user assertion" }, 401);
  }
  const candidateIssuerUrl =
    typeof decoded.iss === "string" ? canonicalIssuerUrl(decoded.iss) : null;
  const issuer = candidateIssuerUrl
    ? await new TrustedIssuerService().getByUrl(candidateIssuerUrl)
    : null;
  if (!issuer || issuer.status !== "approved") {
    const requestedClient =
      typeof decoded.azp === "string"
        ? normalizeApplicationClientId(decoded.azp)
        : null;
    return c.json(
      {
        error:
          "This Pod needs owner approval before the issuer can be used for sign-in",
        code: requestedClient
          ? "APPLICATION_CONNECTION_APPROVAL_REQUIRED"
          : "ISSUER_APPROVAL_REQUIRED",
        recovery: "direct_pod_sign_in",
      },
      403
    );
  }

  let payload: Assertion;
  try {
    const verifiedPayload = await verifyIssuerJwt<Assertion>(
      parsed.data.assertion,
      issuer.issuerUrl,
      audience,
      { consumeJti: false }
    );
    if (!verifiedPayload) {
      return c.json({ error: "Invalid federated user assertion" }, 401);
    }
    payload = verifiedPayload;
  } catch {
    return c.json({ error: "Invalid federated user assertion" }, 401);
  }
  const claims = exchangeClaimsSchema.safeParse(payload);
  const issuerUrl = claims.success ? canonicalIssuerUrl(claims.data.iss) : null;
  if (!claims.success || !issuerUrl)
    return c.json({ error: "Invalid federated user assertion" }, 401);
  if (issuerUrl !== issuer.issuerUrl)
    return c.json({ error: "Invalid federated user assertion" }, 401);
  const applicationAttempt = isApplicationFederationAttempt(c, claims.data.azp);
  if (
    !applicationAttempt &&
    !issuer.allowedScopes.includes(TRUSTED_ISSUER_CAPABILITIES.USER_EXCHANGE)
  )
    return c.json(
      {
        error:
          "This Pod needs owner approval before the issuer can be used for sign-in",
        code: claims.data.azp
          ? "APPLICATION_CONNECTION_APPROVAL_REQUIRED"
          : "ISSUER_APPROVAL_REQUIRED",
        recovery: "direct_pod_sign_in",
      },
      403
    );
  const exchangeApplicationAdmission =
    await requireRegisteredApplicationConnection({
      c,
      issuerId: issuer.id,
      issuerUrl,
      azp: claims.data.azp,
      capability: TRUSTED_ISSUER_CAPABILITIES.USER_EXCHANGE,
      purpose: "sign-in",
    });
  if (exchangeApplicationAdmission) return exchangeApplicationAdmission;
  const assertionResult = await consumeFederatedAssertion(
    c,
    issuer.id,
    claims.data
  );
  if (assertionResult) return assertionResult;
  const db = await getDb();
  const link = await db.query.federatedIdentityLinks.findFirst({
    where: and(
      eq(federatedIdentityLinks.issuerId, issuer.id),
      eq(federatedIdentityLinks.issuerSubject, claims.data.sub)
    ),
    columns: { userId: true },
  });
  if (!link)
    return c.json(
      { error: "Federated identity is not linked on this Pod" },
      403
    );
  const user = await db.query.users.findFirst({
    where: eq(users.id, link.userId),
    columns: { id: true, kratosIdentityId: true },
  });
  if (!user?.kratosIdentityId)
    return c.json({ error: "Pod identity is unavailable" }, 403);
  const access = await accessForUser(user.id);
  if (!canUseScope(access, claims.data.requestedScope)) {
    return c.json(
      {
        error: "Federated user has no active access to the requested Pod scope",
      },
      403
    );
  }
  const session = await mintKratosSession(user.kratosIdentityId);
  if (!session) return c.json({ error: "Could not create Pod session" }, 503);
  setSessionCookie(c, session.sessionToken);
  return c.json({
    success: true,
    session_token: session.sessionToken,
    session: session.session,
    activeWorkspaceId:
      claims.data.requestedScope?.kind === "workspace"
        ? claims.data.requestedScope.id
        : undefined,
    activeProjectId:
      claims.data.requestedScope?.kind === "project"
        ? claims.data.requestedScope.id
        : undefined,
  });
});

/**
 * Install-time creation of the first local Pod owner.
 *
 * The header is a Pod-local deployment secret. The assertion is an ordinary
 * issuer assertion: it identifies a subject and intended Pod audience, but it
 * carries no product-specific account, Pod, or relationship data.
 */
federationRouter.post("/bootstrap", async (c) => {
  if (!hasValidBootstrapToken(c.req.header("X-Pod-Bootstrap-Token"))) {
    return c.json({ error: "Invalid Pod bootstrap token" }, 401);
  }

  const parsed = assertionEnvelope.safeParse(
    await c.req.json().catch(() => null)
  );
  if (!parsed.success) return c.json({ error: "assertion is required" }, 400);
  const audience = podAudience();
  if (!audience) return c.json({ error: "PUBLIC_URL is required" }, 500);

  const decoded = decodeShortLivedAssertion(parsed.data.assertion);
  const issuerUrl =
    decoded && typeof decoded.iss === "string"
      ? canonicalIssuerUrl(decoded.iss)
      : null;
  if (!issuerUrl) {
    return c.json({ error: "Invalid initial owner assertion" }, 401);
  }

  // The provisioning secret authorizes this one bootstrap operation. The
  // issuer assertion remains cryptographically verified and audience-bound.
  const payload = await verifyIssuerJwt<Assertion>(
    parsed.data.assertion,
    issuerUrl,
    audience,
    { consumeJti: false }
  );
  const claims = bootstrapClaimsSchema.safeParse(payload);
  if (!claims.success || canonicalIssuerUrl(claims.data.iss) !== issuerUrl) {
    return c.json({ error: "Invalid initial owner assertion" }, 401);
  }

  const issuerService = new TrustedIssuerService();
  let issuer = await issuerService.getByUrl(issuerUrl);
  if (await hasDifferentHumanPodOwner(issuer?.id, claims.data.sub)) {
    return c.json(
      { error: "This Pod already has a different human owner" },
      409
    );
  }
  if (issuer && issuer.status !== "approved" && issuer.status !== "pending") {
    return c.json({ error: "This issuer cannot bootstrap a Pod owner" }, 409);
  }
  if (!issuer) {
    issuer = await issuerService.registerPending(
      issuerUrl,
      new URL(issuerUrl).hostname,
      {
        requestedVia: "initial-owner-bootstrap",
        commandId: claims.data.commandId,
      }
    );
  }
  if (issuer.status !== "approved" && issuer.status !== "pending") {
    return c.json({ error: "This issuer cannot bootstrap a Pod owner" }, 409);
  }

  // A first-time bootstrap has to create the Pod-local pending issuer in order
  // to obtain its durable issuer ID. All identity, owner, and capability side
  // effects occur only after the assertion receipt below succeeds.
  const assertionResult = await consumeFederatedAssertion(
    c,
    issuer.id,
    claims.data
  );
  if (assertionResult) return assertionResult;

  const email = claims.data.email.trim().toLowerCase();
  const kratosIdentity = await resolveOrCreateKratosIdentity({
    email,
    name: claims.data.name,
    createdVia: "federated-initial-owner-bootstrap",
  });
  if (kratosIdentity.status === "unavailable") {
    return c.json({ error: "Pod auth service is unavailable" }, 503);
  }
  if (kratosIdentity.status !== "resolved") {
    return c.json({ error: "Could not create Pod identity" }, 502);
  }

  let seeded: Awaited<ReturnType<typeof seedAdminUser>>;
  try {
    seeded = await seedAdminUser({
      kratosIdentityId: kratosIdentity.identityId,
      email,
      name: claims.data.name,
      federatedIdentity: {
        issuerId: issuer.id,
        issuerSubject: claims.data.sub,
      },
      requireUnclaimedPodOwner: true,
    });
  } catch (error) {
    const compensationSucceeded =
      !kratosIdentity.created ||
      (await deleteKratosIdentity(
        process.env.KRATOS_ADMIN_URL || "http://localhost:4434",
        kratosIdentity.identityId
      ));
    logger.warn(
      {
        error,
        issuerId: issuer.id,
        kratosIdentityCreated: kratosIdentity.created,
        compensationSucceeded,
      },
      "Initial federated Pod owner bootstrap failed"
    );
    if (!compensationSucceeded) {
      return c.json(
        {
          error:
            "Initial owner bootstrap failed and the newly-created Pod identity could not be rolled back",
        },
        502
      );
    }
    if (error instanceof PodOwnerAlreadyClaimedError) {
      return c.json(
        { error: "This Pod already has a different human owner" },
        409
      );
    }
    return c.json({ error: "Could not bootstrap Pod owner" }, 409);
  }

  const requiredCapabilities = [...bootstrapIssuerCapabilities];
  if (issuer.status === "pending") {
    issuer =
      (await issuerService.approvePending(issuer.id, seeded.userId, [
        ...bootstrapIssuerCapabilities,
      ])) ?? (await issuerService.getByUrl(issuerUrl));
  }
  const approvedIssuer = issuer?.status === "approved" ? issuer : null;
  if (
    approvedIssuer &&
    !requiredCapabilities.every((capability) =>
      approvedIssuer.allowedScopes.includes(capability)
    )
  ) {
    issuer = await issuerService.approve(approvedIssuer.id, seeded.userId, [
      ...new Set([
        ...approvedIssuer.allowedScopes,
        ...bootstrapIssuerCapabilities,
      ]),
    ]);
  }
  if (
    !issuer ||
    issuer.status !== "approved" ||
    !requiredCapabilities.every((capability) =>
      issuer.allowedScopes.includes(capability)
    )
  ) {
    return c.json({ error: "Could not approve bootstrap issuer" }, 409);
  }

  const access = await accessForUser(seeded.userId);
  return c.json({
    success: true,
    userId: seeded.userId,
    workspaceId: seeded.workspaceId,
    access,
  });
});
