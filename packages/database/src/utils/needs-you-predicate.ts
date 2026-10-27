/**
 * THE needs-you rule in SQL — the twin of `classifyOwedAsk`
 * (`@synap-core/types/needs-you/rule`, decision E, founder 2026-10-27).
 *
 * It lives HERE, beside the owed-slot predicate, for the same reason that one
 * does: `@synap/jobs` (the reapers) cannot import `@synap/api`, and a count
 * must not load rows. Every constant it reads (the 7-day clocks, the working
 * window, the asker causes, the stamp pattern) is IMPORTED from the rule, never
 * restated; the clauses mirror the rule's order. The PGlite parity test
 * (`needs-you-predicate.parity.pglite.test.ts`) runs every fixture — the
 * session's real room, turns, proposals and events included — through both
 * twins and fails on any row where they disagree.
 *
 * "Last agent activity" is measured from agent EVIDENCE only, never
 * `focus_sessions.updated_at` (any unrelated write moves it):
 *   - an agent post in the session's room (`messages`, `ai_agent`);
 *   - a chat turn in that room (`chat_turns.updated_at`, moved on every frame);
 *   - a proposal an agent filed under the session (`proposals.agent_user_id`);
 *   - an agent-attributed event on the session (`events.agent_user_id`), which
 *     is where an agent's `slot_asked` lands when it asks without posting.
 *
 * Two choices keep the twins EXACT (see the rule's header): `owedSince` is
 * compared as text, `COLLATE "C"`, only in the canonical `toISOString()` form
 * (no cast that a malformed stamp could make throw), and JSON fields are read
 * by their JSON type, never by truthiness.
 */

import { sql as drizzleSql, type SQL } from "drizzle-orm";
import {
  ISO_STAMP_PATTERN,
  NEEDS_YOU_ASKER_CAUSES,
  NEEDS_YOU_REVIEW_LATER_AFTER_MS,
  NEEDS_YOU_STOPPED_AFTER_MS,
  NEEDS_YOU_WORKING_WINDOW_MS,
} from "@synap-core/types/needs-you/rule";
import { MessageAuthorType } from "../schema/messages.js";
import {
  OPEN_SESSION_STATUSES,
  owedSlotPredicateSql,
} from "./owed-slot-predicate.js";
import { awaitedGatePendingIn } from "./awaited-gate-wait.js";

function literals(values: readonly string[]): SQL {
  return drizzleSql.raw(values.map((v) => `'${v}'`).join(", "));
}

const OPEN_STATUSES = literals(OPEN_SESSION_STATUSES);
const ASKER_CAUSES = literals(NEEDS_YOU_ASKER_CAUSES);

/** A session alias the caller's FROM names (`focus_sessions`, `owing`, …). */
function col(alias: string, column: string): SQL {
  return drizzleSql.raw(`${alias}.${column}`);
}

function at(ms: number): SQL {
  return drizzleSql`${new Date(ms).toISOString()}::timestamptz`;
}

/**
 * SQL timestamptz: the newest agent evidence on the session aliased `s`, or
 * NULL when there is none (`GREATEST` skips NULLs).
 */
export function sessionLastAgentActivitySql(s: string): SQL {
  return drizzleSql`GREATEST(
    (SELECT max(ny_m.timestamp) FROM messages ny_m
       WHERE ny_m.channel_id = ${col(s, "channel_id")}
         AND ny_m.author_type = ${MessageAuthorType.AI_AGENT}),
    (SELECT max(ny_t.updated_at) FROM chat_turns ny_t
       WHERE ny_t.channel_id = ${col(s, "channel_id")}),
    (SELECT max(ny_p.created_at) FROM proposals ny_p
       WHERE ny_p.session_id = ${col(s, "id")}
         AND ny_p.agent_user_id IS NOT NULL),
    (SELECT max(ny_e.timestamp) FROM events ny_e
       WHERE ny_e.session_id = ${col(s, "id")}
         AND ny_e.agent_user_id IS NOT NULL)
  )`;
}

/** SQL boolean: an IS turn is running in the room of the session aliased `s`. */
export function sessionTurnInFlightSql(s: string): SQL {
  return drizzleSql`EXISTS (
    SELECT 1 FROM chat_turns ny_run
    WHERE ny_run.channel_id = ${col(s, "channel_id")}
      AND ny_run.status = 'running'
  )`;
}

/**
 * SQL text: `needsYouSessionClass` — `'stopped' | 'working' | 'live'` for the
 * session aliased `s`, at `now`. The agent evidence is measured ONCE.
 */
export function needsYouSessionClassSql(s: string, now: Date): SQL {
  const t = now.getTime();
  return drizzleSql`(SELECT CASE
      WHEN ${col(s, "status")} NOT IN (${OPEN_STATUSES}) THEN 'stopped'
      -- No readable clock at all (NULL) is never stopped: fails toward keeping.
      WHEN GREATEST(ny_la.at, ${col(s, "started_at")}) < ${at(t - NEEDS_YOU_STOPPED_AFTER_MS)}
        THEN 'stopped'
      WHEN ${sessionTurnInFlightSql(s)} THEN 'working'
      WHEN ny_la.at >= ${at(t - NEEDS_YOU_WORKING_WINDOW_MS)} THEN 'working'
      ELSE 'live'
    END FROM (SELECT ${sessionLastAgentActivitySql(s)} AS at) ny_la)`;
}

/** SQL text: the cause kind on `slot` (`needsYouAskCauseKind`), or NULL. */
function causeKindSql(): SQL {
  return drizzleSql.raw(`(CASE
      WHEN jsonb_typeof(slot->'askCause'->'kind') = 'string' THEN slot->'askCause'->>'kind'
      WHEN jsonb_typeof(slot->'criterionKey') = 'string' AND slot->>'criterionKey' <> '' THEN 'criterion'
      WHEN jsonb_typeof(slot->'paramName') = 'string' AND slot->>'paramName' <> '' THEN 'param'
    END)`);
}

/**
 * SQL boolean: `needsYouHasRealAsker`. Never NULL: a JSON field that is
 * absent makes its comparison NULL, and `NOT NULL` is NULL, which a CASE
 * reads as "no" — the three-valued trap the parity test caught (a decision
 * ask with no asker read as asked).
 */
function realAskerSql(): SQL {
  const cause = causeKindSql();
  return drizzleSql`coalesce(${cause} IS NULL
      OR ${cause} IN (${ASKER_CAUSES})
      OR (${cause} = 'decision'
          AND jsonb_typeof(slot->'askedBy') = 'string'
          AND slot->>'askedBy' <> ''), false)`;
}

/** SQL boolean: `needsYouIsCommitment`. Never NULL (see {@link realAskerSql}). */
function commitmentSql(): SQL {
  return drizzleSql`coalesce(${causeKindSql()} IS NOT DISTINCT FROM 'gate'
      OR jsonb_typeof(slot->'pendingRelay') = 'object'
      OR (jsonb_typeof(slot->'ask') = 'object' AND (
            slot->'ask'->'stakes' = '"commitment"'::jsonb
            OR (slot->'ask'->'mode' = '"provide"'::jsonb
                AND jsonb_typeof(slot->'ask'->'provide') = 'object'
                AND slot->'ask'->'provide'->'kind' = '"secret"'::jsonb))), false)`;
}

/**
 * SQL text: `classifyOwedAsk` for the slot aliased `slot` on the session
 * aliased `s`, at `now` — `'needs_you' | 'from_system' | 'stopped' |
 * 'working' | 'review_later'`, or NULL when the slot is not owed.
 */
export function needsYouSlotClassSql(s: string, now: Date): SQL {
  const cutoff = new Date(
    now.getTime() - NEEDS_YOU_REVIEW_LATER_AFTER_MS
  ).toISOString();
  const session = needsYouSessionClassSql(s, now);
  return drizzleSql`(CASE
      WHEN NOT (${owedSlotPredicateSql}) THEN NULL
      WHEN NOT ${realAskerSql()} THEN 'from_system'
      WHEN ${session} = 'stopped' THEN 'stopped'
      WHEN ${session} = 'working' THEN 'working'
      WHEN slot->>'owedSince' ~ ${ISO_STAMP_PATTERN}
        AND NOT ${commitmentSql()}
        AND (slot->>'owedSince') COLLATE "C" < (${cutoff}::text COLLATE "C")
        THEN 'review_later'
      ELSE 'needs_you'
    END)`;
}

function slotsOf(s: string): SQL {
  const outputs = col(s, "expected_outputs");
  return drizzleSql`jsonb_array_elements(
      CASE WHEN jsonb_typeof(${outputs}) = 'array' THEN ${outputs} ELSE '[]'::jsonb END
    ) AS slot`;
}

/**
 * SQL: the session aliased `s` (default: the `focus_sessions` table itself)
 * holds at least one ask that NEEDS the person — the headline, at `now`.
 */
export function needsYouWhere(
  now: Date = new Date(),
  s: string = "focus_sessions"
): SQL {
  return drizzleSql`EXISTS (
    SELECT 1 FROM ${slotsOf(s)}
    WHERE ${needsYouSlotClassSql(s, now)} = 'needs_you'
  )`;
}

/**
 * SQL boolean over `slot`: the ask ends with its session — `askEndsWithSession`
 * (`@synap-core/types/ask`): never a criterion grade (the person's verdict on
 * the work, graded after the session as before it); else its ask's mode is
 * confirm / choose, or, with no ask, it is a decision blocker
 * (`deriveDecisionAsk`'s confirm).
 */
export const SLOT_ENDS_WITH_SESSION_SQL = drizzleSql.raw(`(CASE
    WHEN slot->>'kind' = 'criterion'
      OR (jsonb_typeof(slot->'criterionKey') = 'string' AND slot->>'criterionKey' <> '')
      THEN false
    WHEN slot->'ask' IS NOT NULL AND jsonb_typeof(slot->'ask') <> 'null'
      THEN coalesce(jsonb_typeof(slot->'ask'->'mode') = 'string'
                    AND slot->'ask'->>'mode' IN ('confirm', 'choose'), false)
    ELSE coalesce(slot->>'owner' = 'human'
                  AND jsonb_typeof(slot->'owner') = 'string'
                  AND slot->>'blockedReason' = 'decision'
                  AND jsonb_typeof(slot->'blockedReason') = 'string'
                  AND slot->>'kind' IS DISTINCT FROM 'playbook_param', false)
  END)`);

/**
 * SQL: the open session aliased `s` has STOPPED on its own asks (decision E1,
 * the reaper's arm): no agent evidence for 7 days (`needsYouSessionClass`
 * `stopped`), it owes the person something, and EVERYTHING it owes is an
 * ask that ends with its session (confirm / choose). An act / provide / form
 * slot, or a pending plan/deploy gate, keeps it as it is: those are the
 * person's to do whatever happened to the agent.
 *
 * Only `active` / `paused`: a `stale` session was already reaped.
 */
export function sessionStoppedOnItsAsksWhere(
  now: Date = new Date(),
  s: string = "focus_sessions"
): SQL {
  return drizzleSql`(${col(s, "status")} IN ('active', 'paused')
    AND ${needsYouSessionClassSql(s, now)} = 'stopped'
    AND EXISTS (SELECT 1 FROM ${slotsOf(s)} WHERE ${owedSlotPredicateSql})
    AND NOT EXISTS (
      SELECT 1 FROM ${slotsOf(s)}
      WHERE ${owedSlotPredicateSql} AND NOT ${SLOT_ENDS_WITH_SESSION_SQL}
    )
    AND NOT ${awaitedGatePendingIn(col(s, "id"))})`;
}
