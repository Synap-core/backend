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
 * Nothing in the round-trip is trusted, with ONE signed exception: `auth_req`,
 * the time /authorize received a request asking for a fresh sign-in
 * (`signAuthRequestTime`, HMAC'd) — forged or missing, it only asks the person
 * to sign in again.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  db,
  eq,
  getActingAgentUserId,
  getRequestGrant,
  users,
} from "@synap/database";
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
  STEP_UP_WINDOW_MS,
  isDeviceSession,
} from "../../utils/device-session.js";

import {
  OAuthError,
  assertPkceChallenge,
  buildAuthorizationResponseUrl,
  clientAcceptsRedirect,
  firstPartyResourceForIssuer,
  narrowAppScopes,
  narrowScopes,
  parseScopeParam,
  resourceForIssuer,
} from "./protocol.js";
import {
  isFirstPartyClientId,
  isSynapApp,
  normalizeRequestedScopes,
  resolveFirstPartyClient,
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
  /**
   * OIDC `max_age` (seconds): the person must have REALLY authenticated
   * within it, else they sign in again first (`reauthenticationRequired`).
   */
  maxAge?: number | string | null;
  /** OIDC `prompt`; `login` forces a fresh sign-in (a step-up). */
  prompt?: string | null;
  /**
   * When /authorize received this request, signed (`signAuthRequestTime`):
   * what a third-party `prompt=login` / `max_age=0` is measured against.
   */
  authRequest?: string | null;
}

/**
 * The consenting person's sign-in is too old for this request (`max_age` /
 * `prompt=login`): the consent screen sends them to sign in again
 * (`reasonCode: LOGIN_REQUIRED`), then asks again.
 */
export class ReauthenticationRequiredError extends AuthorizeUserError {
  readonly reasonCode = "LOGIN_REQUIRED";
  constructor() {
    super("Sign in again to confirm it's you, then continue.");
    this.name = "ReauthenticationRequiredError";
  }
}

/** A Kratos session's `authenticated_at`, or null when absent/unreadable. */
export function sessionAuthenticatedAt(
  session: { authenticated_at?: string | null } | null | undefined
): Date | null {
  const raw = session?.authenticated_at;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * A Synap app asking the person to CONFIRM it's them for a device it already
 * holds (a step-up: `prompt=login`). The screen says "Confirm it's you", and
 * the code it issues is a STEP-UP code: /token takes it only with that
 * device's refresh token, never to make a new device — so the words shown
 * and the effect cannot disagree.
 */
export function isDeviceReconfirm(
  clientKind: string,
  prompt: string | null | undefined
): boolean {
  return clientKind === "first_party" && prompt === "login";
}

/**
 * When the authorize request was made, signed by this pod: `/authorize`
 * stamps it on the consent URL (`auth_req`) whenever the request asks for a
 * fresh sign-in, so a third-party client's `prompt=login` / `max_age=0` can
 * demand a sign-in made AFTER the request (OIDC), and survive the round trip
 * through /login without looping. Derived from JWT_SECRET like the refresh
 * successor key; per process without one (dev/test).
 */
const AUTH_REQUEST_KEY = process.env.JWT_SECRET
  ? createHmac("sha256", process.env.JWT_SECRET)
      .update("oauth-authorize-request-time")
      .digest()
  : randomBytes(32);
/** A stamp older than this is refused: the flow starts again. */
const AUTH_REQUEST_MAX_AGE_MS = 60 * 60 * 1000;
/** Kratos' clock and this pod's may differ by a little. */
const CLOCK_SKEW_MS = 2_000;

const authRequestMac = (at: number) =>
  createHmac("sha256", AUTH_REQUEST_KEY)
    .update(`authorize|${at}`)
    .digest("base64url");

/** The signed `auth_req` value for a request made at `at` (ms). */
export function signAuthRequestTime(at: number = Date.now()): string {
  return `${at}.${authRequestMac(at)}`;
}

/** The request time an `auth_req` value proves, or null (absent, forged, stale). */
export function verifyAuthRequestTime(
  raw: string | null | undefined,
  now: number = Date.now()
): number | null {
  const match = /^([0-9]{1,15})\.([A-Za-z0-9_-]{43})$/.exec(raw ?? "");
  if (!match) return null;
  const at = Number(match[1]);
  const expected = Buffer.from(authRequestMac(at));
  const given = Buffer.from(match[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  if (at > now + CLOCK_SKEW_MS || now - at > AUTH_REQUEST_MAX_AGE_MS) {
    return null;
  }
  return at;
}

/**
 * Must the person sign in again before deciding? Only when the request asks
 * for it: `prompt=login`, or `max_age`. An unknown sign-in time is never
 * fresh. Two rules, by who asks:
 *  - a Synap app (`first_party`): "fresh" is within `max_age`, never tighter
 *    than the step-up window (the time from signing in to clicking), so
 *    `max_age=0` and `prompt=login` both mean "within the last 5 minutes" —
 *    the device's step-up clock is what a credential door then checks;
 *  - any other client: OIDC as written. `prompt=login` and `max_age=0` need
 *    a sign-in made AFTER the authorize request (its signed time,
 *    `auth_req`; missing or forged → sign in again); `max_age=N` needs one
 *    within N seconds, with no floor.
 */
export function reauthenticationRequired(
  params: Pick<AuthorizeParams, "maxAge" | "prompt" | "authRequest">,
  authenticatedAt: Date | null,
  clientKind: string,
  now: number = Date.now()
): boolean {
  const maxAgeSeconds =
    params.maxAge === undefined ||
    params.maxAge === null ||
    params.maxAge === ""
      ? null
      : Number(params.maxAge);
  const hasMaxAge =
    maxAgeSeconds !== null &&
    Number.isInteger(maxAgeSeconds) &&
    maxAgeSeconds >= 0;
  const login = params.prompt === "login";
  if (!login && !hasMaxAge) return false;
  if (!authenticatedAt) return true;
  const age = now - authenticatedAt.getTime();
  if (clientKind === "first_party" || clientKind !== "first_party") {
    const limit = Math.max(
      login || !hasMaxAge ? 0 : maxAgeSeconds! * 1000,
      STEP_UP_WINDOW_MS
    );
    return age > limit;
  }
  if (login || maxAgeSeconds === 0) {
    const requestedAt = verifyAuthRequestTime(params.authRequest, now);
    if (requestedAt === null) return true;
    if (authenticatedAt.getTime() < requestedAt - CLOCK_SKEW_MS) return true;
    // Signed in after the request: that IS `max_age=0`.
    if (!hasMaxAge || maxAgeSeconds === 0) return false;
  }
  return hasMaxAge && age > maxAgeSeconds! * 1000;
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
  if (isFirstPartyClientId(clientId)) {
    // A Synap app (desktop, Relay): declared in code, shipped with the pod.
    client = resolveFirstPartyClient(clientId);
  } else if (isAppClientId(clientId)) {
    // "Sign in with Synap": an app registered AND approved on this pod,
    // resolved from `apps` — never from `oauth_clients`, which DCR writes.
    client = await resolveAppClient(clientId);
    if (!client) throw new AuthorizeUserError(APP_CANNOT_SIGN_IN);
  } else if (isClientMetadataUrl(clientId)) {
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
  if (!clientAcceptsRedirect(client, redirectUri)) {
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
  // A Synap app (`first_party`) gets none: its token is the person on the
  // app API, which no scope string narrows.
  const grantedScopes =
    client.clientKind === "first_party"
      ? []
      : client.clientKind === "app"
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
  if (client.clientKind === "first_party") {
    // Strict, and for the pod itself: `firstPartyResourceForIssuer`.
    return {
      resource: firstPartyResourceForIssuer(raw, issuer),
      ignoredResource: null,
    };
  }
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
  /**
   * 'dcr' — an MCP client (claude.ai); 'cimd' — a pod app; 'app' — an
   * approved app a person signs in to ("Sign in with Synap"); 'first_party'
   * — a Synap app (desktop, Relay) signing the person in on this device.
   */
  clientKind: "dcr" | "cimd" | "app" | "first_party";
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
  /**
   * "Sign in with Synap" (an `app_…` client): what the app will do AS the
   * viewer, derived from the grant they would receive. null for every other
   * client (an MCP agent connection).
   */
  appSignIn: AppSignInDescription | null;
  /**
   * The request asks for a fresh sign-in (`prompt=login` / `max_age`) and
   * the viewer's is older: the screen sends them to sign in again first.
   */
  reauthenticate: boolean;
  /**
   * A Synap app re-confirming a device it holds (`isDeviceReconfirm`): the
   * screen asks "Confirm it's you", not "Sign in".
   */
  reconfirmDevice: boolean;
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
 * For a pod app it also derives, for THIS person, the spaces each permission
 * may be given in.
 */
export async function getOAuthConsentContext(
  params: AuthorizeParams,
  /**
   * The person deciding. Required for a pod app (its offer is per person) and
   * for an app sign-in (its grant is this person's reach).
   */
  callerUserId?: string,
  /** The viewer's Kratos session, for `prompt=login` / `max_age`. */
  callerSession?: { authenticated_at?: string | null } | null
): Promise<OAuthConsentContext> {
  const req = await resolveAuthorizeRequest(params);
  let appSignIn: AppSignInDescription | null = null;
  if (req.client.clientKind === "app") {
    if (!callerUserId) {
      throw new Error(
        "getOAuthConsentContext: an app sign-in needs the caller"
      );
    }
    const signIn = await appSignInFor(req.client, callerUserId);
    appSignIn = await describeAppSignIn(
      req.client.clientName,
      signIn.registeredBy,
      signIn.grant
    );
  }
  const base = {
    clientId: req.client.clientId,
    clientKind: req.client.clientKind,
    clientName: req.client.clientName,
    redirectUri: req.redirectUri,
    redirectHost: new URL(req.redirectUri).host,
    scopes: req.grantedScopes,
    registeredAt: req.client.createdAt,
    appSignIn,
    reauthenticate: reauthenticationRequired(
      params,
      sessionAuthenticatedAt(callerSession),
      req.client.clientKind
    ),
    reconfirmDevice: isDeviceReconfirm(req.client.clientKind, params.prompt),
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

  // Consent is a person's own act in their own browser session. A request
  // carrying a key's grant or an acting agent (any key door) never decides
  // it — otherwise an agent key, remapped to the human it acts for, could
  // mint a sign-in as that human (threat T4, app-person-token.ts).
  if (getActingAgentUserId() || getRequestGrant()) {
    throw new AuthorizeUserError(
      "Only a person signed in to this pod can authorize a connection."
    );
  }
  // Nor a Synap app's device token: a 1 h token must
  // never turn itself into a new device (180 days) or an agent connection
  // (90 days) through this door. Consent is a browser act, on the console,
  // in a Kratos session.
  if (isDeviceSession(ctx)) {
    throw new AuthorizeUserError(
      "Authorize a connection from your pod's console, in your browser."
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

  // `prompt=login` / `max_age`: a decision on an old sign-in is refused
  // BEFORE anything is written; the screen signs the person in again. The
  // real time of that sign-in travels with the code (a Synap app's device
  // takes it as its step-up clock).
  const authTime = sessionAuthenticatedAt(ctx?.session);
  if (reauthenticationRequired(input, authTime, req.client.clientKind)) {
    throw new ReauthenticationRequiredError();
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
    scopes,
    codeChallenge: req.codeChallenge,
    resource: req.resource,
    appId,
    appGrant,
    authTime,
    stepUp: isDeviceReconfirm(req.client.clientKind, input.prompt),
  });

  return {
    redirectTo: buildAuthorizationResponseUrl(req.redirectUri, issuer, {
      code,
      state: req.state || null,
    }),
  };
}
