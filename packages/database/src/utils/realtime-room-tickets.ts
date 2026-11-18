/**
 * Realtime room tickets (0433) — the ONE store behind how a pod app opens a
 * live Yjs room. Shared by the api (`POST /api/hub/realtime/room-ticket`
 * mints) and the realtime server (the `/yjs` gate claims, the ticket sweep
 * re-checks), which run as two processes: the ticket is a row, never memory.
 *
 *   mint   → a raw `synap_rt_…` ticket, answered once; its sha256 is stored
 *            with the person, ONE document, the access (read | edit) and the
 *            connection's key, for 60 s.
 *   peek   → the handshake gate: is this a live ticket of this person? It
 *            consumes nothing (the handshake does not know the room yet).
 *   claim  → the room gate: one UPDATE flips `consumed_at` for THIS document
 *            while unexpired and unclaimed, so a ticket opens one room once;
 *            the loser of a race, a replay, another document or an expired
 *            ticket all get null.
 *   live   → the sweep: which connections behind open ticket sockets still
 *            stand (the key, or for a pod app's rotating key its connection
 *            slot, and the person still on the pod).
 */
import { createHash, randomBytes } from "crypto";
import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import {
  APP_PERSON_KEY_TYPE,
  apiKeys,
  realtimeRoomTickets,
  type RoomTicketAccess,
} from "../schema/index.js";
import { personHoldsPodAccess } from "./person-devices.js";

/** Every room ticket starts with this; no other credential does. */
export const ROOM_TICKET_PREFIX = "synap_rt_";

/** How long a ticket can be claimed after it is made. */
export const ROOM_TICKET_TTL_MS = 60_000;

/** Anything that can run the queries — the pool, or a transaction. */
type Executor = any;

/** Is this string shaped like a room ticket (never a proof it is one)? */
export function isRoomTicket(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.startsWith(ROOM_TICKET_PREFIX) &&
    raw.length > ROOM_TICKET_PREFIX.length
  );
}

/** sha256(ticket), hex — the only form of a ticket that is stored. */
export function hashRoomTicket(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface MintRoomTicketInput {
  userId: string;
  documentId: string;
  access: RoomTicketAccess;
  /** The connection's key that asked: the socket lives no longer than it. */
  apiKeyId: string;
  now?: Date;
}

/** Make a ticket. Expired rows are cleared on the way (nothing else does). */
export async function mintRoomTicket(
  db: Executor,
  input: MintRoomTicketInput
): Promise<{ ticket: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const ticket = `${ROOM_TICKET_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(now.getTime() + ROOM_TICKET_TTL_MS);
  await db
    .delete(realtimeRoomTickets)
    .where(lt(realtimeRoomTickets.expiresAt, now));
  await db.insert(realtimeRoomTickets).values({
    ticketHash: hashRoomTicket(ticket),
    userId: input.userId,
    documentId: input.documentId,
    access: input.access,
    apiKeyId: input.apiKeyId,
    expiresAt,
  });
  return { ticket, expiresAt };
}

/** What an unclaimed, unexpired ticket was made for. */
export interface LiveRoomTicket {
  userId: string;
  documentId: string;
  access: RoomTicketAccess;
}

/** The handshake's look: the ticket's person while it can still be claimed. */
export async function peekRoomTicket(
  db: Executor,
  raw: string,
  now: Date = new Date()
): Promise<LiveRoomTicket | null> {
  if (!isRoomTicket(raw)) return null;
  const [row] = (await db
    .select({
      userId: realtimeRoomTickets.userId,
      documentId: realtimeRoomTickets.documentId,
      access: realtimeRoomTickets.access,
    })
    .from(realtimeRoomTickets)
    .where(
      and(
        eq(realtimeRoomTickets.ticketHash, hashRoomTicket(raw)),
        isNull(realtimeRoomTickets.consumedAt),
        gt(realtimeRoomTickets.expiresAt, now)
      )
    )
    .limit(1)) as LiveRoomTicket[];
  return row ?? null;
}

/** What a claimed ticket admits. */
export interface ClaimedRoomTicket {
  userId: string;
  access: RoomTicketAccess;
  apiKeyId: string;
}

/**
 * The room gate's claim: once, for `documentId` only, before it expires.
 * null = refused (unknown, expired, already claimed, another document).
 */
export async function claimRoomTicket(
  db: Executor,
  raw: string,
  documentId: string,
  now: Date = new Date()
): Promise<ClaimedRoomTicket | null> {
  if (!isRoomTicket(raw)) return null;
  const [row] = (await db
    .update(realtimeRoomTickets)
    .set({ consumedAt: now })
    .where(
      and(
        eq(realtimeRoomTickets.ticketHash, hashRoomTicket(raw)),
        eq(realtimeRoomTickets.documentId, documentId),
        isNull(realtimeRoomTickets.consumedAt),
        gt(realtimeRoomTickets.expiresAt, now)
      )
    )
    .returning({
      userId: realtimeRoomTickets.userId,
      access: realtimeRoomTickets.access,
      apiKeyId: realtimeRoomTickets.apiKeyId,
    })) as ClaimedRoomTicket[];
  return row ?? null;
}

interface KeyRow {
  id: string;
  userId: string;
  keyType: string;
  instanceId: string | null;
  isActive: boolean;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

const keyIsLive = (k: KeyRow, now: Date) =>
  k.isActive &&
  !k.revokedAt &&
  (!k.expiresAt || k.expiresAt.getTime() > now.getTime());

/**
 * Of these connection keys, the ones whose connection still stands: the key
 * itself is live, or — a pod app's person key rotates every hour
 * (`mintPodAppPersonToken` revokes the slot's previous key) — another live
 * `app_person` key holds the same connection slot (person × `instance_id`).
 * Either way the person must still hold access to the pod. A failed read
 * throws: an unanswered question is not "ended".
 */
export async function liveTicketConnections(
  db: Executor,
  apiKeyIds: readonly string[],
  opts: {
    now?: Date;
    /** Does the person still hold access to the pod (tests inject it)? */
    holdsAccess?: (userId: string) => Promise<boolean>;
  } = {}
): Promise<Set<string>> {
  const now = opts.now ?? new Date();
  const holdsAccess =
    opts.holdsAccess ?? ((userId: string) => personHoldsPodAccess(db, userId));
  const live = new Set<string>();
  if (apiKeyIds.length === 0) return live;
  const rows = (await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      keyType: apiKeys.keyType,
      instanceId: apiKeys.instanceId,
      isActive: apiKeys.isActive,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(inArray(apiKeys.id, [...apiKeyIds]))) as KeyRow[];

  const standing = rows.filter((k) => keyIsLive(k, now));
  const rotated = rows.filter(
    (k) =>
      !keyIsLive(k, now) && k.keyType === APP_PERSON_KEY_TYPE && k.instanceId
  );
  if (rotated.length > 0) {
    const successors = (await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        keyType: apiKeys.keyType,
        instanceId: apiKeys.instanceId,
        isActive: apiKeys.isActive,
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.keyType, APP_PERSON_KEY_TYPE),
          eq(apiKeys.isActive, true),
          inArray(apiKeys.instanceId, [
            ...new Set(rotated.map((k) => k.instanceId!)),
          ])
        )
      )) as KeyRow[];
    const slots = new Set(
      successors
        .filter((s) => keyIsLive(s, now))
        .map((s) => `${s.userId}\u0000${s.instanceId}`)
    );
    for (const k of rotated) {
      if (slots.has(`${k.userId}\u0000${k.instanceId}`)) standing.push(k);
    }
  }

  const access = new Map<string, boolean>();
  for (const k of standing) {
    if (!access.has(k.userId)) {
      access.set(k.userId, await holdsAccess(k.userId));
    }
    if (access.get(k.userId)) live.add(k.id);
  }
  return live;
}
