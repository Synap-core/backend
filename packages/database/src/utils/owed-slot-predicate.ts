/**
 * THE owed-slot predicate in SQL — "this session still owes the person
 * something" — shared by the needs-you read (`@synap/api`
 * `services/focus-sessions/owed-outputs.ts`, which re-exports it with its
 * TypeScript twin `isOwedSlot`) and by the jobs that must NEVER close or stale
 * a session the person still owes (the W2 reaper guard: focus-session,
 * automation-run and playbook-run reapers, and the executor's close).
 *
 * It lives HERE, not in api, because `@synap/jobs` cannot import `@synap/api`
 * (api depends on jobs). One definition in the lowest package both read is the
 * only way the reapers and the needs-you tray can never disagree about what
 * "owed" means — a second copy in jobs is how the reapers closed sessions the
 * tray was still counting (census §3d).
 *
 * The trap (kept from its original home): `status` is normally ABSENT on a
 * slot and means `pending`, so `slot->>'status' != 'done'` silently rejects
 * half the rows — `IS DISTINCT FROM` is the operator that means what it says.
 * The `jsonb_typeof` guard: `jsonb_array_elements` ERRORS on a non-array, and
 * `expected_outputs` is untyped JSONB a legacy row can hold anything in.
 *
 * THE RULE THIS MIRRORS is `deliverableOwedBy(slot) === "you"`
 * (`@synap-core/types/units`, `deliverable.ts`) — the one deliverable rule
 * every surface calls; the api's `isOwedSlot` calls it directly. This package
 * cannot import it (types depends on database), so the SQL is a mirror held to
 * the rule by a behavioural parity test on PGlite
 * (`owed-slot-predicate.parity.pglite.test.ts`) over the inputs where naive
 * spellings disagree — `retiredAt: ""` above all: any stamp, even an empty
 * one, is a retirement on both sides (`IS NULL` here, `== null` there).
 */

import { sql as drizzleSql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { focusSessions } from "../schema/focus-sessions.js";

/**
 * The clause SET, as data — a WHERE and an ORDER BY composing the same value
 * cannot drift apart, and a guard can assert the set rather than membership.
 */
export const OWED_SLOT_CLAUSES = [
  "slot->>'owner' = 'human'",
  "slot->>'status' IS DISTINCT FROM 'done'",
  "slot->>'retiredAt' IS NULL",
] as const;

/** The three clauses as ONE fragment, over a row aliased `slot`. */
export const owedSlotPredicateSql = drizzleSql.raw(
  OWED_SLOT_CLAUSES.join("\n      AND ")
);

/** SQL: the given `expected_outputs` value holds at least one owed slot. */
export function owedSlotExistsIn(expectedOutputs: AnyPgColumn | SQL): SQL {
  return drizzleSql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${expectedOutputs}) = 'array'
           THEN ${expectedOutputs}
           ELSE '[]'::jsonb END
    ) AS slot
    WHERE ${owedSlotPredicateSql}
  )`;
}

/** SQL: this `focus_sessions` row owes the person at least one slot. */
export function owedSlotWhere(): SQL {
  return owedSlotExistsIn(focusSessions.expectedOutputs);
}

/**
 * The session statuses in which an owed slot can still PARK a run. A closed,
 * failed or cancelled session with a leftover owed slot still counts in the
 * needs-you tray (the slot is owed), but it must not hold a run in
 * `waiting_on_you` forever: nothing will ever resume that session's run.
 */
export const OPEN_SESSION_STATUSES = ["active", "paused", "stale"] as const;

const OPEN_SESSION_SQL_LIST = drizzleSql.raw(
  OPEN_SESSION_STATUSES.map((s) => `'${s}'`).join(", ")
);

/**
 * SQL: the OPEN session behind `owing` (an alias the caller joins) owes the
 * person something. Shared by every run-parking predicate.
 */
export function openOwingSessionSql(alias: string): SQL {
  return drizzleSql`${drizzleSql.raw(`${alias}.status`)} IN (${OPEN_SESSION_SQL_LIST})
      AND ${owedSlotExistsIn(drizzleSql.raw(`${alias}.expected_outputs`))}`;
}

/**
 * SQL: the session whose id is `sessionId` (a correlated column or
 * expression, e.g. `playbook_runs.session_id`) is OPEN and owes the person
 * something. False when the id is NULL, names no session, or the session is
 * closed/failed/cancelled.
 */
export function sessionOwesHumanWhere(sessionId: AnyPgColumn | SQL): SQL {
  return drizzleSql`EXISTS (
    SELECT 1 FROM focus_sessions owing
    WHERE owing.id = ${sessionId}
      AND ${openOwingSessionSql("owing")}
  )`;
}
