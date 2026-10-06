/**
 * A PARENT AUTOMATION RUN SETTLES FROM ITS CHILDREN'S OUTCOMES.
 *
 * A `playbook_run` node starts a playbook run and returns at once with
 * `status: "running"`; the agent works for minutes or hours after the
 * automation run has already settled `completed`. Before this helper, nothing
 * walked back: in the 2026-10 incident a cron rule reported 78 successes while
 * every child run it started failed, so the breakers that turn off a failing
 * rule (`automation-breaker.ts`, keyed on the PARENT's outcome) never fired.
 *
 * The link is the one every child session already carries: run-playbook
 * stamps `metadata.automationRunId` (+ `automationChainContext`, which also
 * names the dispatching step row as `stepRunId`).
 *
 * TWO ENTRY POINTS, ONE RULE (`resettleAutomationRunFromChildren`):
 *   - every `playbook_runs` terminal writer calls
 *     {@link settleParentAutomationRunFromChild} right after its write
 *     (tripwire: `api/src/__tripwires__/playbook-run-terminal-settles-parent`);
 *   - the executor calls the rule on its own run after settling, which
 *     covers a child that failed synchronously while the parent was still
 *     walking (its writer found the parent live and left it alone).
 *
 * THE RULE: a parent that settled `completed` (or `blocked_by_policy`) and has
 * at least one FAILED child becomes `failed`. Its dispatching step row(s) flip
 * `completed → failed`, the automation's counters move one success to one
 * failure, and the existing breakers run with the child's error as the reason.
 * The flip is guarded on the status it read, so counters move exactly once
 * however many children fail or writers race. A `cancelled` child (a person
 * detached it) is not a failure; a `completed` child changes nothing.
 *
 * NEVER THROWS. It runs after the child's own write has committed; a failure
 * here must not turn a recorded child verdict into an error for its caller.
 * It is logged at error level and reported in the return value instead.
 */
import {
  db,
  and,
  eq,
  inArray,
  drizzleSql,
  automations,
  automationRuns,
  automationStepRuns,
  playbookRuns,
  focusSessions,
} from "@synap/database";
import {
  tripNeverWorkedBreaker,
  tripBrokeAfterWorkingBreaker,
} from "../workers/automation-breaker.js";
import { logger } from "../workers/automation-executor-logger.js";

/** Parent statuses a child failure re-settles (a live run settles itself). */
const RESETTLEABLE = ["completed", "blocked_by_policy"] as const;

const REASON_MAX = 600;

export type ParentSettleOutcome =
  | { kind: "not_failed" }
  | { kind: "not_automation_child" }
  | { kind: "no_failed_children" }
  | { kind: "parent_not_resettleable"; parentStatus: string }
  | { kind: "raced" }
  | {
      kind: "settled";
      parentRunId: string;
      automationId: string;
      previousStatus: string;
      failedChildren: number;
      totalChildren: number;
      stepsFlipped: number;
    }
  | { kind: "error"; message: string };

/** The sentence the parent run row carries once a child failed. */
export function childFailureMessage(
  failed: number,
  total: number,
  firstError: string | null
): string {
  const cause = firstError?.trim()
    ? ` First failure: ${firstError.trim().slice(0, REASON_MAX)}`
    : "";
  return `${failed} of ${total} playbook run${total === 1 ? "" : "s"} this run started failed.${cause}`;
}

/**
 * Call right after writing a terminal status onto a `playbook_runs` row.
 * Cheap no-op for anything that is not a failed child of an automation run.
 */
export async function settleParentAutomationRunFromChild(input: {
  playbookRunId: string;
}): Promise<ParentSettleOutcome> {
  try {
    const [child] = await db
      .select({
        status: playbookRuns.status,
        parentRunId: drizzleSql<
          string | null
        >`(SELECT ${focusSessions.metadata}->>'automationRunId' FROM ${focusSessions} WHERE ${focusSessions.id} = ${playbookRuns.sessionId})`,
      })
      .from(playbookRuns)
      .where(eq(playbookRuns.id, input.playbookRunId))
      .limit(1);
    if (!child || child.status !== "failed") return { kind: "not_failed" };
    if (!child.parentRunId) return { kind: "not_automation_child" };
    return await resettleAutomationRunFromChildren(child.parentRunId);
  } catch (err) {
    return reportError(err, { playbookRunId: input.playbookRunId });
  }
}

/** THE rule (see the file header), keyed by the parent automation run. */
export async function resettleAutomationRunFromChildren(
  parentRunId: string
): Promise<ParentSettleOutcome> {
  try {
    const children = await db
      .select({
        status: playbookRuns.status,
        error: playbookRuns.error,
        stepRunId: drizzleSql<
          string | null
        >`${focusSessions.metadata}->'automationChainContext'->>'stepRunId'`,
      })
      .from(playbookRuns)
      .innerJoin(focusSessions, eq(focusSessions.id, playbookRuns.sessionId))
      .where(
        drizzleSql`${focusSessions.metadata}->>'automationRunId' = ${parentRunId}`
      )
      .orderBy(playbookRuns.startedAt);
    const failed = children.filter((c) => c.status === "failed");
    if (failed.length === 0) return { kind: "no_failed_children" };

    const [parent] = await db
      .select({
        status: automationRuns.status,
        automationId: automationRuns.automationId,
      })
      .from(automationRuns)
      .where(eq(automationRuns.id, parentRunId))
      .limit(1);
    if (!parent) return { kind: "not_automation_child" };
    if (
      !(RESETTLEABLE as readonly string[]).includes(parent.status) &&
      parent.status !== "failed"
    ) {
      return { kind: "parent_not_resettleable", parentStatus: parent.status };
    }

    const message = childFailureMessage(
      failed.length,
      children.length,
      failed[0]?.error ?? null
    );

    // The dispatching step row(s): `completed → failed`. Idempotent — a step
    // already failed is left as it is, and only rows of THIS run are touched.
    const stepRunIds = [
      ...new Set(
        failed.map((c) => c.stepRunId).filter((id): id is string => !!id)
      ),
    ];
    const flippedSteps =
      stepRunIds.length > 0
        ? await db
            .update(automationStepRuns)
            .set({ status: "failed", errorMessage: message })
            .where(
              and(
                inArray(automationStepRuns.id, stepRunIds),
                eq(automationStepRuns.runId, parentRunId),
                eq(automationStepRuns.status, "completed")
              )
            )
            .returning({ id: automationStepRuns.id })
        : [];

    if (parent.status === "failed") {
      // Already failed (its own step, or an earlier child): counters already
      // say failure. Only the step rows above needed the truth.
      if (flippedSteps.length > 0) {
        await db
          .update(automationRuns)
          .set({
            stepsCompleted: drizzleSql`GREATEST(${automationRuns.stepsCompleted} - ${flippedSteps.length}, 0)`,
            stepsFailed: drizzleSql`${automationRuns.stepsFailed} + ${flippedSteps.length}`,
          })
          .where(eq(automationRuns.id, parentRunId));
      }
      return { kind: "parent_not_resettleable", parentStatus: "failed" };
    }

    const [flipped] = await db
      .update(automationRuns)
      .set({
        status: "failed",
        errorMessage: message,
        stepsCompleted: drizzleSql`GREATEST(${automationRuns.stepsCompleted} - ${flippedSteps.length}, 0)`,
        stepsFailed: drizzleSql`${automationRuns.stepsFailed} + ${flippedSteps.length}`,
      })
      .where(
        and(
          eq(automationRuns.id, parentRunId),
          // Guarded on what we read: a concurrent re-settle that already
          // flipped it loses here, so counters move exactly once.
          eq(automationRuns.status, parent.status)
        )
      )
      .returning({ id: automationRuns.id });
    if (!flipped) return { kind: "raced" };

    // Counters: a `completed` parent was counted a success — move it to a
    // failure. A `blocked_by_policy` parent was already counted a failure.
    const [stats] = await db
      .update(automations)
      .set({
        ...(parent.status === "completed"
          ? {
              successCount: drizzleSql`GREATEST(COALESCE(${automations.successCount}, 0) - 1, 0)`,
              failureCount: drizzleSql`COALESCE(${automations.failureCount}, 0) + 1`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(automations.id, parent.automationId))
      .returning({
        status: automations.status,
        successCount: automations.successCount,
        failureCount: automations.failureCount,
      });

    if (stats) {
      await tripNeverWorkedBreaker({
        automationId: parent.automationId,
        status: stats.status,
        successCount: stats.successCount ?? 0,
        failureCount: stats.failureCount ?? 0,
        reason: message,
      });
      await tripBrokeAfterWorkingBreaker({
        automationId: parent.automationId,
        status: stats.status,
        successCount: stats.successCount ?? 0,
        reason: message,
      });
    }

    logger.warn(
      {
        parentRunId,
        automationId: parent.automationId,
        previousStatus: parent.status,
        failedChildren: failed.length,
        totalChildren: children.length,
      },
      "Automation run re-settled as failed: a playbook run it started failed"
    );
    return {
      kind: "settled",
      parentRunId,
      automationId: parent.automationId,
      previousStatus: parent.status,
      failedChildren: failed.length,
      totalChildren: children.length,
      stepsFlipped: flippedSteps.length,
    };
  } catch (err) {
    return reportError(err, { parentRunId });
  }
}

function reportError(
  err: unknown,
  ctx: Record<string, unknown>
): ParentSettleOutcome {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(
    { err, ...ctx },
    "Could not re-settle the parent automation run from a child's outcome — the parent keeps its earlier verdict and the breakers did not see this failure"
  );
  return { kind: "error", message };
}
