/**
 * A session's `closedAs` as a READ reads it from the row (`sessionClosedAs`,
 * `@synap-core/types/focus-sessions`, decides; this only selects its one
 * input). The close door records an agent's close-anyway on
 * `verification_report.closedNotDone` (`complete-session.ts`); a closed row
 * without it closed with nothing required left open.
 *
 * A step SKIPPED as a decision's arm not taken (P5) ends `cancelled` with
 * `verification_report.notTaken` ({@link NOT_TAKEN_REPORT_KEY}), written by
 * the close door only (`decision-arms.ts` asks it). The dependency rule reads
 * it as `skipped`: it holds none of its dependents.
 */
import { drizzleSql, focusSessions } from "@synap/database";

/** SQL: the row carries the close-anyway record — `sessionClosedAs`'s input. */
export function closedNotDoneRecordedSql() {
  return drizzleSql<boolean>`coalesce(jsonb_typeof(${focusSessions.verificationReport} -> 'closedNotDone') = 'object', false)`;
}

/** Where the close door records a skipped arm on `verification_report`. */
export const NOT_TAKEN_REPORT_KEY = "notTaken" as const;

/** The skip record: which decision, which arm, what was chosen instead. */
export interface NotTakenRecord {
  decisionId: string;
  /** The arm this step was (`links.metadata.option`). */
  option: string;
  /** What the decision chose instead. */
  chosenOption: string;
  at: string;
}

/**
 * The row ended as a decision's arm not taken, read off a loaded row (the
 * JS twin of {@link notTakenRecordedSql}): ended `cancelled` with the
 * door's `notTaken` record.
 */
export function notTakenRecorded(row: {
  status: string | null;
  verificationReport?: unknown;
}): boolean {
  const report = row.verificationReport;
  if (row.status !== "cancelled" || !report || typeof report !== "object") {
    return false;
  }
  const record = (report as Record<string, unknown>)[NOT_TAKEN_REPORT_KEY];
  return !!record && typeof record === "object" && !Array.isArray(record);
}

/** SQL: the row ended as a decision's arm not taken (the dependency rule's `skipped`). */
export function notTakenRecordedSql() {
  return drizzleSql<boolean>`coalesce(jsonb_typeof(${focusSessions.verificationReport} -> 'notTaken') = 'object', false)`;
}
