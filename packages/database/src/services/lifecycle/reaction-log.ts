/**
 * THE REACTION LOG (reactions W2) — what each rule did with each move it
 * matched: applied it, proposed it, or skipped it, and why. One `events` row
 * per outcome, under the rule (`subject_type = 'reaction'`, `subject_id` = the
 * rule's id), owned by the person whose thing moved.
 *
 * WHY `events`, written raw: it is the pod's history spine, and the history
 * rows the slot doors write (`focus_session.slot_asked`, `…slot_attested`, the
 * api `logEvent`) take the same path: an append with no fan-out. A reaction's
 * outcome is history, not a change: it must not reach webhooks, rules or Hub
 * SSE (a new external event type), and the moves it applied already carry
 * their own transition with a `cause`. `automation_runs` (the matcher's log)
 * cannot hold it: every row there names an automation, and a built-in rule
 * has none.
 *
 * Prior art (HubSpot's action log, Jira's per-rule audit): a skipped reaction
 * is logged WITH its reason (paused, loop guard, chain, conflict, moved
 * meanwhile), so "why did nothing happen" has an answer.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema/index.js";
import { events } from "../../schema/events.js";

type Db = PostgresJsDatabase<typeof schema>;

/** The `events.subject_type` of a reaction's log row. */
export const REACTION_LOG_SUBJECT_TYPE = "reaction";

/** What a rule did with one move it matched. */
export const REACTION_OUTCOMES = ["applied", "proposed", "skipped"] as const;
export type ReactionOutcome = (typeof REACTION_OUTCOMES)[number];

/** `reaction.applied` / `reaction.proposed` / `reaction.skipped`. */
export function reactionLogEventType(outcome: ReactionOutcome): string {
  return `reaction.${outcome}`;
}

export interface ReactionLogEntry {
  reactionId: string;
  outcome: ReactionOutcome;
  /** Why it was skipped (a stable code), or what it did. */
  code: string;
  /** The same, in plain words. */
  reason: string;
  /** The person whose thing moved (the log's owner). */
  userId: string;
  /** The move that fired it; null when a fact fired it (a merged PR). */
  sourceTransitionId: string | null;
  /** What moved, for a reader: `<subjectType>:<subjectId>`, or the fact. */
  source: string;
  /** What it would move or moved: `<subjectType>:<subjectId>`. */
  target: string | null;
  /** The status it would move it to. */
  to: string | null;
  chainId: string | null;
  depth: number | null;
  proposalId?: string | null;
  sessionId?: string | null;
  workspaceId?: string | null;
}

/** Append the outcomes, one row each. Never fans out (see the header). */
export async function recordReactionOutcomes(
  db: Pick<Db, "insert">,
  entries: readonly ReactionLogEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  await db.insert(events).values(
    entries.map((e) => ({
      id: randomUUID(),
      type: reactionLogEventType(e.outcome),
      subjectType: REACTION_LOG_SUBJECT_TYPE,
      subjectId: e.reactionId,
      userId: e.userId,
      source: "system",
      data: {
        reactionId: e.reactionId,
        outcome: e.outcome,
        code: e.code,
        reason: e.reason,
        sourceTransitionId: e.sourceTransitionId,
        source: e.source,
        target: e.target,
        to: e.to,
        chainId: e.chainId,
        depth: e.depth,
        ...(e.proposalId ? { proposalId: e.proposalId } : {}),
      },
      proposalId: e.proposalId ?? null,
      sessionId: e.sessionId ?? null,
      workspaceId: e.workspaceId ?? null,
    }))
  );
}

/** One logged outcome, as a reader sees it (newest first). */
export interface ReactionLogRow extends Omit<ReactionLogEntry, "userId"> {
  at: string;
}

/**
 * A person's reaction log: what their rules did, newest first. Owner-floored
 * (`events.user_id`); narrowed to some rules when `reactionIds` is given.
 */
export async function listReactionOutcomes(
  db: Db,
  input: { userId: string; reactionIds?: readonly string[]; limit?: number }
): Promise<ReactionLogRow[]> {
  const rows = await db
    .select({ data: events.data, at: events.timestamp })
    .from(events)
    .where(
      and(
        eq(events.subjectType, REACTION_LOG_SUBJECT_TYPE),
        eq(events.userId, input.userId),
        input.reactionIds && input.reactionIds.length > 0
          ? inArray(events.subjectId, [...input.reactionIds])
          : undefined
      )
    )
    .orderBy(desc(events.timestamp))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return {
      reactionId: str(d.reactionId) ?? "",
      outcome: (str(d.outcome) ?? "skipped") as ReactionOutcome,
      code: str(d.code) ?? "",
      reason: str(d.reason) ?? "",
      sourceTransitionId: str(d.sourceTransitionId),
      source: str(d.source) ?? "",
      target: str(d.target),
      to: str(d.to),
      chainId: str(d.chainId),
      depth: typeof d.depth === "number" ? d.depth : null,
      proposalId: str(d.proposalId),
      at: (r.at instanceof Date ? r.at : new Date(r.at)).toISOString(),
    };
  });
}
