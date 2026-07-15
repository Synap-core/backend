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
  eq,
  getDb,
  projectPodUserAccess,
  PodOwnerAlreadyClaimedError,
  seedAdminUser,
  type PodUserAccess,
  TrustedIssuerService,
  TRUSTED_ISSUER_CAPABILITIES,
} from "@synap/database";
import {
  federatedIdentityLinks,
  projectMembers,
  projects,
  users,
  workspaceMembers,
  workspaces,
} from "@synap/database/schema";
import {
  normalizeIssuerUrl,
  verifyIssuerJwt,
  verifyTrustedIssuerJwt,
} from "@synap/api";

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
});
const receiptClaimsSchema = z.object({
  ...shortLivedAssertionClaims,
  iss: z.string().url(),
  sub: z.string().min(1).max(512),
  type: z.literal("federated_assertion"),
  purpose: z.literal("identity-link-receipt"),
  intentId: z.string().min(1).max(512),
  nonce: z.string().min(16).max(1024),
});
const exchangeClaimsSchema = z.object({
  ...shortLivedAssertionClaims,
  iss: z.string().url(),
  sub: z.string().min(1).max(512),
  type: z.literal("federated_assertion"),
  purpose: z.literal("user-exchange"),
  requestedScope: requestedScopeSchema.optional(),
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
  claims: { jti: string; exp: number }
): Promise<Response | null> {
  try {
    const result = await consumeFederatedAssertionReceipt({
      issuerId,
      jti: claims.jti,
      expiresAt: new Date(claims.exp * 1_000),
    });
    if (result === "consumed") return null;
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
  const access = await accessForUser(userId);
  const isOwner = access.podRole === "owner" || access.podRole === "admin";
  const issuerService = new TrustedIssuerService();
  let issuer = await issuerService.getByUrl(issuerUrl);
  let pendingOwnerApproval = false;
  if (!hasIssuerCapability(issuer, TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK)) {
    if (!isOwner || (issuer && issuer.status !== "pending")) {
      return c.json(
        {
          error:
            "A Pod owner must approve this issuer before it can link users",
        },
        403
      );
    }
    issuer =
      issuer ??
      (await issuerService.registerPending(
        issuerUrl,
        new URL(issuerUrl).hostname,
        {
          requestedVia: "local-pod-session",
        }
      ));
    pendingOwnerApproval = issuer.status === "pending";
    if (
      !pendingOwnerApproval &&
      !hasIssuerCapability(issuer, TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK)
    ) {
      return c.json(
        { error: "This issuer is not approved to link Pod identities" },
        403
      );
    }
  }
  if (!issuer) {
    return c.json(
      { error: "This issuer is not approved to link Pod identities" },
      403
    );
  }

  // A regular member reaches this network call only for an issuer already
  // approved by the Pod. A new issuer is fetched only after a current Pod
  // owner has explicitly started the local approval flow above.
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

  if (pendingOwnerApproval) {
    const refreshedAccess = await accessForUser(userId);
    const isStillOwner =
      refreshedAccess.podRole === "owner" ||
      refreshedAccess.podRole === "admin";
    if (!isStillOwner) {
      return c.json(
        {
          error:
            "A Pod owner must approve this issuer before it can link users",
        },
        403
      );
    }
    issuer =
      (await issuerService.approvePending(issuer.id, userId, [
        TRUSTED_ISSUER_CAPABILITIES.USER_EXCHANGE,
        TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK,
      ])) ?? (await issuerService.getByUrl(issuerUrl));
  } else {
    issuer = await issuerService.getByUrl(issuerUrl);
  }
  if (
    !issuer ||
    !hasIssuerCapability(issuer, TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK)
  ) {
    return c.json(
      { error: "This issuer is not approved to link Pod identities" },
      403
    );
  }
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
  const payload = await verifyTrustedIssuerJwt<Assertion>(body.data.assertion, {
    audience,
    requiredScope: TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK,
    consumeJti: false,
  });
  const claims = receiptClaimsSchema.safeParse(payload);
  const issuerUrl = claims.success ? canonicalIssuerUrl(claims.data.iss) : null;
  if (!claims.success || !issuerUrl)
    return c.json({ error: "Invalid identity-link receipt assertion" }, 401);
  const issuer = await new TrustedIssuerService().getByUrl(issuerUrl);
  if (
    !issuer ||
    issuer.status !== "approved" ||
    !issuer.allowedScopes.includes(TRUSTED_ISSUER_CAPABILITIES.IDENTITY_LINK)
  ) {
    return c.json({ error: "Issuer is not approved" }, 401);
  }
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
  if (!decodeShortLivedAssertion(parsed.data.assertion)) {
    return c.json({ error: "Invalid federated user assertion" }, 401);
  }
  const payload = await verifyTrustedIssuerJwt<Assertion>(
    parsed.data.assertion,
    {
      audience,
      requiredScope: TRUSTED_ISSUER_CAPABILITIES.USER_EXCHANGE,
      consumeJti: false,
    }
  );
  const claims = exchangeClaimsSchema.safeParse(payload);
  const issuerUrl = claims.success ? canonicalIssuerUrl(claims.data.iss) : null;
  if (!claims.success || !issuerUrl)
    return c.json({ error: "Invalid federated user assertion" }, 401);
  const issuer = await new TrustedIssuerService().getByUrl(issuerUrl);
  if (
    !issuer ||
    issuer.status !== "approved" ||
    !issuer.allowedScopes.includes(TRUSTED_ISSUER_CAPABILITIES.USER_EXCHANGE)
  )
    return c.json({ error: "Issuer is not approved" }, 401);
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
