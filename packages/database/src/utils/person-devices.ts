/**
 * Signed-in devices of the Synap apps (0340, join plan target A) — the half
 * every process shares: the access token's grammar, the ONE lookup the app
 * doors use (`/trpc` and the other app routes through the api's
 * `appSessionMiddleware`, realtime through `verifyHandshakeUser`), and the ONE
 * revoke. MINTING is not here: it has one door, api
 * `services/person-device-token.ts`, which states the threat model.
 *
 * The executor is passed in (as `revokeApiKeys` takes it), so each process
 * uses its own pool and a test its own database.
 *
 * A device token resolves to the SHAPE a Kratos session has
 * (`{ identity: { id, traits } }`), because every app door reads that shape.
 * It carries no `authenticated_at`, so a door that asks for a recent sign-in
 * (account recovery's `sessionIsPrivileged`) never counts it as one: those
 * steps stay in the browser, on a real Kratos session.
 */
import { createHash } from "crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  oauthRefreshTokens,
  personDeviceTokens,
  personDevices,
  users,
} from "../schema/index.js";
import {
  hasActivePodAccess,
  readPodUserAccess,
} from "../services/pod-user-access.js";

/** Every device access token starts with this; no other credential does. */
export const PERSON_DEVICE_TOKEN_PREFIX = "synap_pd_";

/** Is this string shaped like a device access token (never a proof it is one)? */
export function isPersonDeviceToken(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.startsWith(PERSON_DEVICE_TOKEN_PREFIX) &&
    raw.length > PERSON_DEVICE_TOKEN_PREFIX.length
  );
}

/** sha256(token), hex — the only form of a device token that is stored. */
export function hashPersonDeviceToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** What a live device token resolves to: a Kratos-shaped session. */
export interface PersonDeviceSession {
  identity: { id: string; traits: { email: string; name?: string } };
  active: true;
  /**
   * The device it was minted for (what the devices list marks as "this
   * one"), with its step-up clock: when the person last really authenticated
   * for it (`person_devices.auth_time`; null = unknown, never fresh).
   */
  device: { id: string; clientId: string; authTime: Date | null };
}

/** Anything that can run the queries — the pool, or a transaction. */
type Executor = any;

/**
 * Does `userId` still hold access to this pod — a live space or project
 * membership, or the pod owner/admin role (`hasActivePodAccess`, the ONE
 * answer)? Read on every use, never remembered from the sign-in, so EVERY way
 * a person loses access (removed from the pod or from their last space or
 * project, the account deleted) ends their devices without the door that
 * removed them knowing devices exist. Two index lookups keyed by the person
 * (`workspace_members.user_id`, `project_members.user_id`). A failed read
 * throws.
 */
export async function personHoldsPodAccess(
  db: Executor,
  userId: string
): Promise<boolean> {
  return hasActivePodAccess(await readPodUserAccess(userId, db));
}

/** Why a device ended because its person lost access to the pod. */
export const DEVICE_ENDED_NO_ACCESS = "No longer has access to this pod";

/**
 * The person a device access token stands for, or null when it is not one:
 * unknown, expired, its device revoked or past its absolute cap, held by no
 * person (an agent user can never hold one, re-checked here), or held by a
 * person who no longer has access to this pod (`personHoldsPodAccess`) — that
 * device is ENDED here, so adding the person back later does not revive it.
 * A failed read THROWS: the caller answers "unavailable", never "signed out".
 */
export async function resolvePersonDeviceSession(
  db: Executor,
  raw: string
): Promise<PersonDeviceSession | null> {
  if (!isPersonDeviceToken(raw)) return null;
  const now = new Date();
  const [row] = await db
    .select({
      deviceId: personDevices.id,
      clientId: personDevices.clientId,
      authTime: personDevices.authTime,
      userId: users.id,
      email: users.email,
      name: users.name,
    })
    .from(personDeviceTokens)
    .innerJoin(personDevices, eq(personDevices.id, personDeviceTokens.deviceId))
    .innerJoin(users, eq(users.id, personDevices.userId))
    .where(
      and(
        eq(personDeviceTokens.tokenHash, hashPersonDeviceToken(raw)),
        gt(personDeviceTokens.expiresAt, now),
        isNull(personDevices.revokedAt),
        gt(personDevices.expiresAt, now),
        eq(users.userType, "human")
      )
    )
    .limit(1);
  if (!row) return null;
  if (!(await personHoldsPodAccess(db, row.userId))) {
    await revokePersonDevice(db, {
      deviceId: row.deviceId,
      reason: DEVICE_ENDED_NO_ACCESS,
    });
    return null;
  }
  return {
    identity: {
      id: row.userId,
      traits: { email: row.email, ...(row.name ? { name: row.name } : {}) },
    },
    active: true,
    device: {
      id: row.deviceId,
      clientId: row.clientId,
      authTime: row.authTime ?? null,
    },
  };
}

/**
 * End a device: it stops at once, with every access token (deleted) and
 * refresh token (revoked) it holds. Idempotent; returns whether this call
 * ended it. The device row is the authority — every lookup reads through it —
 * so a refresh racing this revoke can never yield a live token.
 */
export async function revokePersonDevice(
  db: Executor,
  args: { deviceId: string; reason: string }
): Promise<boolean> {
  return db.transaction(async (tx: Executor) => {
    const ended = await tx
      .update(personDevices)
      .set({ revokedAt: new Date(), revokedReason: args.reason })
      .where(
        and(
          eq(personDevices.id, args.deviceId),
          isNull(personDevices.revokedAt)
        )
      )
      .returning({ id: personDevices.id });
    await tx
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(oauthRefreshTokens.deviceId, args.deviceId),
          isNull(oauthRefreshTokens.revokedAt)
        )
      );
    await tx
      .delete(personDeviceTokens)
      .where(eq(personDeviceTokens.deviceId, args.deviceId));
    return ended.length > 0;
  });
}

/**
 * End EVERY live device of one person (`revokePersonDevice` each): for a door
 * that withdraws how the person proves who they are while leaving their
 * access in place (unlinking their sign-in from an issuer), which the access
 * read in `resolvePersonDeviceSession` cannot see. Returns how many ended.
 */
export async function revokeAllPersonDevices(
  db: Executor,
  args: { userId: string; reason: string }
): Promise<number> {
  const live = await db
    .select({ id: personDevices.id })
    .from(personDevices)
    .where(
      and(
        eq(personDevices.userId, args.userId),
        isNull(personDevices.revokedAt)
      )
    );
  let ended = 0;
  for (const { id } of live as Array<{ id: string }>) {
    if (await revokePersonDevice(db, { deviceId: id, reason: args.reason })) {
      ended += 1;
    }
  }
  return ended;
}
