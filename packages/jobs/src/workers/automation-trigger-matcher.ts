/**
 * Automation Trigger Matcher Worker
 *
 * Matches incoming events against active automation triggers.
 * Creates automation_runs when a match is found and enqueues execution.
 *
 * Circular trigger prevention:
 * 1. Events carry automationContext with chainDepth and chainAutomationIds
 * 2. If chainDepth >= MAX_CHAIN_DEPTH, skip all matching
 * 3. If the automation ID is already in chainAutomationIds, skip (self-cycle)
 * 4. If no automationContext, chainDepth starts at 0 (user-originated event)
 */

import { db, eq, and, automations, automationRuns } from "@synap/database";
import type { AutomationTriggerConfig } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { getBoss } from "../boss.js";

const logger = createLogger({ module: "automation-trigger-matcher" });

const MAX_CHAIN_DEPTH = 3;

interface TriggerMatchPayload {
  eventType: string;
  subjectId: string;
  userId: string;
  workspaceId: string;
  data?: Record<string, unknown>;
  automationContext?: {
    automationRunId: string;
    automationId: string;
    chainDepth: number;
    rootRunId?: string;
    chainAutomationIds?: string[];
  };
}

/**
 * Match an event pattern against a trigger pattern.
 * Supports exact match and trailing wildcard:
 *   "entities.create.completed" matches "entities.create.completed"
 *   "entities.create.*" matches "entities.create.completed"
 *   "entities.*" matches "entities.create.completed"
 */
function matchPattern(eventType: string, pattern?: string): boolean {
  if (!pattern) return false;
  if (pattern === eventType) return true;

  const patternParts = pattern.split(".");
  const eventParts = eventType.split(".");

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === "*") return true; // Wildcard matches rest
    if (patternParts[i] !== eventParts[i]) return false;
  }

  return patternParts.length === eventParts.length;
}

/**
 * Check if event data matches trigger filters.
 * Filters are simple key-value equality checks on the event data.
 */
function matchFilters(
  data: Record<string, unknown> | undefined,
  filters: Record<string, unknown> | undefined
): boolean {
  if (!filters || Object.keys(filters).length === 0) return true;
  if (!data) return false;

  for (const [key, expectedValue] of Object.entries(filters)) {
    // Support dot-notation for nested access: "entity.metadata.priority"
    const actualValue = getNestedValue(data, key);
    if (actualValue !== expectedValue) return false;
  }
  return true;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Main handler: match an event against all active automations in the workspace.
 */
export async function handleAutomationTriggerMatch(job: {
  data: TriggerMatchPayload;
}): Promise<void> {
  const { eventType, subjectId, userId, workspaceId, data, automationContext } =
    job.data;

  // ── Chain depth check ──────────────────────────────────────────────────
  const currentDepth = automationContext?.chainDepth ?? 0;
  if (currentDepth >= MAX_CHAIN_DEPTH) {
    logger.warn(
      {
        eventType,
        workspaceId,
        chainDepth: currentDepth,
        rootRunId: automationContext?.rootRunId,
      },
      "Automation chain depth limit reached — skipping trigger matching"
    );
    return;
  }

  const chainIds = new Set(automationContext?.chainAutomationIds ?? []);

  // ── Find matching automations ──────────────────────────────────────────
  const activeAutomations = await db
    .select({
      id: automations.id,
      triggerConfig: automations.triggerConfig,
      workspaceId: automations.workspaceId,
    })
    .from(automations)
    .where(
      and(
        eq(automations.workspaceId, workspaceId),
        eq(automations.status, "active"),
        eq(automations.triggerType, "event")
      )
    );

  if (activeAutomations.length === 0) return;

  const boss = getBoss();

  for (const automation of activeAutomations) {
    // ── Cycle detection ────────────────────────────────────────────────
    if (chainIds.has(automation.id)) {
      logger.info(
        { automationId: automation.id, eventType },
        "Skipping automation — already in chain (cycle prevention)"
      );
      continue;
    }

    const config = automation.triggerConfig as AutomationTriggerConfig;

    // ── Pattern match ──────────────────────────────────────────────────
    if (!matchPattern(eventType, config.eventPattern)) continue;

    // ── Filter match ───────────────────────────────────────────────────
    if (!matchFilters(data, config.filters)) continue;

    // ── Create automation run ──────────────────────────────────────────
    logger.info(
      { automationId: automation.id, eventType, chainDepth: currentDepth + 1 },
      "Event matched automation trigger — creating run"
    );

    const rootRunId =
      automationContext?.rootRunId ?? automationContext?.automationRunId;

    const [run] = await db
      .insert(automationRuns)
      .values({
        automationId: automation.id,
        workspaceId,
        triggeredBy: automationContext ? "system" : userId,
        triggerPayload: {
          eventType,
          subjectId,
          data: data ?? {},
          userId,
          timestamp: new Date().toISOString(),
        },
        status: "running",
      })
      .returning({ id: automationRuns.id });

    // ── Enqueue execution ──────────────────────────────────────────────
    await boss.send("automation-execute", {
      runId: run.id,
      automationId: automation.id,
      workspaceId,
      // Pass chain context so the executor can tag output events
      automationContext: {
        automationRunId: run.id,
        automationId: automation.id,
        chainDepth: currentDepth + 1,
        rootRunId: rootRunId ?? run.id,
        chainAutomationIds: [...chainIds, automation.id],
      },
    });

    // Update automation stats
    await db
      .update(automations)
      .set({
        lastRunAt: new Date(),
        runCount: automations.runCount,
        updatedAt: new Date(),
      })
      .where(eq(automations.id, automation.id));
  }
}
