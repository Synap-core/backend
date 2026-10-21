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

import {
  db,
  eq,
  getActingAgentUserId,
  getRequestGrant,
  users,
} from "@synap/database";

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
import { normalizeRequestedScopes, resolveIssuer } from "./config.js";
import {
  ClientMetadataError,
  isClientMetadataUrl,
  resolveCimdClient,
} from "./client-metadata.js";
import {
  findClient,
  issueAuthorizationCode,
  type AppGrantRequest,
  type StoredClient,
} from "./store.js";
import {
  APP_CANNOT_SIGN_IN,
  APP_PERSON_SCOPES,
  appGrantFingerprint,
  appNotForYou,
  appSignInReach,
  describeAppSignIn,
  isAppClientId,
  loadLiveApp,
  resolveAppClient,
  type AppSignInDescription,
} from "./app-client.js";

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
  if (isAppClientId(clientId)) {
    // "Sign in with Synap": an app registered AND approved on this pod,
    // resolved from `apps` — never from `oauth_clients`, which DCR writes.
    client = await resolveAppClient(clientId);
    if (!client) throw new AuthorizeUserError(APP_CANNOT_SIGN_IN);
  } else if (isClientMetadataUrl(clientId)) {
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
  // A sign-in app (`app`) always gets the Hub door's two scopes: what its
  // token may touch is the GRANT, decided at consent, not a scope string.
  const grantedScopes =
    client.clientKind === "app"
      ? [...APP_PERSON_SCOPES]
      : client.clientKind === "cimd"
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
 * STRICT for an app (CIMD, or a sign-in `app`) client: anything but this
 * pod's `/mcp` or `/api/hub` is `invalid_target`.
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
    if (err instanceof OAuthError && client.clientKind === "dcr") {
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

export interface OAuthConsentContext {
  clientId: string;
  /** Untrusted, attacker-chosen at registration — the UI renders it as TEXT. */
  clientName: string;
  redirectUri: string;
  /** Where the code will actually be delivered — shown so the human can judge. */
  redirectHost: string;
  scopes: string[];
  /** When the client registered itself with this pod (DCR) — a fresh one is worth a second look. */
  registeredAt: Date;
  /**
   * "Sign in with Synap" (an `app_…` client): what the app will do AS the
   * viewer, derived from the grant they would receive. null for every other
   * client (an MCP agent connection).
   */
  appSignIn: AppSignInDescription | null;
}

/**
 * The grant a person would receive signing in to an app, and who registered
 * it — through THE reach rule (`appSignInReach`: who may, and what). A
 * refusal is an `AuthorizeUserError`: shown to the person, never redirected.
 */
async function appSignInFor(
  client: StoredClient,
  viewerUserId: string
): Promise<{ grant: AppGrantRequest[]; registeredBy: string }> {
  const app = await loadLiveApp(client.clientId);
  if (!app) throw new AuthorizeUserError(APP_CANNOT_SIGN_IN);
  const reach = await appSignInReach(app, viewerUserId);
  if (reach === "not_for_you") {
    throw new AuthorizeUserError(appNotForYou(client.clientName));
  }
  if (reach.length === 0) {
    throw new AuthorizeUserError(
      `You are not in any space ${client.clientName} was approved for, so it cannot act as you here.`
    );
  }
  const owner = await db.query.users.findFirst({
    where: eq(users.id, app.ownerUserId),
    columns: { name: true, email: true },
  });
  return {
    grant: reach,
    registeredBy: owner?.name || owner?.email || "a member of this pod",
  };
}

/**
 * What the consent screen renders. Re-derives everything from the stored client
 * so the screen can never show a name or scope set the pod would not honor.
 */
export async function getOAuthConsentContext(
  params: AuthorizeParams,
  viewerUserId: string
): Promise<OAuthConsentContext> {
  const req = await resolveAuthorizeRequest(params);
  const signIn =
    req.client.clientKind === "app"
      ? await appSignInFor(req.client, viewerUserId)
      : null;
  const appSignIn = signIn
    ? await describeAppSignIn(
        req.client.clientName,
        signIn.registeredBy,
        signIn.grant
      )
    : null;
  return {
    clientId: req.client.clientId,
    clientName: req.client.clientName,
    redirectUri: req.redirectUri,
    redirectHost: new URL(req.redirectUri).host,
    scopes: req.grantedScopes,
    registeredAt: req.client.createdAt,
    appSignIn,
  };
}

export interface OAuthDecisionInput extends AuthorizeParams {
  approve: boolean;
  /** App sign-in only: `appSignIn.fingerprint` of the screen the person saw. */
  appSignInFingerprint?: string | null;
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
  callerUserId: string
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

  // Consent is a person's own act in their own browser session. A request
  // carrying a key's grant or an acting agent (any key door) never decides
  // it — otherwise an agent key, remapped to the human it acts for, could
  // mint a sign-in as that human (threat T4, app-person-token.ts).
  if (getActingAgentUserId() || getRequestGrant()) {
    throw new AuthorizeUserError(
      "Only a person signed in to this pod can authorize a connection."
    );
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

  // An app sign-in records EXACTLY what this person was shown (the same
  // derivation the consent screen rendered); /token never mints wider.
  const appGrant =
    req.client.clientKind === "app"
      ? (await appSignInFor(req.client, caller.id)).grant
      : null;
  if (
    appGrant &&
    input.appSignInFingerprint !== appGrantFingerprint(appGrant)
  ) {
    throw new AuthorizeUserError(
      `What ${req.client.clientName} may do changed since this page was shown — review it again.`
    );
  }

  const code = await issueAuthorizationCode({
    clientId: req.client.clientId,
    userId: caller.id,
    redirectUri: req.redirectUri,
    scopes: req.grantedScopes,
    codeChallenge: req.codeChallenge,
    resource: req.resource,
    appGrant,
  });

  return {
    redirectTo: buildAuthorizationResponseUrl(req.redirectUri, issuer, {
      code,
      state: req.state || null,
    }),
  };
}
