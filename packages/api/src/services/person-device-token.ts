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
 * (`person-device-token.pglite.test.ts` unless named):
 *
 *  T1 Access-token theft. Worth one hour, on the app API only: `/mcp` and Hub
 *     REST resolve `api_keys` rows, which this is not ("refused on /mcp and
 *     the Hub"), and no door counts it as a recent sign-in (no
 *     `authenticated_at`), so account recovery and credential changes stay
 *     behind a real Kratos session. Revoking the device stops it at once
 *     (every lookup reads through the device row).
 *  T2 Refresh-token theft. Single-use with reuse detection (RFC 9700
 *     §4.14.2): when the thief and the app both redeem, the second redeem
 *     ends the whole DEVICE, access tokens included. → "a reused refresh
 *     token ends the device".
 *  T3 A long-lived device nobody watches. 30-day idle expiry, a 180-day
 *     absolute cap no refresh can extend, and a devices list the person reads
 *     and revokes from (`devices.list` / `devices.revoke`). → "the absolute
 *     cap is enforced".
 *  T4 Another client minting a device token. Only a first-party client's code
 *     reaches this door (routes.ts checks `clientKind`), its refresh is bound
 *     to its `client_id` (refresh.ts), and only THIS file inserts into
 *     `person_device_tokens` (tripwire `person-device-mint-one-door`).
 *  T5 An agent signing in as a device. The consent is a person's act in their
 *     own Kratos session (`decideOAuthAuthorization` refuses a key or an
 *     agent principal); this door re-checks `userType === "human"` at mint
 *     AND at refresh, and the lookup re-checks it on every request.
 *  T6 Loopback impersonation (RFC 8252 §8.6): any program on the computer
 *     can listen on 127.0.0.1. PKCE binds the code to the app that started
 *     the flow, and the consent is always a click naming the app and the
 *     device; the devices list shows every sign-in. Accepted residual risk.
 *  T7 A bearer path into the HUMAN context accepting other credentials.
 *     `appSessionMiddleware` accepts a bearer ONLY with the device prefix and
 *     resolves it ONLY here (`resolvePersonDeviceSession`); any other bearer
 *     (a PAT, an agent key, a Kratos token sent as a bearer) is ignored, so
 *     the request falls to the Kratos session check. → tripwire
 *     `app-session-bearer` (middleware/app-session.test.ts).
 *  T8 Code replay, bad PKCE, a foreign redirect. The AS rules every client
 *     already obeys: atomic single-use claim, S256, the first-party redirect
 *     matcher (`matchFirstPartyRedirect`, loopback IP literals only).
 */

import { randomBytes } from "crypto";
import { db, and, desc, eq, gt, isNull, lte, users } from "@synap/database";
import { personDeviceTokens, personDevices } from "@synap/database/schema";
import {
  PERSON_DEVICE_TOKEN_PREFIX,
  hashPersonDeviceToken,
  revokePersonDevice,
} from "@synap/database/person-devices";

import {
  isFirstPartyClientId,
  type FirstPartyClientId,
} from "../routers/oauth/config.js";
import {
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
  | { ok: false; reason: "not_a_person" | "not_first_party" };

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
}): Promise<SignInPersonDeviceResult> {
  if (!isFirstPartyClientId(args.clientId)) {
    return { ok: false, reason: "not_first_party" };
  }
  if (!(await isHuman(args.personUserId))) {
    return { ok: false, reason: "not_a_person" };
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
 * `grant_type=refresh_token` for a first-party client: redeem (single-use; a
 * reuse ends the device, refresh.ts), re-check the person, mint a new access
 * token, then issue the successor. Every refusal is `invalid_grant`.
 */
export async function refreshPersonDevice(args: {
  refreshToken: string;
  clientId: string;
}): Promise<PersonDeviceTokens> {
  const redeemed = await redeemRefreshToken(args.refreshToken, args.clientId);
  if (!redeemed.deviceId || !redeemed.capAt) {
    // A pod app's token presented by a first-party client id: never ours.
    throw new OAuthError(
      "invalid_grant",
      "Invalid, expired, or revoked refresh token"
    );
  }
  if (!(await isHuman(redeemed.userId))) {
    await revokePersonDevice(db, {
      deviceId: redeemed.deviceId,
      reason: "The signed-in account is no longer a person",
    });
    throw new OAuthError(
      "invalid_grant",
      "Invalid, expired, or revoked refresh token"
    );
  }
  const access = await mintAccessToken(redeemed.deviceId, redeemed.capAt);
  const refreshToken = await rotateRefreshToken(redeemed);
  await db
    .update(personDevices)
    .set({ lastUsedAt: new Date() })
    .where(eq(personDevices.id, redeemed.deviceId));
  return { deviceId: redeemed.deviceId, ...access, refreshToken };
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
