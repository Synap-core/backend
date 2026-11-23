/**
 * A session's `closedAs` as a READ reads it from the row (`sessionClosedAs`,
 * `@synap-core/types/focus-sessions`, decides; this only selects its one
 * input). The close door records an agent's close-anyway on
 * `verification_report.closedNotDone` (`complete-session.ts`); a closed row
 * without it closed with nothing required left open.
 */
import { drizzleSql, focusSessions } from "@synap/database";

/** SQL: the row carries the close-anyway record — `sessionClosedAs`'s input. */
export function closedNotDoneRecordedSql() {
  return drizzleSql<boolean>`coalesce(jsonb_typeof(${focusSessions.verificationReport} -> 'closedNotDone') = 'object', false)`;
}
