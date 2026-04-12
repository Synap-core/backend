/**
 * Feed Proactive Executor Worker
 *
 * Processes proactive feed execution jobs.
 * - Queries DB for workspace activity
 * - Calls IS to summarize into digest
 * - Posts batch message
 * - Emits 'feed.execution.completed' event
 */

import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { db, eq, eventRepository } from "@synap/database";
import { channels, messages } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "../emit-side-effects.js";
import { aggregateWorkspaceData } from "../fetchers/proactive-aggregator.js";
import type {
  FeedExecutionPayload,
  ProactiveFeedConfig,
  FeedMessageMetadata,
} from "@synap/api/types/feed-config";
import { MessageRole, MessageAuthorType } from "@synap/database/schema";

const logger = createLogger({ module: "feed-proactive-executor" });

// ── Types ────────────────────────────────────────────────────────────────────

interface DigestSummary {
  title: string;
  content: string;
  insights: string[];
  priority: "low" | "medium" | "high";
}

// ── IS Summarization ─────────────────────────────────────────────────────────

/**
 * Call Intelligence Service to summarize aggregated data.
 * Returns stub digest if IS not ready.
 */
async function summarizeWithIS(
  data: Awaited<ReturnType<typeof aggregateWorkspaceData>>,
  config: ProactiveFeedConfig,
  _userId: string,
  _workspaceId?: string
): Promise<DigestSummary> {
  const isUrl = process.env.INTELLIGENCE_HUB_URL;
  const isApiKey = process.env.INTELLIGENCE_HUB_API_KEY;

  const summarization = config.summarization || {};
  const style = summarization.style || "brief";

  if (!isUrl || !isApiKey) {
    logger.warn("IS not configured, using stub summarization");
    return generateStubDigest(data, style);
  }

  // TODO: Implement actual IS call for summarization
  logger.info("Summarizing with IS (stub)");
  return generateStubDigest(data, style);
}

/**
 * Generate stub digest when IS is unavailable.
 */
function generateStubDigest(
  data: Awaited<ReturnType<typeof aggregateWorkspaceData>>,
  style: string
): DigestSummary {
  const parts: string[] = [];
  const insights: string[] = [];

  // Title
  const now = new Date();
  const title = `Workspace Update — ${now.toLocaleDateString()}`;

  parts.push(`## 📊 ${title}`);
  parts.push("");

  // Activity summary
  const summary = data.activitySummary;
  if (summary.entitiesCreated > 0 || summary.entitiesUpdated > 0) {
    parts.push(
      `**Activity:** ${summary.entitiesCreated} created, ${summary.entitiesUpdated} updated`
    );
    parts.push("");
  }

  // Tasks due
  if (data.tasksDue.length > 0) {
    parts.push(`### 📝 Tasks Due Soon (${data.tasksDue.length})`);
    const displayTasks =
      style === "brief"
        ? data.tasksDue.slice(0, 3)
        : data.tasksDue.slice(0, 10);
    for (const task of displayTasks) {
      parts.push(
        `- **${task.title}**${task.dueDate ? ` — Due ${task.dueDate}` : ""}`
      );
    }
    if (data.tasksDue.length > displayTasks.length) {
      parts.push(`- ...and ${data.tasksDue.length - displayTasks.length} more`);
    }
    parts.push("");

    if (data.tasksDue.length > 5) {
      insights.push(
        `You have ${data.tasksDue.length} tasks due soon. Consider prioritizing your work.`
      );
    }
  }

  // Pending proposals
  if (data.pendingProposals.length > 0) {
    parts.push(`### ⚡ Pending Proposals (${data.pendingProposals.length})`);
    const displayProposals =
      style === "brief"
        ? data.pendingProposals.slice(0, 3)
        : data.pendingProposals.slice(0, 5);
    for (const proposal of displayProposals) {
      parts.push(`- **${proposal.title}**`);
    }
    if (data.pendingProposals.length > displayProposals.length) {
      parts.push(
        `- ...and ${data.pendingProposals.length - displayProposals.length} more`
      );
    }
    parts.push("");

    insights.push(
      `You have ${data.pendingProposals.length} proposals awaiting review.`
    );
  }

  // Recent entities
  if (data.recentEntities.length > 0 && style !== "brief") {
    parts.push(`### 📄 Recent Items (${data.recentEntities.length})`);
    const displayEntities = data.recentEntities.slice(0, 5);
    for (const entity of displayEntities) {
      parts.push(`- **${entity.title}** (${entity.type})`);
    }
    parts.push("");
  }

  // Recent captures
  if (data.recentCaptures.length > 0) {
    parts.push(`### 📥 Recent Captures (${data.recentCaptures.length})`);
    const displayCaptures =
      style === "brief"
        ? data.recentCaptures.slice(0, 3)
        : data.recentCaptures.slice(0, 5);
    for (const capture of displayCaptures) {
      parts.push(`- **${capture.title}**`);
      if (capture.url) {
        parts.push(`  ${capture.url}`);
      }
    }
    parts.push("");
  }

  // Determine priority
  let priority: "low" | "medium" | "high" = "low";
  if (data.tasksDue.length > 5 || data.pendingProposals.length > 3) {
    priority = "high";
  } else if (data.tasksDue.length > 0 || data.pendingProposals.length > 0) {
    priority = "medium";
  }

  return {
    title,
    content: parts.join("\n"),
    insights,
    priority,
  };
}

// ── Message Posting ──────────────────────────────────────────────────────────

/**
 * Post proactive digest as message.
 */
async function postDigest(
  channelId: string,
  userId: string,
  digest: DigestSummary,
  runId: string
): Promise<string> {
  const messageId = randomUUID();
  const hash = createHash("sha256")
    .update(`${messageId}${digest.content}`)
    .digest("hex");

  const metadata: FeedMessageMetadata = {
    feedType: "proactive",
    batched: true,
    aiClassified: true,
  };

  await db.insert(messages).values({
    id: messageId,
    channelId,
    userId,
    role: MessageRole.SYSTEM,
    authorType: MessageAuthorType.BOT,
    content: digest.content,
    hash,
    previousHash: "",
    metadata: {
      ...metadata,
      feedRunId: runId,
      priority: digest.priority,
      insights: digest.insights,
    },
  });

  logger.info(
    { messageId, priority: digest.priority },
    "Posted proactive digest"
  );

  return messageId;
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export async function handleFeedProactiveExecute(job: {
  data: FeedExecutionPayload;
}): Promise<void> {
  const { channelId, userId, workspaceId, config, runId } = job.data;

  logger.info(
    { channelId, runId, workspaceId },
    "Starting proactive feed execution"
  );

  const startTime = Date.now();
  const proactiveConfig = config as ProactiveFeedConfig;

  try {
    // 1. Validate workspace
    if (!workspaceId) {
      throw new Error("Proactive feed requires workspaceId");
    }

    // 2. Aggregate workspace data
    const aggregatedData = await aggregateWorkspaceData(
      workspaceId,
      proactiveConfig
    );

    // Check if there's anything to report
    const hasContent =
      aggregatedData.tasksDue.length > 0 ||
      aggregatedData.pendingProposals.length > 0 ||
      aggregatedData.recentEntities.length > 0 ||
      aggregatedData.recentCaptures.length > 0;

    if (!hasContent) {
      logger.info("No content to include in proactive digest");
      await updateFeedStatus(
        channelId,
        {
          lastRunAt: new Date().toISOString(),
          lastRunStatus: "success",
          lastRunItemCount: 0,
        },
        config
      );
      return;
    }

    // 3. Summarize with IS
    const digest = await summarizeWithIS(
      aggregatedData,
      proactiveConfig,
      userId,
      workspaceId
    );

    // 4. Post digest
    const messageId = await postDigest(channelId, userId, digest, runId);

    // 5. Emit side effects
    emitSideEffects({
      subjectType: "feed",
      action: "execution",
      subjectId: runId,
      userId,
      workspaceId,
      data: {
        channelId,
        feedType: "proactive",
        messageId,
        priority: digest.priority,
        tasksDue: aggregatedData.tasksDue.length,
        pendingProposals: aggregatedData.pendingProposals.length,
        recentEntities: aggregatedData.recentEntities.length,
        recentCaptures: aggregatedData.recentCaptures.length,
        durationMs: Date.now() - startTime,
      },
    }).catch(() => {});

    // 6. Emit event
    eventRepository
      .append({
        id: randomUUID(),
        version: "v1",
        type: "feed.execution.completed",
        subjectType: "feed",
        subjectId: runId,
        userId,
        source: "system",
        timestamp: new Date(),
        data: {
          channelId,
          feedType: "proactive",
          messageId,
          priority: digest.priority,
          tasksDue: aggregatedData.tasksDue.length,
          pendingProposals: aggregatedData.pendingProposals.length,
          recentEntities: aggregatedData.recentEntities.length,
          recentCaptures: aggregatedData.recentCaptures.length,
          durationMs: Date.now() - startTime,
        },
      })
      .catch(() => {});

    // 7. Update feed status
    await updateFeedStatus(
      channelId,
      {
        lastRunAt: new Date().toISOString(),
        lastRunStatus: "success",
        lastRunItemCount: 1,
      },
      config
    );

    logger.info(
      { runId, durationMs: Date.now() - startTime },
      "Proactive feed execution complete"
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ err, channelId, runId }, "Proactive feed execution failed");

    // Update status with error
    await updateFeedStatus(
      channelId,
      {
        lastRunAt: new Date().toISOString(),
        lastRunStatus: "error",
        lastError: error,
      },
      config
    );

    throw err;
  }
}

/**
 * Update feed status in channel metadata.
 */
async function updateFeedStatus(
  channelId: string,
  status: {
    lastRunAt: string;
    lastRunStatus: "success" | "error" | "running";
    lastRunItemCount?: number;
    lastError?: string;
  },
  config: ProactiveFeedConfig
): Promise<void> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { metadata: true },
  });

  if (!channel) return;

  const metadata = (channel.metadata as Record<string, unknown>) ?? {};
  const currentStatus = (metadata.feedStatus as Record<string, unknown>) ?? {};

  // Calculate next run
  const nextRunAt = calculateNextRun(config.schedule, config.timezone);

  await db
    .update(channels)
    .set({
      metadata: {
        ...metadata,
        feedStatus: {
          ...currentStatus,
          ...status,
          nextRunAt: nextRunAt.toISOString(),
          currentRunId: undefined, // Clear current run
        },
      },
      updatedAt: new Date(),
    })
    .where(eq(channels.id, channelId));
}

/**
 * Calculate next run time from cron expression.
 */
function calculateNextRun(cronExpr: string, timezone: string): Date {
  const now = new Date();

  // Simple implementations for common patterns
  const minuteMatch = cronExpr.match(/^\*\/([0-9]+) \* \* \* \*$/);
  if (minuteMatch) {
    const interval = parseInt(minuteMatch[1], 10);
    const next = new Date(now);
    const currentMinutes = next.getMinutes();
    const nextMinutes = Math.ceil((currentMinutes + 1) / interval) * interval;
    if (nextMinutes >= 60) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(nextMinutes - 60);
    } else {
      next.setMinutes(nextMinutes);
    }
    next.setSeconds(0);
    next.setMilliseconds(0);
    return next;
  }

  const hourMatch = cronExpr.match(/^0 \*\/([0-9]+) \* \* \*$/);
  if (hourMatch) {
    const interval = parseInt(hourMatch[1], 10);
    const next = new Date(now);
    const currentHours = next.getHours();
    const nextHours = Math.ceil((currentHours + 1) / interval) * interval;
    if (nextHours >= 24) {
      next.setDate(next.getDate() + 1);
      next.setHours(0);
    } else {
      next.setHours(nextHours);
    }
    next.setMinutes(0);
    next.setSeconds(0);
    return next;
  }

  const dailyMatch = cronExpr.match(/^0 ([0-9]+) \* \* \*$/);
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1], 10);
    const next = new Date(now);
    next.setHours(hour);
    next.setMinutes(0);
    next.setSeconds(0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  // Default: 24 hours for proactive
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9);
  next.setMinutes(0);
  next.setSeconds(0);
  return next;
}
