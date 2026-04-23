/**
 * Proactive Aggregator
 *
 * Queries workspace data to build proactive digest content.
 * Collects tasks, proposals, entities, and captures for summarization.
 */

import { db, eq, and, gte, lte, isNull, desc, count } from "@synap/database";
import {
  entities,
  proposals,
  ProposalStatus,
  profiles,
} from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import type { ProactiveFeedConfig } from "@synap-core/types";

const logger = createLogger({ module: "proactive-aggregator" });

// ── Types ────────────────────────────────────────────────────────────────────

export interface AggregatedData {
  /** Tasks due within window */
  tasksDue: Array<{
    id: string;
    title: string;
    dueDate: string;
    priority?: string;
    status?: string;
  }>;
  /** Pending proposals */
  pendingProposals: Array<{
    id: string;
    title: string;
    type: string;
    createdAt: Date;
  }>;
  /** Recently created entities */
  recentEntities: Array<{
    id: string;
    type: string;
    title: string;
    createdAt: Date;
  }>;
  /** Recent captures */
  recentCaptures: Array<{
    id: string;
    title: string;
    content?: string;
    url?: string;
    capturedAt: Date;
  }>;
  /** Activity summary counts */
  activitySummary: {
    entitiesCreated: number;
    entitiesUpdated: number;
    proposalsCreated: number;
    capturesCreated: number;
  };
}

// ── Task Aggregation ─────────────────────────────────────────────────────────

/**
 * Get tasks due within the specified window.
 */
async function getTasksDue(
  workspaceId: string,
  days: number
): Promise<AggregatedData["tasksDue"]> {
  const now = new Date();
  const dueBy = new Date(now);
  dueBy.setDate(dueBy.getDate() + days);

  // Get task profile
  const taskProfile = await db.query.profiles.findFirst({
    where: eq(profiles.slug, "task"),
    columns: { id: true },
  });

  if (!taskProfile) {
    return [];
  }

  // Query tasks due within window
  const tasks = await db.query.entities.findMany({
    where: and(
      eq(entities.workspaceId, workspaceId),
      eq(entities.profileId, taskProfile.id),
      isNull(entities.deletedAt)
    ),
    columns: {
      id: true,
      title: true,
      properties: true,
    },
    limit: 50,
  });

  // Filter by due date in memory (JSONB property)
  const dueTasks = tasks.filter((task) => {
    const props = task.properties as Record<string, unknown>;
    const dueDate = props?.dueDate as string | undefined;
    const status = props?.status as string | undefined;

    if (!dueDate || status === "done" || status === "cancelled") {
      return false;
    }

    const due = new Date(dueDate);
    return due >= now && due <= dueBy;
  });

  return dueTasks.map((task) => {
    const props = task.properties as Record<string, unknown>;
    return {
      id: task.id,
      title: task.title || "Untitled task",
      dueDate: props?.dueDate as string,
      priority: props?.priority as string | undefined,
      status: props?.status as string | undefined,
    };
  });
}

// ── Proposal Aggregation ─────────────────────────────────────────────────────

/**
 * Get pending proposals for workspace.
 */
async function getPendingProposals(
  workspaceId: string
): Promise<AggregatedData["pendingProposals"]> {
  const pending = await db.query.proposals.findMany({
    where: and(
      eq(proposals.workspaceId, workspaceId),
      eq(proposals.status, ProposalStatus.PENDING)
    ),
    columns: {
      id: true,
      proposalType: true,
      createdAt: true,
      data: true,
    },
    orderBy: [desc(proposals.createdAt)],
    limit: 20,
  });

  return pending.map((p) => {
    const data = (p.data || {}) as Record<string, unknown>;
    const title =
      (data.title as string) || (data.name as string) || "Untitled proposal";
    return {
      id: p.id,
      title,
      type: p.proposalType,
      createdAt: p.createdAt,
    };
  });
}

// ── Entity Aggregation ───────────────────────────────────────────────────────

/**
 * Get recently created entities.
 */
async function getRecentEntities(
  workspaceId: string,
  hours: number
): Promise<AggregatedData["recentEntities"]> {
  const since = new Date();
  since.setHours(since.getHours() - hours);

  const recent = await db.query.entities.findMany({
    where: and(
      eq(entities.workspaceId, workspaceId),
      gte(entities.createdAt, since),
      isNull(entities.deletedAt)
    ),
    columns: {
      id: true,
      type: true,
      title: true,
      createdAt: true,
    },
    orderBy: [desc(entities.createdAt)],
    limit: 30,
  });

  return recent.map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title || `Untitled ${e.type}`,
    createdAt: e.createdAt,
  }));
}

// ── Capture Aggregation ──────────────────────────────────────────────────────

/**
 * Get recent captures.
 */
async function getRecentCaptures(
  workspaceId: string,
  hours: number
): Promise<AggregatedData["recentCaptures"]> {
  const since = new Date();
  since.setHours(since.getHours() - hours);

  // Get capture profile
  const captureProfile = await db.query.profiles.findFirst({
    where: eq(profiles.slug, "capture"),
    columns: { id: true },
  });

  if (!captureProfile) {
    return [];
  }

  // Query captures as entities
  const recent = await db.query.entities.findMany({
    where: and(
      eq(entities.workspaceId, workspaceId),
      eq(entities.profileId, captureProfile.id),
      gte(entities.createdAt, since),
      isNull(entities.deletedAt)
    ),
    columns: {
      id: true,
      title: true,
      properties: true,
      createdAt: true,
    },
    orderBy: [desc(entities.createdAt)],
    limit: 20,
  });

  return recent.map((c) => {
    const props = c.properties as Record<string, unknown>;
    return {
      id: c.id,
      title: c.title || "Untitled capture",
      content: props?.content as string | undefined,
      url: props?.url as string | undefined,
      capturedAt: c.createdAt,
    };
  });
}

// ── Activity Summary ─────────────────────────────────────────────────────────

/**
 * Get activity summary counts.
 */
async function getActivitySummary(
  workspaceId: string,
  hours: number
): Promise<AggregatedData["activitySummary"]> {
  const since = new Date();
  since.setHours(since.getHours() - hours);

  // Count entities created
  const [createdResult] = await db
    .select({ value: count() })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        gte(entities.createdAt, since),
        isNull(entities.deletedAt)
      )
    );

  // Count entities updated (but not created in window)
  const [updatedResult] = await db
    .select({ value: count() })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        gte(entities.updatedAt, since),
        lte(entities.createdAt, since), // Created before window
        isNull(entities.deletedAt)
      )
    );

  // Count proposals created
  const [proposalsResult] = await db
    .select({ value: count() })
    .from(proposals)
    .where(
      and(
        eq(proposals.workspaceId, workspaceId),
        gte(proposals.createdAt, since)
      )
    );

  // Count captures
  const captureProfile = await db.query.profiles.findFirst({
    where: eq(profiles.slug, "capture"),
    columns: { id: true },
  });

  let capturesCount = 0;
  if (captureProfile) {
    const [capturesResult] = await db
      .select({ value: count() })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          eq(entities.profileId, captureProfile.id),
          gte(entities.createdAt, since),
          isNull(entities.deletedAt)
        )
      );
    capturesCount = capturesResult?.value ?? 0;
  }

  return {
    entitiesCreated: createdResult?.value ?? 0,
    entitiesUpdated: updatedResult?.value ?? 0,
    proposalsCreated: proposalsResult?.value ?? 0,
    capturesCreated: capturesCount,
  };
}

// ── Main Export ──────────────────────────────────────────────────────────────

/**
 * Aggregate workspace data for proactive digest.
 */
export async function aggregateWorkspaceData(
  workspaceId: string,
  config: ProactiveFeedConfig
): Promise<AggregatedData> {
  logger.info({ workspaceId }, "Aggregating workspace data");

  const include = config.include ?? {};

  const [
    tasksDue,
    pendingProposals,
    recentEntities,
    recentCaptures,
    activitySummary,
  ] = await Promise.all([
    include.tasksDue !== false
      ? getTasksDue(workspaceId, include.tasksDueDays ?? 3)
      : Promise.resolve([]),
    include.pendingProposals !== false
      ? getPendingProposals(workspaceId)
      : Promise.resolve([]),
    include.recentEntities !== false
      ? getRecentEntities(workspaceId, include.recentEntitiesHours ?? 24)
      : Promise.resolve([]),
    include.recentCaptures !== false
      ? getRecentCaptures(workspaceId, include.recentCapturesHours ?? 24)
      : Promise.resolve([]),
    include.activitySummary !== false
      ? getActivitySummary(workspaceId, include.recentEntitiesHours ?? 24)
      : Promise.resolve({
          entitiesCreated: 0,
          entitiesUpdated: 0,
          proposalsCreated: 0,
          capturesCreated: 0,
        }),
  ]);

  const result: AggregatedData = {
    tasksDue,
    pendingProposals,
    recentEntities,
    recentCaptures,
    activitySummary,
  };

  logger.info(
    {
      workspaceId,
      tasksDue: tasksDue.length,
      pendingProposals: pendingProposals.length,
      recentEntities: recentEntities.length,
      recentCaptures: recentCaptures.length,
    },
    "Aggregation complete"
  );

  return result;
}
