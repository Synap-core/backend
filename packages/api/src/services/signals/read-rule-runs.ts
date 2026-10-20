/**
 * RULE RUNS working now — the read behind `readHappening`'s second population
 * (`routers/signals.ts`); `foldRuleRuns` (`rule-runs.ts`) shapes the rows.
 *
 * Runs started inside the SAME working window as sessions
 * (`SESSION_WORKING_WINDOW_MS`), or still in flight, of rules whose run opened
 * NO session (a run that did is already its live-session row). Skipped runs
 * (dedup, daily cap, precondition) did no work and are out. Read floor: the
 * `automationRuns` VisibilityRule under the page's workspace lens.
 */
import {
  db,
  and,
  desc,
  eq,
  or,
  ne,
  gte,
  drizzleSql,
  automations,
  automationRuns,
} from "@synap/database";
import { SESSION_WORKING_WINDOW_MS } from "@synap-core/types/run-activity";
import { scopedDb, type AccessContext } from "../../access/index.js";
import { foldRuleRuns } from "./rule-runs.js";
import type { Signal } from "./needs-you-union.js";

/** Rule runs the Happening read scans inside the window, newest first. */
const RULE_RUN_SCAN_LIMIT = 500;

export async function readRuleRuns(
  access: AccessContext,
  workspaceId: string | null | undefined,
  now: Date
): Promise<{ signals: Signal[]; truncated: boolean }> {
  const since = new Date(now.getTime() - SESSION_WORKING_WINDOW_MS);
  const rows = await db
    .select({
      automationId: automationRuns.automationId,
      automationName: automations.name,
      status: automationRuns.status,
      startedAt: automationRuns.startedAt,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        scopedDb(access.withLens(workspaceId)).predicate(automationRuns),
        or(
          gte(automationRuns.startedAt, since),
          eq(automationRuns.status, "running")
        ),
        ne(automationRuns.status, "skipped"),
        drizzleSql`NOT EXISTS (
          SELECT 1 FROM focus_sessions fs
          WHERE fs.metadata->>'automationRunId' = ${automationRuns.id}::text
        )`
      )
    )
    .orderBy(desc(automationRuns.startedAt))
    .limit(RULE_RUN_SCAN_LIMIT + 1);
  return {
    signals: foldRuleRuns(rows.slice(0, RULE_RUN_SCAN_LIMIT), now),
    truncated: rows.length > RULE_RUN_SCAN_LIMIT,
  };
}
