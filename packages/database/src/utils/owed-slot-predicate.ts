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
 * SQL: the session whose id is `sessionId` (a correlated column or
 * expression, e.g. `playbook_runs.session_id`) owes the person something.
 * False when the id is NULL or names no session.
 */
export function sessionOwesHumanWhere(sessionId: AnyPgColumn | SQL): SQL {
  return drizzleSql`EXISTS (
    SELECT 1 FROM focus_sessions owing
    WHERE owing.id = ${sessionId}
      AND ${owedSlotExistsIn(drizzleSql.raw("owing.expected_outputs"))}
  )`;
}
