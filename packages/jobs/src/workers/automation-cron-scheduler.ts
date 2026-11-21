/**
 * Automation Cron Scheduler Worker
 *
 * Polls active cron-triggered automations every minute.
 * When nextRunAt <= now(), creates an automation_runs record
 * and enqueues an automation-execute job.
 *
 * This is the single cron scheduler for the pod; the next slot of a row is
 * `nextCronRunAt` (`@synap/shared-utils`), read in the row's
 * `triggerConfig.timezone` (UTC when absent). All autonomous cron behavior
 * flows through automations.
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
import { getBoss } from "@synap/events";
import { createLogger } from "@synap-core/core";
import { nextCronRunAtFor } from "@synap/shared-utils";
// The expiry predicate + the rule back-reference reader, IMPORTED from the
// event matcher in this same package rather than mirrored. Two firing doors
// must agree on what "expired" means; a second copy is how they stop agreeing.
import {
  loadExpiredRuleIds,
  ruleIdOfAutomation,
} from "./automation-trigger-matcher.js";

const logger = createLogger({ module: "automation-cron-scheduler" });

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
 * from `now` by the SAME `nextCronRunAt` the post-run update uses. Stamping
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
    const timezone = triggerConfig?.timezone as string | undefined;
    const nextRunAt = nextCronRunAtFor(triggerConfig, now);

    if (!nextRunAt) {
      // TERMINAL, not a retry: the row can never leave the `isNull(nextRunAt)`
      // set on its own, so warning-and-continuing re-warns every 60s forever
      // (~1,440 identical lines/day/row). `nextCronRunAt` returns null for
      // author input it cannot schedule (`@daily`, six fields, a zone it does
      // not know), so this is a config error the AUTHOR must see. Park it in the schema's existing
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
            ? `Unparseable cron schedule: "${expression}"${timezone ? ` in time zone "${timezone}"` : ""}. Only 5-field cron (minute hour day-of-month month day-of-week) in an IANA time zone is supported.`
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

  // ── Drop automations whose RULE has expired ──────────────────────────────
  // The SECOND autonomous firing door. `automation-trigger-matcher.ts` guards
  // the event path; a rule can also compile to a CRON automation
  // (`services/rules/compile.ts` accepts `triggerType: "cron"` once
  // `triggerConfig.expression` is present), and this loop would otherwise keep
  // running it forever after its review date passed — the same "silence the
  // advice, leave the action running" half-fix, one door over.
  //
  // Same three properties as the event path, deliberately: the predicate is
  // IMPORTED from the matcher rather than re-derived (one definition of
  // expired); the lookup is ONE batched query, skipped entirely when no due
  // automation is rule-backed; and it is SKIP-ONLY — no delete, no archive, no
  // status change, no `nextRunAt` advance. Enforcement is not visibility: an
  // expired rule stays listed, and renewing it resumes the schedule with no
  // repair step. A row therefore stays due and is re-skipped each tick, which
  // is the honest cost of not mutating state we do not own.
  const expiredRuleIds = await loadExpiredRuleIds(
    dueAutomations.map((a) => a.metadata),
    now
  );
  const runnable = expiredRuleIds.size
    ? dueAutomations.filter((a) => {
        const ruleId = ruleIdOfAutomation(a.metadata);
        return !(ruleId && expiredRuleIds.has(ruleId));
      })
    : dueAutomations;

  if (runnable.length !== dueAutomations.length) {
    logger.info(
      { skipped: dueAutomations.length - runnable.length },
      "Skipped due cron automations whose rule has expired"
    );
  }
  if (runnable.length === 0) return;

  logger.info({ count: runnable.length }, "Found due cron automations");

  const boss = getBoss();

  for (const automation of runnable) {
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
            // The moment this run was DUE, not the moment the tick got to it.
            // `now` is the scheduler's wall clock, and the loop selects
            // `nextRunAt <= now` — so a tick that runs three seconds late, or
            // a backed-up queue, stamps 09:00:03 / 09:01:41 / 09:00:00 for the
            // same weekly 09:00 rule. The only consumer today is the
            // appointment branch of `steps/playbook-run.ts`, which writes this
            // straight onto `metadata.scheduledFor` and shows it to a person as
            // "your Monday 9am review" — a drifting stamp there is a recurring
            // appointment that never quite reads as recurring.
            //
            // `nextRunAt` is non-null by construction here (it is the column
            // this loop filters on), but the fallback is honest rather than a
            // non-null assertion: with no due moment recorded, the tick IS the
            // only moment we know.
            scheduledAt: (automation.nextRunAt ?? now).toISOString(),
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

      // Compute and set next run time. `runCount` is the executor's: it
      // counts a run once, when it ends (ticket 85133a81 — counting the
      // dispatch too doubled every automation's runs).
      const nextRunAt = nextCronRunAtFor(triggerConfig, now);

      await db
        .update(automations)
        .set({
          lastRunAt: now,
          nextRunAt,
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
