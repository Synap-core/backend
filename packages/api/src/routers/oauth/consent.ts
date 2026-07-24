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

import {
  OAuthError,
  assertPkceChallenge,
  isRegisteredRedirectUri,
  narrowScopes,
  parseScopeParam,
} from "./protocol.js";
import { normalizeRequestedScopes } from "./config.js";
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
}

/** An authorize request that passed BOTH validation phases. */
export interface ValidatedAuthorizeRequest {
  client: StoredClient;
  redirectUri: string;
  grantedScopes: string[];
  codeChallenge: string;
  state: string | null;
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
  const client = await findClient(clientId);
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

  const grantedScopes = narrowScopes(
    client.scopes,
    normalizeRequestedScopes(parseScopeParam(params.scope))
  );

  return {
    client,
    redirectUri,
    grantedScopes,
    codeChallenge,
    // `state` is opaque and echoed verbatim on every response back to the
    // client — it is the client's CSRF token, not ours to interpret.
    state: params.state ?? null,
  };
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
}

/**
 * What the consent screen renders. Re-derives everything from the stored client
 * so the screen can never show a name or scope set the pod would not honor.
 */
export async function getOAuthConsentContext(
  params: AuthorizeParams
): Promise<OAuthConsentContext> {
  const req = await resolveAuthorizeRequest(params);
  return {
    clientId: req.client.clientId,
    clientName: req.client.clientName,
    redirectUri: req.redirectUri,
    redirectHost: new URL(req.redirectUri).host,
    scopes: req.grantedScopes,
  };
}

export interface OAuthDecisionInput extends AuthorizeParams {
  approve: boolean;
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
  const target = new URL(req.redirectUri);

  if (!input.approve) {
    target.searchParams.set("error", "access_denied");
    target.searchParams.set(
      "error_description",
      "The pod owner denied this authorization request"
    );
    if (req.state) target.searchParams.set("state", req.state);
    return { redirectTo: target.toString() };
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

  const code = await issueAuthorizationCode({
    clientId: req.client.clientId,
    userId: caller.id,
    redirectUri: req.redirectUri,
    scopes: req.grantedScopes,
    codeChallenge: req.codeChallenge,
  });

  target.searchParams.set("code", code);
  if (req.state) target.searchParams.set("state", req.state);
  return { redirectTo: target.toString() };
}
