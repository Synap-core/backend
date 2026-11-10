/**
 * THE LEAN SESSION READ (C8, plan d679e92c). `get_session` is ~39 KB (~10k
 * tokens) and the bridge asks for it on every wake; most of it is sections a
 * wake never reads (siblings, prior stages, run manifest, 20 deploys of OTHER
 * sessions). `detail: 'lean'` answers what a wake needs and nothing else:
 *
 *   - the session's identity and status,
 *   - its outcomes (key, label, kind, owner, met, retired, state) and the
 *     inputs it waits on,
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
import { readRunCost, type RunCostRead } from "../runs/run-cost.js";
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
        /** Whose it is: a person's slot is never an agent's to claim. */
        owner: "agent" | "human";
        met: boolean;
        /** Withdrawn: owed by no one, never claimed. */
        retired: boolean;
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
      owner: o.owner,
      met: o.met,
      retired: o.retired,
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

/** The longest goal, label or param value a lean session header carries. */
export const LEAN_HEADER_TEXT_MAX = 300;
/** The most declared outputs, stages, or one stage's outputs it carries. */
export const LEAN_HEADER_LIST_MAX = 30;

const clip = (v: unknown, max = LEAN_HEADER_TEXT_MAX): unknown =>
  typeof v === "string" && v.length > max ? `${v.slice(0, max - 1)}…` : v;
const listOf = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v
        .filter(
          (x): x is Record<string, unknown> => !!x && typeof x === "object"
        )
        .slice(0, LEAN_HEADER_LIST_MAX)
    : [];
const outputsOf = (v: unknown) =>
  listOf(v).map((o) => ({
    key: o.key,
    label: clip(o.label),
    kind: o.kind,
    ...(o.owner ? { owner: o.owner } : {}),
  }));

/**
 * The session itself as a LEAN read carries it on the MCP door: who it is,
 * what it follows, what it declares it will produce (keys, labels, kinds) and
 * its run's params, each text clipped and each list capped. Never the long
 * columns (stages' goals and criteria, `metadata.prompt`, `metadata.runTurns`,
 * criteria): those made a lean read 18,987 characters (finding 69fdd2e6),
 * over the reply cap. A worker reads how to run a session from these fields
 * (`playbookId`, `metadata.params`, the declared outputs' kinds); the full
 * read (`detail: 'full'`) still has the rest.
 */
export function projectLeanSessionHeader(row: {
  id: string;
  title?: string | null;
  goal?: string | null;
  status?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  trackId?: string | null;
  channelId?: string | null;
  playbookId?: string | null;
  currentStage?: string | null;
  subjectEntityId?: string | null;
  parentSessionId?: string | null;
  updatedAt?: Date | string | null;
  expectedOutputs?: unknown;
  stages?: unknown;
  metadata?: unknown;
}): Record<string, unknown> {
  const meta =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {};
  const rawParams =
    meta.params &&
    typeof meta.params === "object" &&
    !Array.isArray(meta.params)
      ? (meta.params as Record<string, unknown>)
      : null;
  const params = rawParams
    ? Object.fromEntries(
        Object.entries(rawParams)
          .slice(0, LEAN_HEADER_LIST_MAX)
          .map(([k, v]) => [
            k,
            Array.isArray(v)
              ? v.slice(0, LEAN_HEADER_LIST_MAX).map((x) => clip(x))
              : v && typeof v === "object"
                ? clip(JSON.stringify(v))
                : clip(v),
          ])
      )
    : null;
  return {
    id: row.id,
    title: row.title ?? null,
    goal: clip(row.goal ?? null),
    status: row.status ?? null,
    workspaceId: row.workspaceId ?? null,
    projectId: row.projectId ?? null,
    trackId: row.trackId ?? null,
    channelId: row.channelId ?? null,
    playbookId: row.playbookId ?? null,
    currentStage: row.currentStage ?? null,
    subjectEntityId: row.subjectEntityId ?? null,
    parentSessionId: row.parentSessionId ?? null,
    updatedAt: row.updatedAt ?? null,
    expectedOutputs: outputsOf(row.expectedOutputs),
    stages: listOf(row.stages).map((st) => ({
      key: st.key,
      name: clip(st.name),
      expectedOutputs: outputsOf(st.expectedOutputs),
    })),
    metadata: params ? { params } : {},
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
  /** What the session's latest run spent (`readRunCost`); null = no run turn. */
  cost: RunCostRead | null;
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
    cost: readRunCost(row.metadata),
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
