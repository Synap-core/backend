/**
 * Automation Pattern Detector Worker
 *
 * pg-boss cron job that runs daily at 3:00 AM UTC.
 * Scans workspaces with significant recent activity and calls the Intelligence
 * Service to detect recurring patterns — e.g. "you create a task every time a
 * deal moves to 'negotiation'". High-confidence proposals (>= 0.75) are saved
 * as draft automations that users can discover and activate in the Workflows
 * screen.
 *
 * Resilient per-workspace: a failure in one workspace does not abort others.
 * Does NOT create a proposal record — only a draft automation with
 * metadata.suggestedByPattern = true.
 */

import {
  db,
  eq,
  and,
  gte,
  isNull,
  automations,
  entities,
} from "@synap/database";
import { count } from "drizzle-orm";
import { createLogger } from "@synap-core/core";
import { getDefaultActiveService } from "@synap/intelligence-client";

const logger = createLogger({ module: "automation-pattern-detector" });

/** Minimum entity mutations in last 24h to consider a workspace eligible */
const MIN_ACTIVITY_THRESHOLD = 10;

/** Minimum confidence from IS to save a draft automation */
const MIN_CONFIDENCE = 0.75;

/** IS timeout for pattern detection call */
const IS_TIMEOUT_MS = 30_000;

interface PatternProposal {
  name: string;
  description: string;
  triggerType: string;
  confidence: number;
  suggestedFlow?: {
    nodes: unknown[];
    edges: unknown[];
  };
}

interface DetectPatternsResponse {
  proposals: PatternProposal[];
}

/**
 * Fetch workspaces that had at least MIN_ACTIVITY_THRESHOLD entity mutations
 * in the last 24 hours. Uses entities.updatedAt as a mutation proxy since
 * there is no dedicated events table.
 */
async function getActiveWorkspaceIds(): Promise<string[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      workspaceId: entities.workspaceId,
      mutationCount: count(entities.id),
    })
    .from(entities)
    .where(and(gte(entities.updatedAt, since), isNull(entities.deletedAt)))
    .groupBy(entities.workspaceId)
    .having(({ mutationCount }) => gte(mutationCount, MIN_ACTIVITY_THRESHOLD));

  return rows
    .map((r) => r.workspaceId)
    .filter((id): id is string => id !== null);
}

/**
 * Get recent entity mutation counts grouped by type for a workspace.
 * Used as the event summary payload sent to IS.
 */
async function getWorkspaceActivitySummary(
  workspaceId: string
): Promise<Array<{ type: string; count: number }>> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      type: entities.type,
      mutationCount: count(entities.id),
    })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        gte(entities.updatedAt, since),
        isNull(entities.deletedAt)
      )
    )
    .groupBy(entities.type);

  return rows.map((r) => ({ type: r.type, count: Number(r.mutationCount) }));
}

/**
 * Get the set of trigger types already used by active automations in a
 * workspace. Avoids suggesting patterns the user already has covered.
 */
async function getExistingActiveTriggerTypes(
  workspaceId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ triggerType: automations.triggerType })
    .from(automations)
    .where(
      and(
        eq(automations.workspaceId, workspaceId),
        eq(automations.status, "active")
      )
    );

  return new Set(rows.map((r) => r.triggerType));
}

/**
 * Call IS /api/automations/detect-patterns and return proposed automations.
 */
async function callDetectPatterns(
  workspaceId: string,
  activitySummary: Array<{ type: string; count: number }>,
  existingTriggerTypes: string[]
): Promise<PatternProposal[]> {
  // Canonical IS credential resolution (decrypted DB key), not stale env.
  const { endpoint: isUrl, apiKey: isApiKey } = await getDefaultActiveService();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IS_TIMEOUT_MS);

  try {
    const response = await fetch(`${isUrl}/api/automations/detect-patterns`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": isApiKey,
      },
      body: JSON.stringify({
        workspaceId,
        activitySummary,
        existingTriggerTypes,
        windowHours: 24,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(
        { workspaceId, status: response.status },
        "IS detect-patterns returned non-2xx — skipping workspace"
      );
      return [];
    }

    const data = (await response.json()) as DetectPatternsResponse;
    return Array.isArray(data.proposals) ? data.proposals : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Save a high-confidence proposal as a draft automation.
 * No proposal record is created — users discover it in the Workflows screen.
 */
async function saveDraftAutomation(
  workspaceId: string,
  proposal: PatternProposal
): Promise<void> {
  await db.insert(automations).values({
    workspaceId,
    createdBy: "system",
    name: proposal.name,
    description: proposal.description,
    triggerType: proposal.triggerType as
      | "event"
      | "cron"
      | "webhook"
      | "manual",
    triggerConfig: {},
    flowDefinition: (proposal.suggestedFlow ?? {
      nodes: [],
      edges: [],
    }) as (typeof automations.$inferInsert)["flowDefinition"],
    status: "draft",
    metadata: {
      createdVia: "ai" as const,
      suggestedByPattern: true,
      patternConfidence: proposal.confidence,
      description: proposal.description,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Main handler called by pg-boss for each scheduled run.
 */
export async function handleAutomationPatternDetect(): Promise<void> {
  logger.info("Automation pattern detection started");

  let activeWorkspaces: string[];
  try {
    activeWorkspaces = await getActiveWorkspaceIds();
  } catch (err) {
    logger.error({ err }, "Failed to query active workspaces — aborting");
    return;
  }

  if (activeWorkspaces.length === 0) {
    logger.info("No workspaces with sufficient activity in last 24h");
    return;
  }

  logger.info(
    { count: activeWorkspaces.length },
    "Found workspaces with recent activity, running pattern detection"
  );

  let totalSuggested = 0;

  for (const workspaceId of activeWorkspaces) {
    try {
      const [activitySummary, existingTriggerTypes] = await Promise.all([
        getWorkspaceActivitySummary(workspaceId),
        getExistingActiveTriggerTypes(workspaceId),
      ]);

      const proposals = await callDetectPatterns(
        workspaceId,
        activitySummary,
        Array.from(existingTriggerTypes)
      );

      const highConfidence = proposals.filter(
        (p) => p.confidence >= MIN_CONFIDENCE
      );

      if (highConfidence.length === 0) {
        logger.debug(
          { workspaceId },
          "No high-confidence patterns detected for workspace"
        );
        continue;
      }

      for (const proposal of highConfidence) {
        try {
          await saveDraftAutomation(workspaceId, proposal);
          totalSuggested++;
          logger.info(
            {
              workspaceId,
              name: proposal.name,
              confidence: proposal.confidence,
              triggerType: proposal.triggerType,
            },
            "Saved AI-suggested draft automation"
          );
        } catch (saveErr) {
          logger.warn(
            { err: saveErr, workspaceId, proposalName: proposal.name },
            "Failed to save draft automation — skipping proposal"
          );
        }
      }
    } catch (workspaceErr) {
      // Workspace-level isolation: log and continue to the next workspace
      logger.warn(
        { err: workspaceErr, workspaceId },
        "Pattern detection failed for workspace — skipping"
      );
    }
  }

  logger.info(
    { totalSuggested, workspacesScanned: activeWorkspaces.length },
    "Automation pattern detection completed"
  );
}
