/**
 * A Synap app signed in as a PERSON — the ONE mint door for a device's tokens
 * (join plan target A, founder decision `decision:join-target-a-2026-10-21`).
 *
 * Synap Desktop and Synap Relay are FIRST-PARTY clients of the pod's own OAuth
 * server (`FIRST_PARTY_CLIENTS`, routers/oauth/config.ts): the app opens the
 * system browser on `/authorize`, the person signs in on the pod's own page
 * and confirms, and the code comes back to a loopback port (desktop) or the
 * app's own redirect (Relay). `/token` then calls THIS door, which makes a
 * DEVICE (`person_devices`, the refresh family the person sees and revokes)
 * and hands back:
 *   - an ACCESS token, 1 h (`synap_pd_…`, sha256-only in
 *     `person_device_tokens`), accepted ONLY on the app API — `/trpc` and the
 *     app routes (`appSessionMiddleware`) and realtime (`verifyHandshakeUser`)
 *     — where it resolves AS THE PERSON, exactly as a Kratos session does;
 *   - a REFRESH token, single-use and rotating (refresh.ts), 30 days idle,
 *     never past the device's 180-day absolute cap.
 * Same shape as its sibling `app-person-token.ts` ("Sign in with Synap" for a
 * registered app), but unbounded by a grant: it IS the person in their app.
 *
 * THREAT MODEL — each threat, its defence, and the test that holds it
 * (`person-device-token.pglite.test.ts` unless named). Two paths reach this
 * door; each is modelled step by step, then the token itself.
 *
 * ── The MINT path (an authorization code becomes a device) ──
 *  M1 Code replay, a wrong PKCE verifier, a foreign redirect. The AS rules
 *     every client obeys before this door runs: the code is CLAIMED atomically
 *     (one UPDATE … RETURNING; a second exchange gets nothing), bound to the
 *     client it was issued to, its redirect re-checked through the first-party
 *     matcher (`matchFirstPartyRedirect`: loopback IP literals any port, exact
 *     path; `localhost` refused), the S256 verifier checked, and a `resource`
 *     must be this pod. → routes.test, first-party-redirect.test, "(a)".
 *  M2 Another client getting a device. Only a code whose client resolves as
 *     `first_party` from the CODE registry (`resolveFirstPartyClient`, never a
 *     DCR row) reaches `signInPersonDevice`, which re-checks the id; only THIS
 *     file inserts into `person_device_tokens` (tripwire
 *     `person-device-mint-one-door`). → "a non-first-party client id never
 *     gets a device".
 *  M3 An agent, a key, or a device token authoring the consent. The code
 *     exists only after `decideOAuthAuthorization`: a human (`userType`),
 *     with no acting agent and no key grant, in a KRATOS session — a device
 *     session is refused there and at the procedure (`credentialProcedure`),
 *     so a 1 h token can never mint itself a 180-day device. This door
 *     re-checks `userType === "human"` at mint. → "(h)", "a device token
 *     cannot authorize a connection".
 *  M4 Loopback impersonation (RFC 8252 §8.6): any program on the computer can
 *     listen on 127.0.0.1. PKCE binds the code to the program that STARTED
 *     the flow, so a listener that did not start it holds a useless code; the
 *     consent is always a click naming the app and "this computer"; the
 *     devices list shows every sign-in with its label and user agent.
 *     Accepted residual: a malicious program that starts its own flow and
 *     gets the person to click "Sign in".
 *  M5 The step-up clock (`person_devices.auth_time`) set from the wrong time.
 *     It is the consenting KRATOS session's `authenticated_at`, read
 *     server-side at the decision and carried by the code — never mint time,
 *     never anything the app sends. A device minted from an hours-old
 *     browser session is stale at once. → "a device minted from an old
 *     sign-in needs a step-up at once".
 *  M6 A step-up minting a second device, or moving another device's clock.
 *     `stepUpPersonDevice` needs the code (a fresh sign-in, `prompt=login` /
 *     `max_age` enforced at the decision) AND that device's refresh token,
 *     checked — before anything is spent — to belong to this client and to
 *     the person who just signed in; it moves only that device's clock, only
 *     forward, and creates nothing. → "a step-up re-confirms the SAME
 *     device".
 *
 * ── The REFRESH path (rotation, refresh.ts) ──
 *  R1 Refresh-token theft. Every token is SINGLE-USE: the redeem claims it
 *     with one UPDATE that flips `last_used_at` from NULL. When the thief and
 *     the app both redeem, the second presentation is a REUSE (RFC 9700
 *     §4.14.2): the whole family is revoked AND the device ends
 *     (`revokePersonDevice`), access tokens included — once the successor
 *     was used, or past the retry grace (R7). → "a reused refresh token ends
 *     the device", "a retry after 30 s ends the device".
 *  R2 Two honest refreshes at once (two windows). The UPDATE lets exactly one
 *     win; the loser gets `invalid_grant` WITHOUT a family revoke (a retrying
 *     client is not a thief). The apps refresh single-flight (plan §6.3).
 *  R3 A refresh racing a sign-out. The device row is the authority: the
 *     redeem refuses a revoked or capped device, every successor is issued
 *     under the family lock and refused if the family died meanwhile, and
 *     every access token is read THROUGH the device — so a successor issued
 *     a moment after the revoke still opens nothing.
 *  R4 Living forever on refreshes. Each successor lives 30 days idle but
 *     never past the device's absolute cap (180 days from sign-in), and no
 *     access token is minted past it either. → "the absolute cap is
 *     enforced", "near the cap, nothing is minted past it".
 *  R5 A refresh token presented by another client. Bound to its `client_id`:
 *     refused, and NOT spent. → "(g)".
 *  R6 The person loses access. EVERY request reads it through the device
 *     (`resolvePersonDeviceSession`): the `users` row, `user_type = 'human'`,
 *     and a live pod access (`hasActivePodAccess`: a space or project
 *     membership, or the pod owner/admin role — never `pod_members`, which
 *     outlives a removal). A person removed from the pod, or from their last
 *     space or project, or whose account is deleted, gets 401 at once and
 *     the device is ENDED (re-adding them revives nothing). No removal door
 *     needs to know devices exist. Two doors withdraw what the access read
 *     cannot see: unlinking the person's sign-in from an issuer ends all
 *     their devices (`unlinkAccount`); a Kratos identity disabled or deleted
 *     outside the pod is asked at every refresh (`identityIsLive`) and ends
 *     the device within the access token's hour — a Kratos that cannot
 *     answer refuses the refresh unspent. The mint refuses a person with no
 *     access. → "(l)".
 *  R7 A LOST refresh response (a phone dropping off the network after the
 *     token was spent). Within 30 s of its use, while its successor was NEVER
 *     redeemed, the same token is a RETRY (`deviceRetryGrace`, refresh.ts):
 *     the unused successor is retired, a fresh pair is minted, the family and
 *     the device live on. Two retries of the same token AT ONCE: the second
 *     finds the successor just retired by the first and is refused
 *     `invalid_grant` WITHOUT a revoke. Only that grace retires one token of
 *     a live device (tripwire `device-refresh-token-retire-writers`), which is
 *     what lets redeem read any other revoked device token as a reuse.
 *     Residual: a thief replaying within those 30 s, before the app's next
 *     refresh, gets a pair — and the app's own next refresh, presenting the
 *     retired successor, then ends the device (R1), so the theft is loud
 *     within the hour; detect-and-kill, not prevent. → "(k)".
 *     THE APP'S CONTRACT (Relay, Desktop; plan phase 3): refresh
 *     SINGLE-FLIGHT, and keep the pair from the LATEST successful response.
 *     A late first response that arrives after a retry carries a successor
 *     the retry retired; storing it signs the device out at the next refresh.
 *     An `invalid_grant` while another refresh of the same token succeeded
 *     is not a sign-out: keep the successful pair.
 *  R8 A refresh renewing the step-up clock. It never does: `auth_time` lives
 *     on the device row and only a step-up moves it. → "a refreshed token
 *     stays stale".
 *
 * ── The TOKEN on the wire ──
 *  T1 Access-token theft. One hour of the person on the app API only: `/mcp`
 *     and Hub REST resolve `api_keys` rows, which this is not ("(c)"); no door
 *     counts it as a recent sign-in (no `authenticated_at`), so account
 *     recovery and credential changes stay behind a real Kratos session; and
 *     NO credential door takes it unless the person REALLY signed in for this
 *     device within the last 5 minutes (a step-up: `prompt=login` at
 *     /authorize, then this device's refresh token at /token) — a door that
 *     creates, rotates, widens or approves a key, grant, secret grant,
 *     computer, app, connection or governance rule answers FORBIDDEN
 *     `STEP_UP_REQUIRED` otherwise (`credentialProcedure` /
 *     `requireFreshAuthentication`, an executor's `widensCredential`, the
 *     privileged approval floor, the secret-grant writers; tripwire
 *     `credential-doors-refuse-device-session`, "(i)", "(j)"). So a stolen
 *     token, five minutes after the person's last real sign-in, cannot hand
 *     an agent a key or a secret. Revoking the device stops it at once.
 *  T2 A bearer path into the HUMAN context accepting other credentials.
 *     `appSessionMiddleware` accepts a bearer ONLY with the device prefix and
 *     resolves it ONLY through `resolvePersonDeviceSession`; any other bearer
 *     (a PAT, an agent key, a Kratos token sent as a bearer) is ignored, so
 *     the request falls to the Kratos check. → tripwire `app-session-bearer`
 *     (middleware/app-session.test.ts).
 *  T3 A device nobody watches. The devices list (`devices.list`) shows each
 *     sign-in; signing one out is a console act (`devices.revoke`), the app's
 *     own sign-out is RFC 7009 `/revoke` with either token.
 */

import { randomBytes } from "crypto";
import {
  db,
  and,
  desc,
  eq,
  gt,
  isNull,
  lt,
  lte,
  or,
  users,
} from "@synap/database";
import { personDeviceTokens, personDevices } from "@synap/database/schema";
import {
  DEVICE_ENDED_NO_ACCESS,
  PERSON_DEVICE_TOKEN_PREFIX,
  hashPersonDeviceToken,
  personHoldsPodAccess,
  revokePersonDevice,
} from "@synap/database/person-devices";
import { kratosAdmin } from "@synap/auth";

import {
  isFirstPartyClientId,
  type FirstPartyClientId,
} from "../routers/oauth/config.js";
import {
  findRefreshToken,
  redeemRefreshToken,
  rotateRefreshToken,
  startRefreshFamily,
} from "../routers/oauth/refresh.js";
import { OAuthError } from "../routers/oauth/protocol.js";

/** An access token lives 1 h (founder decision 5, the F5 precedent). */
export const PERSON_DEVICE_ACCESS_TTL_MS = 60 * 60 * 1000;

/** No device outlives 180 days from its sign-in, however often it refreshes. */
export const PERSON_DEVICE_ABSOLUTE_CAP_MS = 180 * 24 * 60 * 60 * 1000;

/** The longest device label kept (app-supplied text). */
const LABEL_MAX = 80;
const USER_AGENT_MAX = 300;

export interface PersonDeviceTokens {
  deviceId: string;
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
}

export type SignInPersonDeviceResult =
  | ({ ok: true } & PersonDeviceTokens)
  | {
      ok: false;
      reason: "not_a_person" | "not_first_party" | "no_pod_access";
    };

function clip(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

async function isHuman(userId: string): Promise<boolean> {
  const person = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { userType: true },
  });
  return person?.userType === "human";
}

const INVALID_REFRESH = "Invalid, expired, or revoked refresh token";

/**
 * Is the person's sign-in identity (Kratos; a pod user's id IS its identity
 * id) still live? Asked at every refresh (R6): an identity disabled or
 * deleted in Kratos — by an operator, outside any pod door — ends the device
 * at its next refresh, within the access token's hour. A Kratos that cannot
 * answer THROWS `server_error`: the refresh is refused unspent, never read as
 * "gone" (which would sign the person out on an outage).
 */
async function identityIsLive(userId: string): Promise<boolean> {
  try {
    const { data } = await kratosAdmin.getIdentity({ id: userId });
    return (data.state ?? "active") === "active";
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 404) return false;
    throw new OAuthError(
      "server_error",
      "Could not confirm the account right now; try again"
    );
  }
}

/**
 * Mint one access token for a device: the ONLY insert into
 * `person_device_tokens`. Never past the device's cap. The device's expired
 * tokens are swept here, so a device holds at most the tokens of its last
 * hour.
 */
async function mintAccessToken(
  deviceId: string,
  capAt: Date
): Promise<{ accessToken: string; accessExpiresAt: Date }> {
  const accessToken = `${PERSON_DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const accessExpiresAt = new Date(
    Math.min(Date.now() + PERSON_DEVICE_ACCESS_TTL_MS, capAt.getTime())
  );
  await db
    .delete(personDeviceTokens)
    .where(
      and(
        eq(personDeviceTokens.deviceId, deviceId),
        lte(personDeviceTokens.expiresAt, new Date())
      )
    );
  await db.insert(personDeviceTokens).values({
    tokenHash: hashPersonDeviceToken(accessToken),
    deviceId,
    expiresAt: accessExpiresAt,
  });
  return { accessToken, accessExpiresAt };
}

/**
 * A first-party client's authorization code, redeemed: a NEW device for the
 * person, its first access token and the first refresh token of its family.
 * `label` / `userAgent` are what the app says about itself — shown to the
 * person as text, never trusted.
 */
export async function signInPersonDevice(args: {
  personUserId: string;
  clientId: string;
  label?: string | null;
  userAgent?: string | null;
  /**
   * When the person REALLY authenticated for this sign-in: the consenting
   * Kratos session's `authenticated_at`, carried by the code. The device's
   * step-up clock; null = unknown, never fresh.
   */
  authTime?: Date | null;
}): Promise<SignInPersonDeviceResult> {
  if (!isFirstPartyClientId(args.clientId)) {
    return { ok: false, reason: "not_first_party" };
  }
  if (!(await isHuman(args.personUserId))) {
    return { ok: false, reason: "not_a_person" };
  }
  if (!(await personHoldsPodAccess(db, args.personUserId))) {
    return { ok: false, reason: "no_pod_access" };
  }
  const capAt = new Date(Date.now() + PERSON_DEVICE_ABSOLUTE_CAP_MS);
  const [device] = await db
    .insert(personDevices)
    .values({
      userId: args.personUserId,
      clientId: args.clientId satisfies FirstPartyClientId,
      label: clip(args.label, LABEL_MAX),
      userAgent: clip(args.userAgent, USER_AGENT_MAX),
      expiresAt: capAt,
      authTime: args.authTime ?? null,
    })
    .returning({ id: personDevices.id });
  if (!device) throw new Error("person device: the insert returned no row");

  const access = await mintAccessToken(device.id, capAt);
  const refreshToken = await startRefreshFamily(
    {
      clientId: args.clientId,
      userId: args.personUserId,
      appId: null,
      deviceId: device.id,
    },
    { capAt }
  );
  return { ok: true, deviceId: device.id, ...access, refreshToken };
}

/**
 * `grant_type=refresh_token` for a first-party client: confirm the person's
 * identity is live (before anything is spent), redeem (single-use; a reuse
 * ends the device, refresh.ts), re-check the person and their access to the
 * pod, mint a new access token, then issue the successor. Every refusal is
 * `invalid_grant`; a person who lost their identity, their humanity or their
 * access also has the device ENDED (R6).
 */
export async function refreshPersonDevice(args: {
  refreshToken: string;
  clientId: string;
}): Promise<PersonDeviceTokens> {
  const held = await findRefreshToken(args.refreshToken);
  if (
    held?.deviceId &&
    held.clientId === args.clientId &&
    !(await identityIsLive(held.userId))
  ) {
    await revokePersonDevice(db, {
      deviceId: held.deviceId,
      reason: "The account was disabled or deleted",
    });
    throw new OAuthError("invalid_grant", INVALID_REFRESH);
  }
  const redeemed = await redeemRefreshToken(args.refreshToken, args.clientId);
  if (!redeemed.deviceId || !redeemed.capAt) {
    // A pod app's token presented by a first-party client id: never ours.
    throw new OAuthError("invalid_grant", INVALID_REFRESH);
  }
  const ended = !(await isHuman(redeemed.userId))
    ? "The signed-in account is no longer a person"
    : !(await personHoldsPodAccess(db, redeemed.userId))
      ? DEVICE_ENDED_NO_ACCESS
      : null;
  if (ended) {
    await revokePersonDevice(db, {
      deviceId: redeemed.deviceId,
      reason: ended,
    });
    throw new OAuthError("invalid_grant", INVALID_REFRESH);
  }
  const access = await mintAccessToken(redeemed.deviceId, redeemed.capAt);
  const refreshToken = await rotateRefreshToken(redeemed);
  await db
    .update(personDevices)
    .set({ lastUsedAt: new Date() })
    .where(eq(personDevices.id, redeemed.deviceId));
  return { deviceId: redeemed.deviceId, ...access, refreshToken };
}

/**
 * A STEP-UP of a device the app already holds (`prompt=login` at /authorize,
 * then /token with the code AND the device's refresh token): the code's fresh
 * sign-in moves THAT device's step-up clock; nothing else changes and no
 * device is created. The refresh token proves which device (and that its
 * family is live); it is redeemed and rotated like any refresh. Refused —
 * before anything is spent — when it is not a device of this client and of
 * the person who just signed in.
 */
export async function stepUpPersonDevice(args: {
  refreshToken: string;
  clientId: string;
  personUserId: string;
  authTime: Date | null;
}): Promise<PersonDeviceTokens> {
  const held = await findRefreshToken(args.refreshToken);
  if (
    !held?.deviceId ||
    held.clientId !== args.clientId ||
    held.userId !== args.personUserId ||
    !args.authTime
  ) {
    throw new OAuthError(
      "invalid_grant",
      "This sign-in does not match the device it re-confirms"
    );
  }
  const tokens = await refreshPersonDevice({
    refreshToken: args.refreshToken,
    clientId: args.clientId,
  });
  // Only ever forward: an older sign-in never rewinds the clock.
  await db
    .update(personDevices)
    .set({ authTime: args.authTime })
    .where(
      and(
        eq(personDevices.id, tokens.deviceId),
        isNull(personDevices.revokedAt),
        or(
          isNull(personDevices.authTime),
          lt(personDevices.authTime, args.authTime)
        )
      )
    );
  return tokens;
}

/** One signed-in device, as the person's devices list shows it. */
export interface PersonDeviceSummary {
  id: string;
  /** The first-party client (`resolveFirstPartyClientName` names it). */
  clientId: string;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

/** The person's live devices, newest first. */
export async function listPersonDevices(
  userId: string
): Promise<PersonDeviceSummary[]> {
  return db
    .select({
      id: personDevices.id,
      clientId: personDevices.clientId,
      label: personDevices.label,
      createdAt: personDevices.createdAt,
      lastUsedAt: personDevices.lastUsedAt,
      expiresAt: personDevices.expiresAt,
    })
    .from(personDevices)
    .where(
      and(
        eq(personDevices.userId, userId),
        isNull(personDevices.revokedAt),
        gt(personDevices.expiresAt, new Date())
      )
    )
    .orderBy(desc(personDevices.createdAt));
}

/**
 * The person signs one of THEIR devices out. False when it is not theirs, is
 * unknown, or had already ended — the caller answers one "not found".
 */
export async function revokeOwnPersonDevice(args: {
  userId: string;
  deviceId: string;
}): Promise<boolean> {
  const [device] = await db
    .select({ id: personDevices.id })
    .from(personDevices)
    .where(
      and(
        eq(personDevices.id, args.deviceId),
        eq(personDevices.userId, args.userId)
      )
    )
    .limit(1);
  if (!device) return false;
  return revokePersonDevice(db, {
    deviceId: device.id,
    reason: "Signed out from the devices list",
  });
}
