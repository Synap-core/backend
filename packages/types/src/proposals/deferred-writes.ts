/**
 * DEFERRED WRITES — the writes an agent made into a space it had not joined.
 *
 * An agent that is not a member of a workspace does not write there: the gate
 * files ONE `workspace.join` proposal instead. A write whose (subjectType,
 * action) pair is REPLAYABLE is not dropped: it is appended to that join's
 * `data.deferredWrites`, also when the join already exists (every later write
 * lands on the same pending join). Approving the join creates the membership
 * and then replays each write through its own door AS THE AGENT, so the normal
 * governance ladder decides it (it executes, or files its own proposal) —
 * approving access never approves content. What each replay did is recorded
 * on `data.deferredOutcomes[ref]`.
 *
 * Pure + dependency-free (same contract as `../vocabulary`).
 */

/** Writes one join may hold. The next one is refused, in words. */
export const DEFERRED_WRITES_MAX = 50;

/**
 * The (subjectType, action) pairs a join may defer — founder D7, v1. A pair
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

/** One blocked write, stored on the join proposal's `data.deferredWrites`. */
export interface DeferredWrite {
  /** Unique in its join; the `rejectItem` key and the `deferredOutcomes` key. */
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
  /** The reviewer dropped it before approving the join. */
  "skipped_by_reviewer",
  /** The join was rejected, so it never ran. */
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
 * The deferred writes on a join proposal's `data`. Entries that do not parse
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
