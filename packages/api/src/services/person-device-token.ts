/**
 * The ONE mint door for a Synap app signed in as a PERSON on a device. Synap
 * Desktop and Synap Relay are first-party clients of the pod's own OAuth
 * server (`FIRST_PARTY_CLIENTS`, routers/oauth/config.ts): the person signs in
 * and confirms in their browser, and `/token` calls this door, which makes a
 * DEVICE (`person_devices`: one refresh family, the row the person sees and
 * signs out) and returns a 1 h access token (`synap_pd_…`, stored only as
 * sha256, accepted only on the app API, where it IS the person) and a
 * single-use, rotating refresh token (refresh.ts; 30 days idle, never past
 * the device's 180-day cap). Because the token is the person, its whole life
 * is decided here and in refresh.ts — who may get one (a human with access to
 * the pod, from a consent in a browser session), how it refreshes, and every
 * way it ends (sign-out, a reused refresh token, lost access, the cap, more
 * than 20 devices) — and nothing else may insert one (tripwire
 * `person-device-mint-one-door`). Each threat with the test that holds it:
 * JOIN-PLAN, device threat model.
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
  drizzleSql,
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
  refreshDeviceToken,
  startRefreshFamily,
} from "../routers/oauth/refresh.js";
import { OAuthError } from "../routers/oauth/protocol.js";

/** An access token lives 1 h: short enough that a stolen one expires soon. */
export const PERSON_DEVICE_ACCESS_TTL_MS = 60 * 60 * 1000;

/** No device outlives 180 days from its sign-in, however often it refreshes. */
export const PERSON_DEVICE_ABSOLUTE_CAP_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * At most this many live devices per person: a new sign-in beyond it ends
 * the least recently used one, so a leaked or scripted
 * sign-in loop cannot pile up devices nobody watches.
 */
export const PERSON_DEVICE_MAX_ACTIVE = 20;

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
 * id) still live? Asked at every refresh: an identity disabled or
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
  capAt: Date,
  ex: Pick<typeof db, "insert" | "delete"> = db
): Promise<{ accessToken: string; accessExpiresAt: Date }> {
  const accessToken = `${PERSON_DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const accessExpiresAt = new Date(
    Math.min(Date.now() + PERSON_DEVICE_ACCESS_TTL_MS, capAt.getTime())
  );
  await ex
    .delete(personDeviceTokens)
    .where(
      and(
        eq(personDeviceTokens.deviceId, deviceId),
        lte(personDeviceTokens.expiresAt, new Date())
      )
    );
  await ex.insert(personDeviceTokens).values({
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
      authTime: new Date(),
    })
    .returning({ id: personDevices.id });
  if (!device) throw new Error("person device: the insert returned no row");
  await endDevicesBeyondCap(args.personUserId);

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
 * Keep the person's live devices at `PERSON_DEVICE_MAX_ACTIVE`: the least
 * recently used (last refresh, else sign-in) end. The device just signed in
 * is the most recent, so it is never the one ended.
 */
async function endDevicesBeyondCap(userId: string): Promise<void> {
  const live = await db
    .select({ id: personDevices.id })
    .from(personDevices)
    .where(
      and(
        eq(personDevices.userId, userId),
        isNull(personDevices.revokedAt),
        gt(personDevices.expiresAt, new Date())
      )
    )
    .orderBy(
      desc(
        drizzleSql`coalesce(${personDevices.lastUsedAt}, ${personDevices.createdAt})`
      ),
      desc(personDevices.createdAt)
    );
  for (const { id } of live.slice(PERSON_DEVICE_MAX_ACTIVE)) {
    await revokePersonDevice(db, {
      deviceId: id,
      reason: `Signed out: more than ${PERSON_DEVICE_MAX_ACTIVE} devices, the least recently used ends`,
    });
  }
}

/**
 * `grant_type=refresh_token` for a first-party client: confirm the person's
 * identity is live (before anything is spent), redeem (single-use; a reuse
 * ends the device, refresh.ts), re-check the person and their access to the
 * pod, mint a new access token, then issue the successor. Every refusal is
 * `invalid_grant`; a person who lost their identity, their humanity or their
 * access also has the device ENDED.
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
  if (held?.deviceId && held.clientId === args.clientId) {
    const ended = !(await isHuman(held.userId))
      ? "The signed-in account is no longer a person"
      : !(await personHoldsPodAccess(db, held.userId))
        ? DEVICE_ENDED_NO_ACCESS
        : null;
    if (ended) {
      await revokePersonDevice(db, { deviceId: held.deviceId, reason: ended });
      throw new OAuthError("invalid_grant", INVALID_REFRESH);
    }
  }
  // Claim, mint and rotate in ONE transaction (refresh.ts).
  const { redeemed, minted, refreshToken } = await refreshDeviceToken(
    args.refreshToken,
    args.clientId,
    async (tx, r) => {
      const access = await mintAccessToken(r.deviceId!, r.capAt!, tx);
      await tx
        .update(personDevices)
        .set({ lastUsedAt: new Date(), authTime: new Date() })
        .where(eq(personDevices.id, r.deviceId!));
      return access;
    }
  );
  return { deviceId: redeemed.deviceId!, ...minted, refreshToken };
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
