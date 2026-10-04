/**
 * SESSION ACTIVITY — the wire shape of "what agents did in this session".
 *
 * Produced by ONE pod read (`loadSessionActivity`, served as
 * `focusSessions.activity` and inside `runs.get` for session / playbook runs)
 * and consumed by ONE derivation (`deriveRunActivity`, ./derive.ts). Declared
 * here, beside the derivation, so the pod, the browser and relay type the same
 * contract instead of three structural copies of it.
 *
 * Plan ≠ Activity. A session's PLAN (`StepItem`, session-continuation) is what
 * the agent INTENDS; this is the RECORD of what was done. They are separate
 * sections and are never merged.
 */

/**
 * The kinds of activity a session records. Linear's five activity types map
 * onto these (action → tool/write, elicitation → ask, response → note,
 * error → error, plus our governed `decision` and the `lifecycle` bookends).
 */
export const ACTIVITY_KINDS = [
  "tool",
  "write",
  "decision",
  "ask",
  "note",
  "error",
  "lifecycle",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * The independent sub-reads the activity is merged from. A source that could
 * not be read is NAMED in `unreadable` — never folded into "nothing happened".
 */
export const ACTIVITY_SOURCES = [
  "turns",
  "events",
  "proposals",
  "asks",
  "notes",
] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/**
 * A step's settled outcome, as the pod recorded it. `running` exists only on a
 * tool call whose result has not arrived; `pending` only on an undecided
 * decision or an open ask.
 */
export type ActivityItemStatus =
  "running" | "done" | "failed" | "pending" | "approved" | "rejected";

/** Who acted. `null` on the item when the ledger recorded nobody. */
export interface ActivityActor {
  id: string;
  /** Display name where resolvable; null when the id names no user row. */
  name: string | null;
  isAgent: boolean;
}

export interface SessionActivityItem {
  /** Stable across polls — a row key, never an address. */
  id: string;
  /** When it happened. A `Date` over superjson, an ISO string over plain JSON. */
  at: Date | string;
  kind: ActivityKind;
  status: ActivityItemStatus | null;
  /**
   * The IS turn this step ran in (tool / error steps). A turn boundary is a
   * grouping boundary, so it travels on the item.
   */
  turnId: string | null;
  /**
   * The machine verb: a tool name (`tool`), an action token (`write`:
   * `create`; `lifecycle`: `close`), a proposal type (`decision`).
   */
  action: string | null;
  /** The kind of object acted on (a profile slug, a subject type). */
  objectKind: string | null;
  /** The object acted on — present only when the ledger named one. */
  objectId: string | null;
  objectTitle: string | null;
  /**
   * A producer-authored, already-friendly label (an IS tool step's title, an
   * ask's slot label, a note's first line). Preferred over a derived one.
   */
  title: string | null;
  /** The error line, on a failed step. */
  error: string | null;
  /** The proposal behind a decision, or the receipt behind a governed write. */
  proposalId: string | null;
  actor: ActivityActor | null;
}

export interface SessionActivityLive {
  /**
   * An IS turn is running in this session's room RIGHT NOW (a `chat_turns`
   * row with status `running`). A recorded fact, never inferred from the
   * session's status — "active" is a lifecycle, not "an agent is working".
   */
  turnInFlight: boolean;
  /** When the in-flight turn started; null when none is in flight. */
  since: Date | string | null;
  /** The newest activity `at`; null when nothing has happened yet. */
  lastAt: Date | string | null;
}

export interface SessionActivityWire {
  sessionId: string;
  /** Oldest first. Capped by the pod; see `truncated`. */
  items: SessionActivityItem[];
  /** More activity exists than `items` carries (the pod capped the merge). */
  truncated: boolean;
  /** The session is closed / cancelled — its activity is a record. */
  terminal: boolean;
  live: SessionActivityLive;
  /** Sub-reads that FAILED. Non-empty ⇒ the list is partial, never "complete". */
  unreadable: ActivitySource[];
}
