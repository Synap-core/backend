/**
 * THE LEAN SESSION READ (C8, plan d679e92c). `get_session` is ~39 KB (~10k
 * tokens) and the bridge asks for it on every wake; most of it is sections a
 * wake never reads (siblings, prior stages, run manifest, 20 deploys of OTHER
 * sessions). `detail: 'lean'` answers what a wake needs and nothing else:
 *
 *   - the session's identity and status,
 *   - its outcomes (key, label, kind, met, state) and the inputs it waits on,
 *   - the next move,
 *   - what is asked of the person (owed slots, pending proposals, open room
 *     questions),
 *   - its work units (PRs, branches),
 *   - the room: the last {@link LEAN_ROOM_LAST} messages, and the UNREAD ones
 *     (the open posts other sessions addressed to it),
 *   - its gates, with ONLY this session's own deploys.
 *
 * It is a PROJECTION of the packet the three doors already build (tRPC
 * `focusSessions.get`, Hub `GET /focus-sessions/:id`, MCP `synap_get_session`),
 * so the doors share one rule and one shape; each door passes
 * `ownerDeploys: 'own'` to the packet so the foreign deploys are never read.
 * Another session's deploys are one call away: `detail: 'deploys'`
 * ({@link readDeployGate}), by commit.
 *
 * A section that failed stays `{status:'unavailable'}` — lean never turns a
 * failed read into an empty one.
 */

import type { SessionOutcomesSection } from "./session-outputs.js";
import type { ContinuationPacket } from "./continuation-packet.js";
import type { PacketRoomSection } from "./room-messages.js";
import type { PacketInboxSection } from "./session-inbox.js";

/** The room messages a lean read carries (newest first). */
export const LEAN_ROOM_LAST = 3;

/** The values of the `detail` argument the three session-read doors accept. */
export const SESSION_READ_DETAILS = ["full", "lean", "deploys"] as const;
export type SessionReadDetail = (typeof SESSION_READ_DETAILS)[number];

/** `undefined` ⇒ `full` (today's read, so no caller breaks); off-enum ⇒ `null`. */
export function parseSessionReadDetail(raw: unknown): SessionReadDetail | null {
  if (raw === undefined || raw === null || raw === "") return "full";
  return (SESSION_READ_DETAILS as readonly unknown[]).includes(raw)
    ? (raw as SessionReadDetail)
    : null;
}

/** What to say for an off-enum `detail`. */
export const SESSION_READ_DETAIL_ERROR = (raw: unknown): string =>
  `Unknown detail '${String(raw)}'. Valid values: ${SESSION_READ_DETAILS.join(", ")} (default full).`;

export interface LeanRoomMessage {
  id: string;
  at: string;
  author: string;
  isPerson: boolean;
  /** The message, fenced as untrusted data (the plain `text` is not repeated). */
  fenced: string;
  truncated: boolean;
}

export type LeanRoomSection =
  | {
      status: "ok";
      channelId: string | null;
      /** The newest {@link LEAN_ROOM_LAST}, newest first. */
      last: LeanRoomMessage[];
      hasMore: boolean;
      cursor: string | null;
      /** Open posts other sessions addressed to this one: exact count. */
      unread: number;
      /** Those posts, oldest first, fenced. `null` when the inbox failed. */
      unreadItems: Array<{
        id: string;
        at: string;
        intent: string;
        fromSessionId: string | null;
        fenced: string;
        truncated: boolean;
      }> | null;
    }
  | { status: "unavailable"; reason: string };

function leanRoom(
  room: PacketRoomSection,
  inbox: PacketInboxSection
): LeanRoomSection {
  if (room.status === "unavailable") return room;
  return {
    status: "ok",
    channelId: room.channelId,
    last: room.items.slice(0, LEAN_ROOM_LAST).map((m) => ({
      id: m.id,
      at: m.at,
      author: m.author,
      isPerson: m.isPerson,
      fenced: m.fenced,
      truncated: m.truncated,
    })),
    hasMore: room.hasMore || room.items.length > LEAN_ROOM_LAST,
    cursor: room.cursor,
    unread: inbox.status === "ok" ? inbox.total : 0,
    unreadItems:
      inbox.status === "ok"
        ? inbox.items.map((i) => ({
            id: i.id,
            at: i.at,
            intent: i.intent,
            fromSessionId: i.from.sessionId,
            fenced: i.fenced,
            truncated: i.truncated,
          }))
        : null,
  };
}

export interface LeanContinuation {
  version: 1;
  detail: "lean";
  session: ContinuationPacket["session"];
  nextMove: ContinuationPacket["nextMove"];
  userMustDecide: ContinuationPacket["userMustDecide"];
  openRoomQuestions: ContinuationPacket["openRoomQuestions"];
  blockedBy: ContinuationPacket["blockedBy"];
  waitingOn: ContinuationPacket["waitingOn"];
  workUnits: ContinuationPacket["workUnits"];
  room: LeanRoomSection;
  /** `ownerDeploys` holds THIS session's deploys only (`detail: 'deploys'` reads the rest). */
  gates: ContinuationPacket["gates"];
  live: ContinuationPacket["live"];
}

/** The lean projection of a packet built with `ownerDeploys: 'own'`. */
export function projectLeanContinuation(
  packet: ContinuationPacket
): LeanContinuation {
  return {
    version: 1,
    detail: "lean",
    session: packet.session,
    nextMove: packet.nextMove,
    userMustDecide: packet.userMustDecide,
    openRoomQuestions: packet.openRoomQuestions,
    blockedBy: packet.blockedBy,
    waitingOn: packet.waitingOn,
    workUnits: packet.workUnits,
    room: leanRoom(packet.room, packet.inbox),
    gates: packet.gates,
    live: packet.live,
  };
}

export type LeanOutcomesSection =
  | {
      status: "ok";
      counts: { met: number; total: number };
      outcomes: Array<{
        key: string;
        label: string;
        kind: string;
        met: boolean;
        state: string;
      }>;
      inputs: Array<{
        key: string;
        label: string;
        need: string;
        open: boolean;
        answered: boolean;
        blocksOutcomeKey: string | null;
        why?: string;
        owedSince?: string;
        slotLabel: string;
      }>;
    }
  | { status: "unavailable"; reason: string };

/** Outcomes without their evidence, marks or ask payloads. */
export function projectLeanOutcomes(
  section: SessionOutcomesSection
): LeanOutcomesSection {
  if (section.status === "unavailable") return section;
  return {
    status: "ok",
    counts: section.counts,
    outcomes: section.outcomes.map((o) => ({
      key: o.key,
      label: o.label,
      kind: o.kind,
      met: o.met,
      state: o.state.state,
    })),
    inputs: section.inputs.map((i) => ({
      key: i.key,
      label: i.label,
      need: i.need,
      open: i.open,
      answered: i.answered,
      blocksOutcomeKey: i.blocksOutcomeKey,
      ...(i.why ? { why: i.why } : {}),
      ...(i.owedSince ? { owedSince: i.owedSince } : {}),
      slotLabel: i.slotLabel,
    })),
  };
}

type SessionRowLike = Parameters<
  typeof import("./continuation-packet.js").projectContinuationPacket
>[0];
type Database = typeof import("@synap/database").db;

/**
 * The lean read of a session row the door already loaded under its floor:
 * the packet WITHOUT the owner's other deploys, projected, plus the lean
 * outcomes. One function for the three doors, so they cannot disagree.
 */
export async function readLeanSession(
  row: SessionRowLike,
  ctx: { userId: string; roster?: boolean; database?: Database }
): Promise<{
  continuation: LeanContinuation;
  outcomes: LeanOutcomesSection;
}> {
  const [
    { projectContinuationPacket },
    { readSessionOutcomesSection },
    { db },
  ] = await Promise.all([
    import("./continuation-packet.js"),
    import("./session-outputs.js"),
    import("@synap/database"),
  ]);
  const database = ctx.database ?? db;
  const [packet, outcomes] = await Promise.all([
    projectContinuationPacket(row, {
      database,
      userId: ctx.userId,
      roster: ctx.roster,
      ownerDeploys: "own",
    }),
    readSessionOutcomesSection({
      db: database,
      userId: ctx.userId,
      sessionId: row.id,
    }),
  ]);
  return {
    continuation: projectLeanContinuation(packet),
    outcomes: projectLeanOutcomes(outcomes),
  };
}

/**
 * `detail: 'deploys'`: the deploys a person approved on ANY of the owner's
 * sessions (last 14 days, newest first, at most 20), optionally only those
 * whose commit starts with `commitSha`. Owner only: a room member gets `[]`.
 * A failed read is `unavailable`, never an empty list.
 */
export async function readSessionDeploys(
  row: { id: string; userId: string },
  ctx: { userId: string; commitSha?: string; database?: Database }
): Promise<
  | {
      status: "ok";
      detail: "deploys";
      sessionId: string;
      commitSha: string | null;
      deploys: import("./session-gates.js").PacketDeployApproval[];
    }
  | { status: "unavailable"; detail: "deploys"; reason: string }
> {
  const [{ readDeployGate }, { db }] = await Promise.all([
    import("./session-gates.js"),
    import("@synap/database"),
  ]);
  try {
    const deploys = await readDeployGate(ctx.database ?? db, row, ctx.userId, {
      commitSha: ctx.commitSha,
    });
    return {
      status: "ok",
      detail: "deploys",
      sessionId: row.id,
      commitSha: ctx.commitSha ?? null,
      deploys,
    };
  } catch {
    return {
      status: "unavailable",
      detail: "deploys",
      reason:
        "The deploys approved on this owner's sessions could not be read.",
    };
  }
}
