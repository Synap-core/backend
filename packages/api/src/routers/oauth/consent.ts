/**
 * The INTERACTIVE half of the pod's authorization server.
 *
 * `/authorize` (routes.ts) cannot itself authenticate the human: the pod API and
 * pod-admin are deliberately different origins (see `publicPodUrl` in
 * pod-admin/lib), and the Kratos session lives on the browser, not on the
 * server-to-server hop claude.ai makes. So /authorize validates the request and
 * bounces the browser to pod-admin's consent screen, which is session-gated;
 * this module is what that screen calls back into (over tRPC, cookie-authed).
 *
 * SECURITY — why every parameter is re-validated here rather than trusted from
 * the round-trip: the consent screen receives the authorize parameters as plain
 * query string, so a user (or anything that can rewrite that URL) can change
 * them between the /authorize redirect and the Allow click. Re-resolving the
 * client and re-checking the redirect_uri against its registered allowlist means
 * a tampered round-trip can only ever produce an authorization the pod would
 * have granted from a fresh /authorize anyway — and one whose real client name,
 * real redirect host and real scopes were on screen when the human approved.
 * There is no signed request token to forge because nothing is trusted.
 */

import { db, eq, users } from "@synap/database";
import type { AppApprovedRequest } from "@synap/database/schema";

import {
  connectOAuthApp,
  currentOAuthApproval,
  oauthAppOffer,
  type OAuthAppOfferItem,
} from "../../services/app-connect.js";
import { podAppMayConnect } from "../../services/pod-app-policy.js";
import type { Context } from "../../types/context.js";

import {
  OAuthError,
  assertPkceChallenge,
  buildAuthorizationResponseUrl,
  isRegisteredRedirectUri,
  narrowAppScopes,
  narrowScopes,
  parseScopeParam,
  resourceForIssuer,
} from "./protocol.js";
import {
  isSynapApp,
  normalizeRequestedScopes,
  resolveIssuer,
} from "./config.js";
import {
  ClientMetadataError,
  isClientMetadataUrl,
  resolveCimdClient,
} from "./client-metadata.js";
import {
  findClient,
  issueAuthorizationCode,
  type StoredClient,
} from "./store.js";

/**
 * An error that must be shown to the USER rather than redirected to the client.
 *
 * RFC 6749 §4.1.2.1: when client_id or redirect_uri is invalid, the AS MUST NOT
 * redirect — a redirect at that point would be to an unvalidated URI, which is
 * exactly the open-redirect/code-leak hole the rule exists to close.
 */
export class AuthorizeUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizeUserError";
  }
}

export interface AuthorizeParams {
  clientId?: string | null;
  redirectUri?: string | null;
  responseType?: string | null;
  scope?: string | null;
  state?: string | null;
  codeChallenge?: string | null;
  codeChallengeMethod?: string | null;
  /** RFC 8707. One value; /authorize refuses a repeated parameter itself. */
  resource?: string | null;
}

/** An authorize request that passed BOTH validation phases. */
export interface ValidatedAuthorizeRequest {
  client: StoredClient;
  redirectUri: string;
  grantedScopes: string[];
  codeChallenge: string;
  state: string | null;
  /** Canonical RFC 8707 resource, or null when the client named none. */
  resource: string | null;
  /**
   * A DCR client's `resource` that names no resource of this pod, dropped
   * (see `resourceFor`). Set only so /authorize can log it once.
   */
  ignoredResource: string | null;
}

/**
 * The pod's canonical issuer, which every authorization response carries as
 * `iss` (RFC 9207). An AS that cannot name itself answers nothing.
 */
function requireIssuer(): string {
  const issuer = resolveIssuer();
  if (!issuer) {
    throw new AuthorizeUserError(
      "This pod is not configured with a canonical PUBLIC_URL"
    );
  }
  return issuer;
}

/**
 * PHASE 1 — resolve the client and its redirect_uri. Failures here throw
 * `AuthorizeUserError` because there is no verified URI to redirect to yet.
 *
 * An absent redirect_uri is NOT defaulted to the client's single registered
 * entry: this AS only ever deals with clients that send one explicitly, and
 * defaulting is how an AS ends up round-tripping a URI the client never asked
 * for.
 */
export async function resolveClientAndRedirect(
  params: AuthorizeParams
): Promise<{ client: StoredClient; redirectUri: string }> {
  const clientId = params.clientId?.trim();
  if (!clientId) {
    throw new AuthorizeUserError("client_id is required");
  }
  // A pod app names its metadata document; an MCP client its DCR row. The
  // document is fetched (or read from cache) here, before the redirect_uri is
  // trusted, because the document IS the list of redirect_uris.
  let client: StoredClient | null;
  if (isClientMetadataUrl(clientId)) {
    // The pod admin's switch (F4), checked before the document is fetched: a
    // pod that admits no unverified app fetches nothing for one. Phase 1, so
    // /authorize and the consent screen both show it to the person.
    if (!(await podAppMayConnect(clientId))) {
      throw new AuthorizeUserError(
        `This pod's admin has turned off apps that are not Synap apps, so ${new URL(clientId).host} cannot connect. Ask your pod admin to allow unverified apps.`
      );
    }
    try {
      client = await resolveCimdClient(clientId, resolveIssuer());
    } catch (err) {
      if (err instanceof ClientMetadataError) {
        throw new AuthorizeUserError(
          `This app's description could not be read: ${err.message}`
        );
      }
      throw err;
    }
  } else {
    client = await findClient(clientId);
    // A DCR-shaped id must never resolve to a cached document's row.
    if (client && client.clientKind === "cimd") client = null;
  }
  if (!client) {
    // Same message for malformed and unknown — never confirm which client_ids
    // exist on this pod.
    throw new AuthorizeUserError("Unknown client_id");
  }

  const redirectUri = params.redirectUri?.trim();
  if (!redirectUri) {
    throw new AuthorizeUserError("redirect_uri is required");
  }
  if (!isRegisteredRedirectUri(client.redirectUris, redirectUri)) {
    throw new AuthorizeUserError(
      "redirect_uri does not match a registered redirect URI for this client"
    );
  }

  return { client, redirectUri };
}

/**
 * PHASE 2 — validate the rest of the request. Failures here throw `OAuthError`
 * and the caller redirects them back to the (now verified) redirect_uri, per
 * RFC 6749 §4.1.2.1.
 */
export function validateAuthorizeRequest(
  client: StoredClient,
  redirectUri: string,
  params: AuthorizeParams
): ValidatedAuthorizeRequest {
  if (params.responseType !== "code") {
    throw new OAuthError(
      "unsupported_response_type",
      'response_type must be "code"'
    );
  }

  const codeChallenge = assertPkceChallenge(
    params.codeChallenge ?? undefined,
    params.codeChallengeMethod ?? undefined
  );

  const requested = normalizeRequestedScopes(parseScopeParam(params.scope));
  // An app (CIMD) gets only what it asked for AND declared — an empty
  // intersection is `invalid_scope`. An MCP (DCR) client keeps today's
  // drop-unknown + fall-back-to-registered rule, which claude.ai relies on.
  const grantedScopes =
    client.clientKind === "cimd"
      ? narrowAppScopes(
          [...client.scopes, ...client.requestedPermissions],
          requested
        )
      : narrowScopes(client.scopes, requested);

  const { resource, ignoredResource } = resourceFor(
    client,
    params.resource,
    requireIssuer()
  );

  return {
    client,
    redirectUri,
    grantedScopes,
    codeChallenge,
    // `state` is opaque and echoed verbatim on every response back to the
    // client — it is the client's CSRF token, not ours to interpret.
    state: params.state ?? null,
    resource,
    ignoredResource,
  };
}

/**
 * RFC 8707 `resource`, by client kind.
 *
 * STRICT for an app (CIMD) client: anything but this pod's `/mcp` or
 * `/api/hub` is `invalid_target`.
 *
 * LENIENT for a DCR client (claude.ai, the Control Plane connector) until
 * claude.ai's real value has been observed in the logs (/authorize warns with
 * it): an unrecognised value is treated as ABSENT — not refused, not bound to
 * the code, so /token does not check it. Refusing it would break live MCP
 * logins over a value nobody has seen yet. Tighten later. A RECOGNISED value is
 * bound and re-checked for both kinds.
 */
export function resourceFor(
  client: Pick<StoredClient, "clientKind">,
  raw: string | null | undefined,
  issuer: string
): { resource: string | null; ignoredResource: string | null } {
  try {
    return { resource: resourceForIssuer(raw, issuer), ignoredResource: null };
  } catch (err) {
    if (err instanceof OAuthError && client.clientKind !== "cimd") {
      return { resource: null, ignoredResource: raw ?? "" };
    }
    throw err;
  }
}

/** Both phases, in order. Used by the consent surface (which needs both). */
export async function resolveAuthorizeRequest(
  params: AuthorizeParams
): Promise<ValidatedAuthorizeRequest> {
  const { client, redirectUri } = await resolveClientAndRedirect(params);
  return validateAuthorizeRequest(client, redirectUri, params);
}

// ─── Consent surface (tRPC-facing) ───────────────────────────────────────────

/**
 * What a POD APP (CIMD client) is shown as on the consent screen (spec 17
 * §9.1). Its identity is its DOMAIN (the client_id host), not its name.
 */
export interface OAuthAppConsent {
  /** The client_id host — the headline. */
  domain: string;
  /** "Synap app" (exact first-party origin, `isSynapApp`) vs "Unverified app". */
  verified: boolean;
  /** The document's `client_uri` (same origin as the client_id), or null. */
  homepage: string | null;
  /**
   * Each permission the app asked for AND declared, with the spaces this
   * person may give it in (`oauthAppOffer`). An empty list means the person
   * has no space to give that permission in.
   */
  permissions: OAuthAppOfferItem[];
  /** What this person approved for this app before (re-consent pre-ticks it). */
  approved: AppApprovedRequest[];
  /**
   * Workspace templates the app declared (`synap_templates`): the screen
   * offers to create a space from one when a permission has no space.
   */
  templates: string[];
  /** Scopes it asked for that a pod app is never given (`mcp.*`), shown as dropped. */
  ignoredScopes: string[];
}

export interface OAuthConsentContext {
  clientId: string;
  /** 'dcr' — an MCP client (claude.ai); 'cimd' — a pod app. */
  clientKind: "dcr" | "cimd";
  /** Untrusted, attacker-chosen at registration — the UI renders it as TEXT. */
  clientName: string;
  redirectUri: string;
  /** Where the code will actually be delivered — shown so the human can judge. */
  redirectHost: string;
  scopes: string[];
  /** When the client registered itself with this pod (DCR) — a fresh one is worth a second look. */
  registeredAt: Date;
  /** Present for a pod app only. */
  app: OAuthAppConsent | null;
}

/**
 * The permissions a pod app may be given from this request: what it asked for
 * (narrowed to what it declared at /authorize) that is a grant-grammar
 * permission. An `mcp.*` scope is never given to a pod app (spec 17 §6.6: its
 * key carries no `mcp.*` in v1), so it is dropped here.
 */
function appPermissions(req: ValidatedAuthorizeRequest): {
  permissions: string[];
  ignoredScopes: string[];
} {
  const declared = new Set(req.client.requestedPermissions);
  return {
    permissions: req.grantedScopes.filter((s) => declared.has(s)),
    ignoredScopes: req.grantedScopes.filter((s) => !declared.has(s)),
  };
}

/**
 * What the consent screen renders. Re-derives everything from the stored client
 * so the screen can never show a name or scope set the pod would not honor.
 * For a pod app it also derives, for THIS person, the spaces each permission
 * may be given in.
 */
export async function getOAuthConsentContext(
  params: AuthorizeParams,
  /** The person deciding. Required for a pod app (its offer is per person). */
  callerUserId?: string
): Promise<OAuthConsentContext> {
  const req = await resolveAuthorizeRequest(params);
  const base = {
    clientId: req.client.clientId,
    clientKind: req.client.clientKind,
    clientName: req.client.clientName,
    redirectUri: req.redirectUri,
    redirectHost: new URL(req.redirectUri).host,
    scopes: req.grantedScopes,
    registeredAt: req.client.createdAt,
  };
  if (req.client.clientKind !== "cimd") return { ...base, app: null };
  if (!callerUserId) {
    throw new Error("getOAuthConsentContext: a pod app needs the caller");
  }

  const { permissions, ignoredScopes } = appPermissions(req);
  return {
    ...base,
    app: {
      domain: new URL(req.client.clientId).host,
      verified: isSynapApp(req.client.clientId),
      homepage: req.client.clientUri ?? null,
      permissions: await oauthAppOffer(callerUserId, permissions),
      approved: await currentOAuthApproval(callerUserId, req.client.clientId),
      templates: req.client.requestedTemplates ?? [],
      ignoredScopes,
    },
  };
}

export interface OAuthDecisionInput extends AuthorizeParams {
  approve: boolean;
  /**
   * A pod app only: the (permission, space) pairs the person left ticked.
   * Untrusted — `connectOAuthApp` refuses anything beyond the pod's offer.
   */
  approved?: AppApprovedRequest[];
}

/**
 * Record the human's decision and return the URL to send the browser to.
 *
 * On approve this is the ONLY place an authorization code is minted, and the
 * code carries `userId` = the consenting human. That field is load-bearing far
 * downstream: /token copies it to the minted key's `linkedUserId`, and
 * `http-handler.ts` derives `agentUserId` from `linkedUserId` — a defined
 * `agentUserId` is the only thing that routes Claude's writes through
 * `checkPermissionOrPropose()` into a proposal instead of auto-applying them as
 * the operator. An agent user must therefore never be able to author its own
 * consent, which is what the `userType === "human"` check below enforces.
 */
export async function decideOAuthAuthorization(
  input: OAuthDecisionInput,
  callerUserId: string,
  /**
   * The caller's request context. Required for a pod app: its consent is an
   * approval, and the approve door's agent floor reads it.
   */
  ctx?: Context
): Promise<{ redirectTo: string }> {
  const req = await resolveAuthorizeRequest(input);
  const issuer = requireIssuer();

  if (!input.approve) {
    return {
      redirectTo: buildAuthorizationResponseUrl(req.redirectUri, issuer, {
        error: "access_denied",
        error_description: "The pod owner denied this authorization request",
        state: req.state || null,
      }),
    };
  }

  const caller = await db.query.users.findFirst({
    where: eq(users.id, callerUserId),
    columns: { id: true, userType: true },
  });
  if (!caller || caller.userType !== "human") {
    throw new AuthorizeUserError(
      "Only a human pod user can authorize an MCP connection."
    );
  }

  // A pod app: the consent files AND approves its `app/connect` request (F9)
  // before any code exists; the code then redeems to THAT approved app.
  let appId: string | null = null;
  let scopes = req.grantedScopes;
  if (req.client.clientKind === "cimd") {
    if (!ctx) {
      throw new Error(
        "decideOAuthAuthorization: a pod app needs the caller's context"
      );
    }
    const { permissions } = appPermissions(req);
    if (permissions.length === 0) {
      throw new AuthorizeUserError(
        "This app asks for nothing a pod app can be given (it declared no permission it requested)."
      );
    }
    const connected = await connectOAuthApp({
      ownerUserId: caller.id,
      oauthClientId: req.client.clientId,
      name: `${req.client.clientName} (${new URL(req.client.clientId).host})`,
      permissions,
      approved: input.approved ?? [],
      ctx,
    });
    appId = connected.appId;
    scopes = [...new Set((input.approved ?? []).map((r) => r.permission))];
  }

  const code = await issueAuthorizationCode({
    clientId: req.client.clientId,
    userId: caller.id,
    redirectUri: req.redirectUri,
    scopes,
    codeChallenge: req.codeChallenge,
    resource: req.resource,
    appId,
  });

  return {
    redirectTo: buildAuthorizationResponseUrl(req.redirectUri, issuer, {
      code,
      state: req.state || null,
    }),
  };
}
