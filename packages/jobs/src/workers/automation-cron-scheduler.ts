/**
 * Automation Cron Scheduler Worker
 *
 * Polls active cron-triggered automations every minute.
 * When nextRunAt <= now(), creates an automation_runs record
 * and enqueues an automation-execute job.
 *
 * This is the single cron scheduler / cron-due parser for the pod
 * (computeNextRunAt). All autonomous cron behavior flows through automations.
 */

import {
  db,
  eq,
  and,
  lte,
  isNull,
  automations,
  automationRuns,
} from "@synap/database";
import { drizzleSql } from "@synap/database";
import { getBoss } from "@synap/events";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "automation-cron-scheduler" });

/**
 * Parse a 5-field cron expression and compute the next run time from a given base.
 * Supports: minute hour dayOfMonth month dayOfWeek
 *
 * Simple forward-scan implementation — checks the next 1440 minutes (24h)
 * to find the next matching slot.
 */
function computeNextRunAt(cronExpr: string, fromDate: Date): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts;

  function matchesCronField(
    field: string,
    value: number,
    _max: number
  ): boolean {
    if (field === "*") return true;

    // Handle */N step
    if (field.startsWith("*/")) {
      const step = parseInt(field.slice(2), 10);
      return step > 0 && value % step === 0;
    }

    // Handle comma-separated values
    const values = field.split(",");
    for (const v of values) {
      // Handle range N-M
      if (v.includes("-")) {
        const [start, end] = v.split("-").map(Number);
        if (value >= start && value <= end) return true;
        continue;
      }
      // Handle day-of-week names
      const dayNames: Record<string, number> = {
        SUN: 0,
        MON: 1,
        TUE: 2,
        WED: 3,
        THU: 4,
        FRI: 5,
        SAT: 6,
      };
      const resolved = dayNames[v.toUpperCase()] ?? parseInt(v, 10);
      if (resolved === value) return true;
    }
    return false;
  }

  // Scan forward minute-by-minute for up to 366 days
  const candidate = new Date(fromDate);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1); // Start from next minute

  const maxAttempts = 366 * 24 * 60; // One year of minutes
  for (let i = 0; i < maxAttempts; i++) {
    const min = candidate.getMinutes();
    const hour = candidate.getHours();
    const dom = candidate.getDate();
    const month = candidate.getMonth() + 1; // 1-indexed
    const dow = candidate.getDay(); // 0=Sun

    if (
      matchesCronField(minExpr, min, 59) &&
      matchesCronField(hourExpr, hour, 23) &&
      matchesCronField(domExpr, dom, 31) &&
      matchesCronField(monthExpr, month, 12) &&
      matchesCronField(dowExpr, dow, 6)
    ) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

/**
 * Self-heal active cron automations whose `nextRunAt` is NULL.
 *
 * The due-query below is `next_run_at <= now()`, and NULL never satisfies `<=`,
 * so an active cron row that never got stamped is invisible to the scheduler
 * FOREVER. `nextRunAt` is stamped by the create and activate procedures
 * (routers/automations.ts), but any row that predates / bypasses that stamping
 * is permanently dead. The scheduler is the right layer to repair it: it is the
 * one place that already owns `nextRunAt` and the cron parser.
 *
 * NO CATCH-UP: the healed row is stamped with its NEXT slot, computed forward
 * from `now` by the SAME `computeNextRunAt` the post-run update uses. Stamping
 * a past slot (or firing immediately) would replay every missed occurrence — a
 * daily 8am automation dark for 8 days would burst 8 runs — which is exactly
 * what a scheduler must not do. This also matches what `activate` does: it
 * schedules forward, it does not fire on activation.
 */
async function healUnscheduledCronAutomations(now: Date): Promise<void> {
  const unscheduled = await db
    .select({ id: automations.id, triggerConfig: automations.triggerConfig })
    .from(automations)
    .where(
      and(
        eq(automations.status, "active"),
        eq(automations.triggerType, "cron"),
        isNull(automations.nextRunAt)
      )
    );

  if (unscheduled.length === 0) return;

  for (const automation of unscheduled) {
    const triggerConfig = automation.triggerConfig as Record<string, unknown>;
    const expression = triggerConfig?.expression as string | undefined;
    const nextRunAt = expression ? computeNextRunAt(expression, now) : null;

    if (!nextRunAt) {
      // TERMINAL, not a retry: the row can never leave the `isNull(nextRunAt)`
      // set on its own, so warning-and-continuing re-warns every 60s forever
      // (~1,440 identical lines/day/row). `computeNextRunAt` returns null for
      // plausible author input (`@daily`, `L`, `0 8 * * 1#2`), so this is a
      // config error the AUTHOR must see. Park it in the schema's existing
      // failure state: `status: 'error'` drops it out of both the heal set and
      // the due set, and surfaces `errorMessage` in the UI. Recoverable through
      // the normal door — `automations.activate` (routers/automations.ts) sets
      // status back to `active`, clears `errorMessage`, and re-stamps
      // `nextRunAt` from the (fixed) expression.
      await db
        .update(automations)
        .set({
          status: "error",
          errorMessage: expression
            ? `Unparseable cron expression: "${expression}". Only 5-field cron (minute hour day-of-month month day-of-week) is supported.`
            : "Cron automation has no trigger expression (triggerConfig.expression is missing).",
          updatedAt: new Date(),
        })
        // SAME idempotency guard as the success path below, and for the same
        // reason: we hold a triggerConfig read at the top of this loop. If the
        // user fixed the expression via `automations.activate` inside our await
        // window — which sets status:'active', clears errorMessage and stamps
        // nextRunAt — an unguarded write would stomp the repaired row back to
        // 'error', quoting an expression it no longer has. Re-asserting the
        // preconditions makes this a no-op against a row someone else healed.
        .where(
          and(
            eq(automations.id, automation.id),
            eq(automations.status, "active"),
            isNull(automations.nextRunAt)
          )
        );

      logger.warn(
        { automationId: automation.id, expression },
        "Active cron automation has NULL nextRunAt and no usable cron expression — marked status=error (unschedulable)"
      );
      continue;
    }

    // The `isNull` guard makes this idempotent against a concurrent
    // create/activate stamping the same row — we only fill an empty slot.
    await db
      .update(automations)
      .set({ nextRunAt, updatedAt: new Date() })
      .where(
        and(eq(automations.id, automation.id), isNull(automations.nextRunAt))
      );

    logger.info(
      {
        automationId: automation.id,
        expression,
        nextRunAt: nextRunAt.toISOString(),
      },
      "Healed active cron automation with NULL nextRunAt — scheduled next slot (no catch-up runs)"
    );
  }
}

/**
 * Main handler: runs every minute via pg-boss cron schedule.
 * Finds active cron automations due for execution and triggers them.
 */
export async function handleAutomationCronScheduler(): Promise<void> {
  const now = new Date();

  // Repair rows the due-query can structurally never see (NULL nextRunAt).
  // Healed rows are scheduled forward, so they are not due in this same pass.
  //
  // Guarded: healing is a REPAIR path and must never take down the PRIMARY
  // path. Unwrapped, a single transient PG error here would abort the handler
  // before the due-dispatch loop, silently skipping every cron due that minute.
  try {
    await healUnscheduledCronAutomations(now);
  } catch (err) {
    logger.error(
      { err },
      "Cron self-healing failed — continuing to due-automation dispatch"
    );
  }

  // Find active cron automations where nextRunAt <= now
  const dueAutomations = await db
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.status, "active"),
        eq(automations.triggerType, "cron"),
        lte(automations.nextRunAt, now)
      )
    );

  if (dueAutomations.length === 0) return;

  logger.info({ count: dueAutomations.length }, "Found due cron automations");

  const boss = getBoss();

  for (const automation of dueAutomations) {
    try {
      const triggerConfig = automation.triggerConfig as Record<string, unknown>;
      const cronExpression = triggerConfig?.expression as string;

      // Create run record.
      //
      // `subjectEntityId` is deliberately left NULL: a clock tick is about no
      // entity, so there is nothing honest to derive. A `per_entity` cron
      // automation therefore narrates its PARENT run into the per-type feed
      // (`resolveRunChannel`'s intended fallback) and gets its per-entity routing
      // from the children it spawns — the flagship shape is a cron parent that
      // fans out over clients via `sub_automation`, and the executor stamps each
      // child with the subject its payload mapping resolved. Inventing a subject
      // here (e.g. the first matching entity) would misroute every recap.
      const [run] = await db
        .insert(automationRuns)
        .values({
          automationId: automation.id,
          workspaceId: automation.workspaceId,
          status: "running",
          triggerPayload: {
            type: "cron",
            expression: cronExpression,
            scheduledAt: now.toISOString(),
          },
        })
        .returning({ id: automationRuns.id });

      if (!run) continue;

      // Enqueue execution
      await boss.send("automation-execute", {
        runId: run.id,
        automationId: automation.id,
        workspaceId: automation.workspaceId,
        automationContext: {
          automationRunId: run.id,
          automationId: automation.id,
          chainDepth: 0,
          rootRunId: run.id,
          chainAutomationIds: [automation.id],
        },
      });

      // Compute and set next run time
      const nextRunAt = cronExpression
        ? computeNextRunAt(cronExpression, now)
        : null;

      await db
        .update(automations)
        .set({
          lastRunAt: now,
          nextRunAt,
          runCount: drizzleSql`COALESCE(${automations.runCount}, 0) + 1`,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, automation.id));

      logger.info(
        {
          automationId: automation.id,
          runId: run.id,
          nextRunAt: nextRunAt?.toISOString(),
        },
        "Cron automation triggered"
      );
    } catch (err) {
      logger.error(
        { err, automationId: automation.id },
        "Failed to trigger cron automation"
      );
    }
  }
}

// Export computeNextRunAt for use by the activate procedure
export { computeNextRunAt };
