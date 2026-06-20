/**
 * Playbook → backing cron automation (proactivity-infra Wave 2, S1).
 *
 * A playbook's `schedule { cron, enabled }` field is otherwise orphaned — no
 * worker reads it. The clean model: a scheduled playbook is SUGAR that maintains
 * exactly ONE backing `automations` row (a single `playbook_run` node), stamped
 * onto `playbooks.flow_automation_id`. The EXISTING `automation-cron-scheduler`
 * worker then fires it like any other cron automation — no playbook-specific
 * scheduler is introduced.
 *
 * This module is the ONE shared materialization primitive used by:
 *   - the playbooks `create` / `update` tRPC mutations, and
 *   - the workspace-definition materializer (`automations[]` → playbook_run).
 *
 * Cron `nextRunAt` is computed by REUSING the scheduler's `computeNextRunAt`
 * (imported from the worker) — there is deliberately no second cron parser here.
 *
 * Pure domain side effect — the caller MUST have already gated the parent
 * mutation (checkPermissionOrPropose); these automation writes ride that
 * approval, exactly like the links written by playbook-lifecycle.ts.
 */

import {
  getDb,
  eq,
  automations,
  playbooks,
  type FlowDefinition,
} from "@synap/database";
import type { Playbook } from "@synap/database/schema";
import type { PlaybookSchedule } from "@synap/playbooks";
// Reuse the scheduler's cron parser — do NOT add a second one.
import { computeNextRunAt } from "@synap/jobs/workers/automation-cron-scheduler.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "playbook-cron-automation" });

/** Narrowed view of the JSONB `schedule` column. */
function readSchedule(value: unknown): PlaybookSchedule | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Partial<PlaybookSchedule>;
  if (typeof s.cron !== "string" || s.cron.trim() === "") return null;
  return { cron: s.cron, enabled: s.enabled === true };
}

/**
 * Build the single-node `playbook_run` flow definition that drives a playbook
 * from a backing automation. Shared with the workspace-definition materializer
 * so both paths emit the exact node shape the `playbook_run` executor expects.
 */
export function buildPlaybookRunFlowDefinition(
  playbookId: string,
  opts?: { playbookName?: string; paramsMapping?: Record<string, string> }
): FlowDefinition {
  return {
    nodes: [
      {
        id: "playbook-run",
        type: "playbook_run",
        position: { x: 0, y: 0 },
        data: {
          label: opts?.playbookName ?? "Run playbook",
          playbookId,
          playbookName: opts?.playbookName,
          paramsMapping: opts?.paramsMapping,
        },
      },
    ],
    edges: [],
  };
}

export interface CronAutomationCtx {
  /** Acting principal — stamped as the automation's createdBy. */
  userId: string;
}

/**
 * Reconcile a playbook's `schedule` into its backing cron automation.
 *
 * - `schedule.enabled === true` → upsert ONE active cron automation (idempotent:
 *   re-points/updates the SAME row via `flow_automation_id`, never duplicates),
 *   stamp `playbooks.flow_automation_id`.
 * - `schedule.enabled === false` / schedule cleared → deactivate the backing
 *   automation (status `paused`) and null out `flow_automation_id`.
 *
 * Returns the backing automation id (or null when there is none).
 */
export async function materializePlaybookCronAutomation(
  playbook: Pick<
    Playbook,
    "id" | "workspaceId" | "name" | "schedule" | "flowAutomationId"
  >,
  ctx: CronAutomationCtx
): Promise<string | null> {
  const db = await getDb();
  const schedule = readSchedule(playbook.schedule);
  const existingId = playbook.flowAutomationId ?? null;

  // ── No active schedule → tear down any backing automation. ──────────────────
  if (!schedule || !schedule.enabled) {
    if (existingId) {
      await db
        .update(automations)
        .set({ status: "paused", nextRunAt: null, updatedAt: new Date() })
        .where(eq(automations.id, existingId));
      await db
        .update(playbooks)
        .set({ flowAutomationId: null, updatedAt: new Date() })
        .where(eq(playbooks.id, playbook.id));
      logger.info(
        { playbookId: playbook.id, automationId: existingId },
        "Deactivated backing cron automation (schedule disabled/cleared)"
      );
    }
    return null;
  }

  const flowDefinition = buildPlaybookRunFlowDefinition(playbook.id, {
    playbookName: playbook.name,
  });
  const nextRunAt = computeNextRunAt(schedule.cron, new Date());

  // ── Active schedule → update the SAME backing row if one exists. ────────────
  if (existingId) {
    const existing = await db.query.automations.findFirst({
      where: eq(automations.id, existingId),
    });
    if (existing) {
      await db
        .update(automations)
        .set({
          name: `${playbook.name} (schedule)`,
          triggerType: "cron",
          triggerConfig: { expression: schedule.cron },
          flowDefinition,
          status: "active",
          nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, existingId));
      logger.info(
        { playbookId: playbook.id, automationId: existingId },
        "Updated backing cron automation"
      );
      return existingId;
    }
    // Dangling pointer (automation deleted out from under us) — fall through and
    // create a fresh one, re-stamping the playbook.
  }

  // ── No backing row yet → create one and stamp the playbook. ─────────────────
  const [created] = await db
    .insert(automations)
    .values({
      workspaceId: playbook.workspaceId,
      createdBy: ctx.userId,
      name: `${playbook.name} (schedule)`,
      description: `Scheduled run of playbook "${playbook.name}"`,
      triggerType: "cron",
      triggerConfig: { expression: schedule.cron },
      flowDefinition,
      status: "active",
      nextRunAt,
      metadata: { createdVia: "template", playbookId: playbook.id },
    })
    .returning({ id: automations.id });

  const automationId = created?.id ?? null;
  if (automationId) {
    await db
      .update(playbooks)
      .set({ flowAutomationId: automationId, updatedAt: new Date() })
      .where(eq(playbooks.id, playbook.id));
    logger.info(
      { playbookId: playbook.id, automationId },
      "Created backing cron automation"
    );
  }
  return automationId;
}
