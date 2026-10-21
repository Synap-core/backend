/**
 * Refresh tokens of this AS: a pod app's (spec 17 §6.6, wave PB3; founder
 * decision F5: access 1 h, refresh rotating with family revoke, 30-day idle
 * expiry, no absolute cap) and a Synap app's signed-in DEVICE's (0340, join
 * plan target A: the same rules plus a 180-day absolute cap, the device's
 * `expires_at`). An MCP (DCR) client never gets one.
 *
 * A family has ONE owner (a CHECK in 0340): a pod app CONNECTION (`appId`, an
 * `apps` row) or a DEVICE (`deviceId`, a `person_devices` row whose id is the
 * family id). The rules below are the same for both; only "the live access
 * credential" differs — the connection's agent key, or the device itself
 * (`revokePersonDevice`, whose row every device token is read through).
 *
 * Ported from the Control Plane's `exchangeRefreshToken` /
 * `revokeRefreshTokenFamily` (synap-control-plane-api `src/lib/oauth.ts`), not
 * imported: the CP signs JWTs, the pod's access token is an `api_keys` row.
 * Same rules:
 *   - stored as sha256 only (a dump redeems nothing);
 *   - SINGLE-USE and atomic: the one UPDATE that flips `last_used_at` from
 *     NULL wins, so two concurrent redeems never both mint, and the loser is
 *     refused WITHOUT a family revoke (a client retrying is not a thief);
 *   - a token presented AGAIN after its use means two parties hold it (RFC
 *     9700 §4.14.2): its whole family is revoked, and so is the connection's
 *     live access key;
 *   - each successor lives 30 d from its issue: idle expiry, no absolute cap.
 * One difference: the CP walks `replaced_by` links to find a family; here
 * every token carries its `family_id`, so a family dies in one UPDATE.
 *
 * Every write that creates or kills a connection's tokens runs in a
 * transaction holding one advisory lock per connection (`app_id`), so a
 * family revoke can never miss a successor being inserted at the same moment.
 *
 * One connection (person × app) has ONE live family, the way it has one live
 * key: a new authorization code starts a new family and ends the others.
 *
 * The REUSE GRACE (wave PB3b; Auth0's "reuse interval", Okta's "grace
 * period"): a serverless app (a Next.js BFF on Vercel) can present one refresh
 * token twice within seconds from two instances, and no client library can
 * single-flight across instances. So a spent token presented again with its
 * own client_id (self-asserted by a public client: evidence, not proof)
 * within `refreshReuseGraceMs()` (30 s by default) of its use gets the
 * SAME pair its first use got: the successor refresh token, while that one is
 * unspent and its family live, and the connection's live access key. Neither
 * is stored: a successor's raw token and its key are re-derived from the
 * successor's row id under a key derived from JWT_SECRET
 * (`successorRefreshToken`, `successorAccessToken`), the trust root the hub
 * JWT secret already hangs from. Outside the grace, a used successor, a dead
 * family or another client_id: the PB3 rule (a reuse revokes family + live
 * key).
 *
 * What the refreshed key may reach is NOT stored here: /token re-derives it
 * from the connection's CURRENT approval (`mintAppOAuthAccessKey`), so a
 * narrowed approval narrows the next key and a revoked app gets none.
 */

import { createHash, createHmac, randomBytes, randomUUID } from "crypto";
import { db, and, eq, isNull, drizzleSql as sql } from "@synap/database";
import {
  apps,
  oauthRefreshTokens,
  personDevices,
} from "@synap/database/schema";
import { revokePersonDevice } from "@synap/database/person-devices";

import {
  getHubInboundKeyPrefix,
  revokeActiveHubInboundKeysForUser,
} from "../../services/hub-integration-registration.js";
import { OAuthError } from "./protocol.js";

/** A refresh token lives this long from its issue; each use issues a new one. */
export const REFRESH_TOKEN_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The reuse grace by default, and the most `OAUTH_REFRESH_REUSE_GRACE_SECONDS` may set. */
export const REFRESH_REUSE_GRACE_DEFAULT_SECONDS = 30;
export const REFRESH_REUSE_GRACE_MAX_SECONDS = 60;

/**
 * How long after its use a refresh token may be presented again by its own
 * client and get the same pair back. `OAUTH_REFRESH_REUSE_GRACE_SECONDS`
 * overrides the default, capped at the max; `0` turns the grace off; anything
 * unreadable is the default.
 */
export function refreshReuseGraceMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.OAUTH_REFRESH_REUSE_GRACE_SECONDS?.trim();
  const seconds = raw ? Number(raw) : NaN;
  return (
    (Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds, REFRESH_REUSE_GRACE_MAX_SECONDS)
      : REFRESH_REUSE_GRACE_DEFAULT_SECONDS) * 1000
  );
}

/**
 * A replay within the grace that finds its token claimed but no successor
 * yet (the first redeem is still minting) waits this long for it, then is
 * refused WITHOUT a family revoke, as the loser of a concurrent claim is.
 */
export const REFRESH_SUCCESSOR_WAIT_MS = 3000;

/**
 * Whether a token used at `usedAt` is still within the grace at `now`: the
 * window is half-open, so a replay AT `graceMs` is already a reuse.
 */
export function withinReuseGrace(
  usedAt: Date,
  now: number,
  graceMs: number
): boolean {
  return graceMs > 0 && now - usedAt.getTime() < graceMs;
}
const SUCCESSOR_POLL_MS = 100;

/**
 * Derived from JWT_SECRET (every pod has one), as the hub JWT secret and the
 * agent upload token key are. With no JWT_SECRET (dev/test) a per-process
 * key: the grace then only holds within one process lifetime.
 */
const SUCCESSOR_KEY = process.env.JWT_SECRET
  ? createHmac("sha256", process.env.JWT_SECRET)
      .update("oauth-refresh-successor")
      .digest()
  : randomBytes(32);

const successorMac = (purpose: string, successorId: string) =>
  createHmac("sha256", SUCCESSOR_KEY)
    .update(`${purpose}|${successorId}`)
    .digest();

/** A successor refresh token's raw value, from its row id (never stored). */
export function successorRefreshToken(successorId: string): string {
  return successorMac("refresh", successorId).toString("base64url");
}

/**
 * The access key minted with a successor (`mintAppOAuthAccessKey`'s
 * `plainKey`): the same shape as a random hub key, re-derivable from the
 * successor's id, so the grace can hand back the key it came with.
 */
export function successorAccessToken(successorId: string): string {
  return `${getHubInboundKeyPrefix()}${successorMac("access", successorId).toString("hex")}`;
}

/**
 * What a refresh token belongs to: a pod app connection (`appId`) or a
 * signed-in device (`deviceId`) — exactly one of the two.
 */
export interface RefreshConnection {
  /** The client it was issued to: a pod app's CIMD URL, or a first-party id. */
  clientId: string;
  /** The consenting person. */
  userId: string;
  /** The connection's `apps` row (mode 'oauth'); null for a device. */
  appId: string | null;
  /** The signed-in device (`person_devices`); null/absent for a pod app. */
  deviceId?: string | null;
}

/** A redeemed (now used) token: what the refresh grant mints for. */
export interface RedeemedRefreshToken extends RefreshConnection {
  id: string;
  familyId: string;
  /**
   * A device's absolute cap (`person_devices.expires_at`): no successor, and
   * no access token minted from this redeem, may outlive it. Null for an app.
   */
  capAt: Date | null;
  /**
   * Set when the token was ALREADY used, within the reuse grace: the grant
   * answers this successor (unrotated) and the key it came with, nothing new.
   */
  grace?: { successorId: string; refreshToken: string };
}

/**
 * A used token presented again. Still `invalid_grant` on the wire; its own
 * class so /token can log the family it revoked.
 */
export class RefreshTokenReuseError extends OAuthError {
  constructor(public readonly familyId: string) {
    super("invalid_grant", "Invalid, expired, or revoked refresh token");
  }
}

/** One message for every refusal: never say which tokens exist or why. */
const INVALID = "Invalid, expired, or revoked refresh token";

function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The one owner of a connection's tokens, as a column predicate. */
function ownedBy(conn: Pick<RefreshConnection, "appId" | "deviceId">) {
  if (conn.appId) return eq(oauthRefreshTokens.appId, conn.appId);
  if (conn.deviceId) return eq(oauthRefreshTokens.deviceId, conn.deviceId);
  throw new Error("oauth refresh: a token names neither an app nor a device");
}

/** Serialize every write that creates or kills this connection's tokens. */
async function lockConnection(
  tx: Tx,
  conn: Pick<RefreshConnection, "appId" | "deviceId">
): Promise<void> {
  const key = conn.appId
    ? `oauth-refresh|${conn.appId}`
    : `oauth-refresh-device|${conn.deviceId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * GC: the connection's tokens past expiry are deleted at each issue. They
 * redeem nothing; the cost is that a replay of one older than 30 d reads as
 * unknown instead of as a reuse. Bounds a connection to the tokens issued in
 * its last 30 days (one per refresh).
 */
async function sweepExpired(
  tx: Tx,
  conn: Pick<RefreshConnection, "appId" | "deviceId">
): Promise<void> {
  await tx
    .delete(oauthRefreshTokens)
    .where(and(ownedBy(conn), sql`${oauthRefreshTokens.expiresAt} < now()`));
}

/** 30 days from now, never past `capAt` (a device's absolute cap). */
function refreshExpiry(capAt: Date | null | undefined): Date {
  const idle = Date.now() + REFRESH_TOKEN_IDLE_TTL_MS;
  return new Date(capAt ? Math.min(idle, capAt.getTime()) : idle);
}

async function insertToken(
  tx: Tx,
  conn: RefreshConnection,
  familyId: string,
  id: string = randomUUID(),
  raw: string = randomBytes(32).toString("base64url"),
  capAt: Date | null = null
): Promise<string> {
  await tx.insert(oauthRefreshTokens).values({
    id,
    tokenHash: hashRefreshToken(raw),
    familyId,
    clientId: conn.clientId,
    userId: conn.userId,
    appId: conn.appId ?? null,
    deviceId: conn.deviceId ?? null,
    expiresAt: refreshExpiry(capAt),
  });
  return raw;
}

/**
 * The first refresh token of a new family, at an authorization-code
 * exchange. Returns the RAW token once; only its hash is stored.
 *
 * A pod app connection: the connection's other families end here (the
 * newest consent is the connection). A device: the device IS the family
 * (family id = device id), new at this sign-in, and nothing else ends — a
 * person signs in on several computers at once.
 */
export async function startRefreshFamily(
  conn: RefreshConnection,
  opts: { capAt?: Date | null } = {}
): Promise<string> {
  return db.transaction(async (tx) => {
    await lockConnection(tx, conn);
    if (conn.deviceId) {
      return insertToken(
        tx,
        { ...conn, appId: null },
        conn.deviceId,
        randomUUID(),
        randomBytes(32).toString("base64url"),
        opts.capAt ?? null
      );
    }
    await tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(ownedBy(conn), isNull(oauthRefreshTokens.revokedAt)));
    await sweepExpired(tx, conn);
    return insertToken(tx, conn, randomUUID());
  });
}

type RefreshRow = typeof oauthRefreshTokens.$inferSelect;

const redeemedOf = (
  row: RefreshRow,
  capAt: Date | null = null
): RedeemedRefreshToken => ({
  id: row.id,
  familyId: row.familyId,
  clientId: row.clientId,
  userId: row.userId,
  appId: row.appId,
  deviceId: row.deviceId,
  capAt,
});

/**
 * A claimed token's successor id, once its redeem has issued it. Plain reads
 * between sleeps: no transaction or row lock is held while it waits, so the
 * redeem it waits for can take its lock and issue the successor.
 */
async function awaitSuccessor(id: string): Promise<string> {
  const deadline = Date.now() + REFRESH_SUCCESSOR_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SUCCESSOR_POLL_MS));
    const [row] = await db
      .select({
        replacedBy: oauthRefreshTokens.replacedBy,
        revokedAt: oauthRefreshTokens.revokedAt,
      })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.id, id))
      .limit(1);
    if (!row || row.revokedAt) break;
    if (row.replacedBy) return row.replacedBy;
  }
  throw new OAuthError("invalid_grant", INVALID);
}

/** How long after its use a DEVICE's refresh token may be retried. */
export const DEVICE_REFRESH_RETRY_GRACE_MS = 30_000;

/**
 * A Synap app's DEVICE presents a refresh token again: on a flaky phone
 * connection the first refresh's RESPONSE can be lost after the token was
 * spent. Within `DEVICE_REFRESH_RETRY_GRACE_MS` of its use, and while its
 * successor was NEVER redeemed, that is a retry, not a theft: the unused
 * successor is retired (atomically, only if still unused) and the caller
 * mints a fresh pair from this token, in the same family. Anything else —
 * outside the window, the successor already used, or retired by someone
 * else first — is a reuse (false: the caller kills the family AND the
 * device). A successor not issued yet (the first refresh still minting) is
 * waited for briefly, then refused without a revoke. Never touches the
 * device's step-up clock (`auth_time`). Pod apps keep their own PB3b grace
 * (`reuseGrace`), which answers the SAME pair.
 */
async function deviceRetryGrace(row: RefreshRow): Promise<boolean> {
  if (
    !row.lastUsedAt ||
    Date.now() - row.lastUsedAt.getTime() >= DEVICE_REFRESH_RETRY_GRACE_MS
  ) {
    return false;
  }
  const successorId = row.replacedBy ?? (await awaitSuccessor(row.id));
  const retired = await db
    .update(oauthRefreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthRefreshTokens.id, successorId),
        eq(oauthRefreshTokens.familyId, row.familyId),
        isNull(oauthRefreshTokens.lastUsedAt),
        isNull(oauthRefreshTokens.revokedAt)
      )
    )
    .returning({ id: oauthRefreshTokens.id });
  return retired.length > 0;
}

/**
 * The reuse grace for a token already used, named with its own client_id
 * (the caller checked): its successor and that successor's raw token, when
 * the use is
 * within the grace and the successor is unspent, live and re-derivable. null
 * otherwise: a reuse. Throws `invalid_grant` (no revoke) when, within the
 * grace, the first redeem issues no successor in time.
 */
async function reuseGrace(
  row: RefreshRow
): Promise<RedeemedRefreshToken["grace"] | null> {
  // A Synap app's DEVICE has its own retry grace (`deviceRetryGrace`: a NEW
  // pair, the unused successor retired), never this one (the SAME pair).
  if (row.deviceId) return null;
  if (
    !row.lastUsedAt ||
    !withinReuseGrace(row.lastUsedAt, Date.now(), refreshReuseGraceMs())
  ) {
    return null;
  }
  const successorId = row.replacedBy ?? (await awaitSuccessor(row.id));
  const [next] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.id, successorId))
    .limit(1);
  if (
    !next ||
    next.familyId !== row.familyId ||
    next.revokedAt ||
    next.lastUsedAt ||
    next.expiresAt.getTime() <= Date.now()
  ) {
    return null;
  }
  const refreshToken = successorRefreshToken(next.id);
  // Issued before PB3b (random) or under another JWT_SECRET: not ours to
  // hand back.
  if (hashRefreshToken(refreshToken) !== next.tokenHash) return null;
  return { successorId: next.id, refreshToken };
}

/**
 * Redeem a refresh token for `clientId`: claim it (single-use) and return
 * its connection. Throws `invalid_grant` for an unknown, foreign, revoked or
 * expired token, and for the loser of a concurrent redeem outside the grace;
 * a token already used is a reuse: its family and the connection's live key
 * are revoked first (`RefreshTokenReuseError`). Within the reuse grace, a
 * token already used (or lost to a concurrent claim) returns with `grace`
 * set instead.
 */
export async function redeemRefreshToken(
  raw: string,
  clientId: string
): Promise<RedeemedRefreshToken> {
  const [found] = await db
    .select({
      token: oauthRefreshTokens,
      deviceRevokedAt: personDevices.revokedAt,
      deviceExpiresAt: personDevices.expiresAt,
    })
    .from(oauthRefreshTokens)
    .leftJoin(personDevices, eq(personDevices.id, oauthRefreshTokens.deviceId))
    .where(eq(oauthRefreshTokens.tokenHash, hashRefreshToken(raw)))
    .limit(1);
  if (!found) throw new OAuthError("invalid_grant", INVALID);
  const row = found.token;
  // A token is refused to any client but the one it was issued to (RFC 6749
  // §6). A pod app is a public (CIMD + PKCE) client: its client_id is
  // self-asserted, not authenticated, and anyone holding the raw token can
  // send the right one. So this is evidence of theft, not a boundary. A
  // SPENT token named with another client_id has leaked: a reuse, never a
  // grace (PB3b). An unspent one is refused with nothing revoked.
  if (row.clientId !== clientId) {
    if (row.lastUsedAt && !row.revokedAt) {
      await revokeRefreshFamily(
        row,
        "Refresh token reused by another client: every token of its family is revoked"
      );
      throw new RefreshTokenReuseError(row.familyId);
    }
    throw new OAuthError("invalid_grant", INVALID);
  }
  if (row.revokedAt) {
    // A DEVICE's token revoked while its device lives was retired by a
    // retry (`deviceRetryGrace`): someone else continued this family. Two
    // holders — a reuse: the family and the device end (R7).
    if (
      row.deviceId &&
      found.deviceRevokedAt === null &&
      found.deviceExpiresAt
    ) {
      await revokeRefreshFamily(
        row,
        "A retired refresh token was presented: every token of its family is revoked"
      );
      throw new RefreshTokenReuseError(row.familyId);
    }
    throw new OAuthError("invalid_grant", INVALID);
  }
  // A device's token lives only as long as its device: revoked (signed out,
  // removed from the devices list) or past its absolute cap, it is dead.
  if (
    row.deviceId &&
    (found.deviceRevokedAt ||
      !found.deviceExpiresAt ||
      found.deviceExpiresAt.getTime() <= Date.now())
  ) {
    throw new OAuthError("invalid_grant", INVALID);
  }
  if (row.lastUsedAt) {
    // A Synap app's DEVICE retrying after a lost response: its unused
    // successor is retired and the grant proceeds from this token, so the
    // family lives on (deviceRetryGrace). Outside it: a reuse, below.
    if (false as boolean) {
      return redeemedOf(row, found.deviceExpiresAt);
    }
    const grace = await reuseGrace(row);
    if (grace) return { ...redeemedOf(row), grace };
    await revokeRefreshFamily(
      row,
      "Refresh token reused: every token of its family is revoked"
    );
    throw new RefreshTokenReuseError(row.familyId);
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new OAuthError("invalid_grant", INVALID);
  }
  const [claimed] = await db
    .update(oauthRefreshTokens)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(oauthRefreshTokens.id, row.id),
        isNull(oauthRefreshTokens.lastUsedAt),
        isNull(oauthRefreshTokens.revokedAt),
        sql`${oauthRefreshTokens.expiresAt} > now()`
      )
    )
    .returning({ id: oauthRefreshTokens.id });
  if (!claimed) {
    // The loser of a concurrent claim is no thief: within the grace it gets
    // the winner's pair; otherwise it is refused, nothing revoked.
    const [now] = await db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.id, row.id))
      .limit(1);
    const grace = now && !now.revokedAt ? await reuseGrace(now) : null;
    if (grace) return { ...redeemedOf(row), grace };
    throw new OAuthError("invalid_grant", INVALID);
  }
  return redeemedOf(row, row.deviceId ? found.deviceExpiresAt : null);
}

/**
 * A grace answer, confirmed once its access key is in hand: its successor
 * must still be unspent and live. Spent meanwhile (the pair moved on) or its
 * family killed: refused as a reuse, family and live key revoked (the key
 * just handed back with them).
 */
export async function confirmGraceSuccessor(
  redeemed: RedeemedRefreshToken & {
    grace: NonNullable<RedeemedRefreshToken["grace"]>;
  }
): Promise<void> {
  const [next] = await db
    .select({
      lastUsedAt: oauthRefreshTokens.lastUsedAt,
      revokedAt: oauthRefreshTokens.revokedAt,
    })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.id, redeemed.grace.successorId))
    .limit(1);
  if (next && !next.lastUsedAt && !next.revokedAt) return;
  await revokeRefreshFamily(
    redeemed,
    "Refresh token reused: every token of its family is revoked"
  );
  throw new RefreshTokenReuseError(redeemed.familyId);
}

/**
 * The successor of a redeemed token, issued AFTER the new access key was
 * minted. Refused when the family was revoked meanwhile (a reuse, /revoke,
 * the app revoked): the key just minted is revoked too, and the grant is
 * `invalid_grant`. `id` is the successor's row id, chosen before the mint so
 * the key could be `successorAccessToken(id)`; its raw token is
 * `successorRefreshToken(id)`.
 */
export async function rotateRefreshToken(
  prev: RedeemedRefreshToken,
  id: string = randomUUID()
): Promise<string> {
  const raw = await db.transaction(async (tx) => {
    await lockConnection(tx, prev);
    const [linked] = await tx
      .update(oauthRefreshTokens)
      .set({ replacedBy: id })
      .where(
        and(
          eq(oauthRefreshTokens.id, prev.id),
          isNull(oauthRefreshTokens.revokedAt)
        )
      )
      .returning({ id: oauthRefreshTokens.id });
    if (!linked) return null;
    await sweepExpired(tx, prev);
    return insertToken(
      tx,
      prev,
      prev.familyId,
      id,
      successorRefreshToken(id),
      prev.capAt
    );
  });
  if (raw === null) {
    await revokeConnectionAccessKey(
      prev,
      "Refresh token family revoked during a refresh"
    );
    throw new OAuthError("invalid_grant", INVALID);
  }
  return raw;
}

/** A stored refresh token by its raw value, any state; null when unknown. */
export async function findRefreshToken(
  raw: string
): Promise<(RefreshConnection & { familyId: string }) | null> {
  const [row] = await db
    .select({
      familyId: oauthRefreshTokens.familyId,
      clientId: oauthRefreshTokens.clientId,
      userId: oauthRefreshTokens.userId,
      appId: oauthRefreshTokens.appId,
      deviceId: oauthRefreshTokens.deviceId,
    })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, hashRefreshToken(raw)))
    .limit(1);
  return row ?? null;
}

/**
 * Revoke a token's whole family AND the connection's live access key (a
 * reuse, or RFC 7009 /revoke with a refresh token). Idempotent.
 */
export async function revokeRefreshFamily(
  token: RefreshConnection & { familyId: string },
  reason: string
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockConnection(tx, token);
    await tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(oauthRefreshTokens.familyId, token.familyId),
          isNull(oauthRefreshTokens.revokedAt)
        )
      );
  });
  await revokeConnectionAccessKey(token, reason);
}

/**
 * Revoke every live refresh token of a connection (the app revoked). Its
 * keys are the caller's to revoke (`revokeApp` revokes them with their
 * grants).
 */
export async function revokeConnectionRefreshTokens(
  appId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockConnection(tx, { appId });
    await tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(oauthRefreshTokens.appId, appId),
          isNull(oauthRefreshTokens.revokedAt)
        )
      );
  });
}

/**
 * The connection's live access credential stops now. A device: the device
 * itself ends (every access token is read through it). A pod app's agent is
 * one per (app × person) and holds only this connection's key slot, so its
 * live hub_inbound keys ARE the slot.
 */
async function revokeConnectionAccessKey(
  conn: RefreshConnection,
  reason: string
): Promise<void> {
  if (conn.deviceId) {
    await revokePersonDevice(db, { deviceId: conn.deviceId, reason });
    return;
  }
  if (!conn.appId) return;
  const [app] = await db
    .select({ agentUserId: apps.agentUserId })
    .from(apps)
    .where(eq(apps.id, conn.appId))
    .limit(1);
  if (!app?.agentUserId) return;
  await revokeActiveHubInboundKeysForUser(db, {
    userId: app.agentUserId,
    revokedBy: conn.userId,
    revokedReason: reason,
  });
}
