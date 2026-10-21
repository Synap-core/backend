/**
 * Pod app refresh tokens (spec 17 §6.6, wave PB3; founder decision F5: access
 * 1 h, refresh rotating with family revoke, 30-day idle expiry, no absolute
 * cap). Only a pod app (CIMD client) gets one; an MCP (DCR) client never does.
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
 * What the refreshed key may reach is NOT stored here: /token re-derives it
 * from the connection's CURRENT approval (`mintAppOAuthAccessKey`), so a
 * narrowed approval narrows the next key and a revoked app gets none.
 */

import { createHash, randomBytes, randomUUID } from "crypto";
import { db, and, eq, isNull, drizzleSql as sql } from "@synap/database";
import { apps, oauthRefreshTokens } from "@synap/database/schema";

import { revokeActiveHubInboundKeysForUser } from "../../services/hub-integration-registration.js";
import { OAuthError } from "./protocol.js";

/** A refresh token lives this long from its issue; each use issues a new one. */
export const REFRESH_TOKEN_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The connection a refresh token belongs to. */
export interface RefreshConnection {
  /** The pod app's CIMD URL (its OAuth `client_id`). */
  clientId: string;
  /** The consenting person. */
  userId: string;
  /** The connection's `apps` row (mode 'oauth'). */
  appId: string;
}

/** A redeemed (now used) token: what the refresh grant mints for. */
export interface RedeemedRefreshToken extends RefreshConnection {
  id: string;
  familyId: string;
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

/** Serialize every write that creates or kills this connection's tokens. */
async function lockConnection(tx: Tx, appId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`oauth-refresh|${appId}`}))`
  );
}

/**
 * GC: the connection's tokens past expiry are deleted at each issue. They
 * redeem nothing; the cost is that a replay of one older than 30 d reads as
 * unknown instead of as a reuse. Bounds a connection to the tokens issued in
 * its last 30 days (one per refresh).
 */
async function sweepExpired(tx: Tx, appId: string): Promise<void> {
  await tx
    .delete(oauthRefreshTokens)
    .where(
      and(
        eq(oauthRefreshTokens.appId, appId),
        sql`${oauthRefreshTokens.expiresAt} < now()`
      )
    );
}

async function insertToken(
  tx: Tx,
  conn: RefreshConnection,
  familyId: string,
  id: string = randomUUID()
): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await tx.insert(oauthRefreshTokens).values({
    id,
    tokenHash: hashRefreshToken(raw),
    familyId,
    clientId: conn.clientId,
    userId: conn.userId,
    appId: conn.appId,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_IDLE_TTL_MS),
  });
  return raw;
}

/**
 * The first refresh token of a new family, at an authorization-code
 * exchange. The connection's other families end here: the newest consent is
 * the connection. Returns the RAW token once; only its hash is stored.
 */
export async function startRefreshFamily(
  conn: RefreshConnection
): Promise<string> {
  return db.transaction(async (tx) => {
    await lockConnection(tx, conn.appId);
    await tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(oauthRefreshTokens.appId, conn.appId),
          isNull(oauthRefreshTokens.revokedAt)
        )
      );
    await sweepExpired(tx, conn.appId);
    return insertToken(tx, conn, randomUUID());
  });
}

/**
 * Redeem a refresh token for `clientId`: claim it (single-use) and return
 * its connection. Throws `invalid_grant` for an unknown, foreign, revoked or
 * expired token, and for the loser of a concurrent redeem; a token already
 * used is a reuse: its family and the connection's live key are revoked
 * first (`RefreshTokenReuseError`).
 */
export async function redeemRefreshToken(
  raw: string,
  clientId: string
): Promise<RedeemedRefreshToken> {
  const [row] = await db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, hashRefreshToken(raw)))
    .limit(1);
  // A token is bound to the client it was issued to (RFC 6749 §6).
  if (!row || row.clientId !== clientId) {
    throw new OAuthError("invalid_grant", INVALID);
  }
  if (row.revokedAt) throw new OAuthError("invalid_grant", INVALID);
  if (row.lastUsedAt) {
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
  if (!claimed) throw new OAuthError("invalid_grant", INVALID);
  return {
    id: row.id,
    familyId: row.familyId,
    clientId: row.clientId,
    userId: row.userId,
    appId: row.appId,
  };
}

/**
 * The successor of a redeemed token, issued AFTER the new access key was
 * minted. Refused when the family was revoked meanwhile (a reuse, /revoke,
 * the app revoked): the key just minted is revoked too, and the grant is
 * `invalid_grant`.
 */
export async function rotateRefreshToken(
  prev: RedeemedRefreshToken
): Promise<string> {
  const id = randomUUID();
  const raw = await db.transaction(async (tx) => {
    await lockConnection(tx, prev.appId);
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
    await sweepExpired(tx, prev.appId);
    return insertToken(tx, prev, prev.familyId, id);
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
    await lockConnection(tx, token.appId);
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
    await lockConnection(tx, appId);
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
 * The connection's live access key stops now. A pod app's agent is one per
 * (app × person) and holds only this connection's key slot, so its live
 * hub_inbound keys ARE the slot.
 */
async function revokeConnectionAccessKey(
  conn: RefreshConnection,
  reason: string
): Promise<void> {
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
