/**
 * DEFERRED WRITES — the writes an agent made past its daily write ceiling.
 *
 * They wait on a HELD-WRITES pack (W-B1, `agent/held_writes`): one proposal
 * per (agent, UTC day), `data.deferredWrites`. Approving it replays each write
 * through its own door AS THE AGENT, so the normal governance ladder decides
 * it (it executes, or files its own proposal). What each replay did is
 * recorded on `data.deferredOutcomes[ref]`.
 *
 * Pure + dependency-free (same contract as `../vocabulary`, the one door its
 * words come through).
 */

import {
  buildObjectActionTitle,
  normalizeObjectKind,
  resolveObjectNoun,
} from "../vocabulary/index.js";
import { proposalsT } from "./copy.js";
import { isItemRejected } from "./item-pack.js";

/**
 * The (subjectType, action) pairs a pack may defer — founder D7, v1. A pair
 * joins this list only with a replay door: the pod's replay table is a
 * `Record` over this union, so a pair without one does not compile.
 */
export const REPLAYABLE_DEFERRED_PAIRS = [
  "entity/create",
  "entity/update",
  "focus_session/create",
  "document/create",
] as const;
export type ReplayableDeferredPair = (typeof REPLAYABLE_DEFERRED_PAIRS)[number];

/** The replayable pair for (subjectType, action), or null when it is not one. */
export function replayableDeferredPair(
  subjectType: string,
  action: string
): ReplayableDeferredPair | null {
  const key = `${subjectType}/${action}`;
  return (REPLAYABLE_DEFERRED_PAIRS as readonly string[]).includes(key)
    ? (key as ReplayableDeferredPair)
    : null;
}

/**
 * The grant that bounded the agent's key when it wrote. The replay runs inside
 * it again, so a deferred write can never reach further than the key could.
 */
export interface DeferredWriteGrant {
  scopes: unknown[];
  clientId: string | null;
}

/** One held write, stored on the pack's `data.deferredWrites`. */
export interface DeferredWrite {
  /** Unique in its pack; the `rejectItem` key and the `deferredOutcomes` key. */
  ref: string;
  subjectType: string;
  action: string;
  /** The payload the door handed the gate, verbatim. */
  data: Record<string, unknown>;
  sessionId: string | null;
  agentUserId: string;
  /** The person the agent wrote for (the gate's `userId`). */
  userId: string;
  /** ISO — when the agent wrote it. */
  at: string;
  /** Identity of the change: a resend of the same write is not queued twice. */
  fingerprint: string;
  /**
   * The space the write was made in. A pack spans spaces, so each write
   * replays in its own.
   */
  workspaceId?: string | null;
  projectId?: string | null;
  reasoning?: string;
  expectedLabel?: string;
  sourceMessageId?: string;
  grant?: DeferredWriteGrant;
}

/** What replaying one deferred write did. */
export const DEFERRED_OUTCOMES = [
  /** The ladder executed it. */
  "applied",
  /** The ladder filed its own proposal (`proposalId`). */
  "proposed",
  /** Its door said no (`reason`). */
  "refused",
  /** The reviewer dropped it before approving the pack. */
  "skipped_by_reviewer",
  /** The pack was rejected, so it never ran. */
  "rejected",
] as const;
export type DeferredOutcome = (typeof DEFERRED_OUTCOMES)[number];

/** One write's outcome, on `data.deferredOutcomes[ref]`. */
export interface StoredDeferredOutcome {
  outcome: DeferredOutcome;
  reason?: string;
  /** `proposed`: the proposal it filed. `applied`: the record it wrote, if any. */
  proposalId?: string;
  id?: string;
  /** ISO. */
  at: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The deferred writes on a pack's `data`. Entries that do not parse
 * are counted in `unreadable`, never dropped silently.
 */
export function readDeferredWrites(data: unknown): {
  writes: DeferredWrite[];
  unreadable: number;
} {
  const raw = asRecord(data)?.deferredWrites;
  if (!Array.isArray(raw)) return { writes: [], unreadable: 0 };
  const writes: DeferredWrite[] = [];
  let unreadable = 0;
  for (const entry of raw as unknown[]) {
    const w = asRecord(entry);
    if (
      w &&
      typeof w.ref === "string" &&
      typeof w.subjectType === "string" &&
      typeof w.action === "string" &&
      asRecord(w.data) &&
      typeof w.agentUserId === "string" &&
      typeof w.userId === "string" &&
      typeof w.at === "string"
    ) {
      writes.push(w as unknown as DeferredWrite);
    } else {
      unreadable++;
    }
  }
  return { writes, unreadable };
}

/** Outcomes recorded so far, keyed by ref. Unparseable entries read as none. */
export function readDeferredOutcomes(
  data: unknown
): Record<string, StoredDeferredOutcome> {
  const raw = asRecord(asRecord(data)?.deferredOutcomes);
  const out: Record<string, StoredDeferredOutcome> = {};
  for (const [ref, value] of Object.entries(raw ?? {})) {
    const o = asRecord(value);
    if (
      o &&
      typeof o.outcome === "string" &&
      (DEFERRED_OUTCOMES as readonly string[]).includes(o.outcome) &&
      typeof o.at === "string"
    ) {
      out[ref] = o as unknown as StoredDeferredOutcome;
    }
  }
  return out;
}

// ── Reading the writes (every review surface) ───────────────────────────────

/** One kept write, as a reviewer reads it. */
export interface DeferredWriteRow {
  ref: string;
  /**
   * `Create Task "Ship v2"` — what replaying it DOES (imperative), through the
   * one title door (`buildObjectActionTitle`).
   */
  title: string;
  /** The door the write goes through (`entity`, `focus_session`, `document`). */
  subjectType: string;
  /** The kind it writes: the entity's profile, else the door's subject. */
  kind: string;
  /** Its own name, or the kind's noun when it carries none — never empty. */
  name: string;
  /** The object kind of the record it writes (`focus_session` → `session`). */
  objectKind: string;
  /**
   * The record it writes or changes, when known: the stored outcome's id (what
   * the replay wrote), else the payload's own id (an update's target, a
   * create's minted id).
   */
  recordId: string | null;
  /** The reviewer left it out before approving (`dispositions[ref]`). */
  leftOut: boolean;
  /** What replaying it did; null until the proposal is decided. */
  outcome: StoredDeferredOutcome | null;
}

export interface DeferredWritesReview {
  /** Every readable write, in the order the agent made it. */
  rows: DeferredWriteRow[];
  /** Entries that did not parse — counted and said, never dropped silently. */
  unreadable: number;
  /** `rows.length + unreadable`: every entry the proposal holds. */
  total: number;
}

function nameOf(data: Record<string, unknown>): string | null {
  for (const key of ["title", "name", "goal"]) {
    const v = data[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * THE reading of a held-writes pack's kept writes: one row per write, titled with what replaying it does, beside the
 * outcome its replay recorded. `data` is the proposal row's `data`. Null when
 * it carries no `deferredWrites` at all — there is nothing to list.
 *
 * synap-app's `deriveDeferredWritesReview` (hooks `proposal-types/itemPack.ts`)
 * is the same reading, written before this one; it moves onto this.
 */
export function deriveDeferredWritesReview(
  data: unknown
): DeferredWritesReview | null {
  if (!Array.isArray(asRecord(data)?.deferredWrites)) return null;
  const { writes, unreadable } = readDeferredWrites(data);
  const outcomes = readDeferredOutcomes(data);
  const rows = writes.map((w): DeferredWriteRow => {
    const kind =
      (typeof w.data.profileSlug === "string" && w.data.profileSlug.trim()) ||
      w.subjectType;
    const name = nameOf(w.data);
    const stored = outcomes[w.ref] ?? null;
    const payloadId = typeof w.data.id === "string" ? w.data.id : null;
    return {
      ref: w.ref,
      title: buildObjectActionTitle({
        action: w.action,
        objectKind: kind,
        objectName: name,
        mood: "imperative",
      }),
      subjectType: w.subjectType,
      kind,
      name: name ?? resolveObjectNoun(kind),
      objectKind: normalizeObjectKind(w.subjectType),
      recordId: stored?.id ?? payloadId,
      leftOut: isItemRejected(data, w.ref),
      outcome: stored,
    };
  });
  return { rows, unreadable, total: rows.length + unreadable };
}

// ── The held-writes pack (W-B1) ─────────────────────────────────────────────

/**
 * Past its daily write ceiling an agent's replayable writes are kept on ONE
 * pending proposal per (agent, UTC day): `agent/held_writes`, `targetId` = the
 * agent. The pod files it with these (`permission-check.ts`).
 */
export const HELD_WRITES_TARGET_TYPE = "agent";
export const HELD_WRITES_PROPOSAL_TYPE = "held_writes";

/** The proposal fields the describer reads — any proposal row satisfies it. */
export interface HeldWritesProposalLike {
  targetType?: string | null;
  proposalType?: string | null;
  /** The pod-resolved target name (the agent), when it resolved one. */
  targetName?: string | null;
  /** The agent's display name (`agentActorName` on the read doors). */
  agentName?: string | null;
  data?: unknown;
}

export interface HeldWritesSummary {
  /** The agent's name, or null when the pod resolved none. */
  agentName: string | null;
  /** "Writes held for review: Claude Code, 2026-10-27, 12 items". */
  title: string;
  /** The writes it holds, readable or not. */
  writes: number;
}

export function isHeldWritesProposal(p: HeldWritesProposalLike): boolean {
  return (
    p.targetType === HELD_WRITES_TARGET_TYPE &&
    p.proposalType === HELD_WRITES_PROPOSAL_TYPE
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A name to show for the agent: never an id, never the kind's own noun. */
function agentNameOf(raw: string | null | undefined): string | null {
  const name = (raw ?? "").trim();
  if (!name || UUID.test(name)) return null;
  if (name.toLowerCase() === resolveObjectNoun("agent").toLowerCase()) {
    return null;
  }
  return name;
}

/**
 * The NAME of a held-writes pack, read off its own `data` (`fileHeldWrites`
 * stores `agentName` and `day`): "Claude Code, 2026-10-27, 12 items". The
 * count is the writes it holds NOW (read, never stored), so it never goes
 * stale as writes join. Undefined when `data` is not a pack's. The title door
 * (`buildObjectActionTitle`, action `held_writes`) leads it with "Writes held
 * for review:"; every door that titles a proposal from its data reaches it
 * through the pod's `extractProposalName`.
 */
export function heldWritesPackName(
  data: unknown,
  agentName?: string | null
): string | undefined {
  const d = asRecord(data);
  if (
    !d ||
    typeof d.day !== "string" ||
    typeof d.agentUserId !== "string" ||
    !Array.isArray(d.deferredWrites)
  ) {
    return undefined;
  }
  const name =
    agentNameOf(agentName) ??
    agentNameOf(typeof d.agentName === "string" ? d.agentName : null);
  const total = deriveDeferredWritesReview(d)?.total ?? 0;
  return [
    name,
    d.day.trim() || null,
    proposalsT()("proposals.heldWrites.items", { n: total }),
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The heading of a held-writes pack, through the one title door — or null
 * when the row is not one (a caller then keeps its generic title).
 */
export function describeHeldWritesProposal(
  p: HeldWritesProposalLike
): HeldWritesSummary | null {
  if (!isHeldWritesProposal(p)) return null;
  const agentName =
    agentNameOf(p.targetName) ??
    agentNameOf(p.agentName) ??
    agentNameOf(
      typeof asRecord(p.data)?.agentName === "string"
        ? (asRecord(p.data)!.agentName as string)
        : null
    );
  return {
    agentName,
    title: buildObjectActionTitle({
      action: HELD_WRITES_PROPOSAL_TYPE,
      objectKind: HELD_WRITES_TARGET_TYPE,
      objectName: heldWritesPackName(p.data, agentName),
    }),
    writes: deriveDeferredWritesReview(p.data)?.total ?? 0,
  };
}
