/**
 * Feed Proactive Executor Worker
 *
 * Processes proactive feed execution jobs.
 * - Queries DB for workspace activity
 * - Calls IS to summarize into digest
 * - Posts batch message
 * - Emits 'feed.execution.completed' event
 *
 * Enhanced with:
 * - Try-catch around IS calls with fallback
 * - Partial success handling
 * - Detailed error logging with context
 * - Retry logic for external calls
 */

import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { db, eq, eventRepository } from "@synap/database";
import { getDefaultActiveService } from "@synap/intelligence-client";
import { channels, messages } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import { aggregateWorkspaceData } from "../fetchers/proactive-aggregator.js";
import type {
  FeedExecutionPayload,
  ProactiveFeedConfig,
  FeedMessageMetadata,
} from "@synap-core/types";
import { MessageRole, MessageAuthorType } from "@synap/database/schema";
import { calculateNextRun } from "../utils/feed-helpers.js";
import { withRetry, FEED_RETRY_OPTIONS } from "@synap/shared-utils";

const logger = createLogger({ module: "feed-proactive-executor" });

// ── Type Guards ───────────────────────────────────────────────────────────────

function isProactiveFeedConfig(
  config: FeedExecutionPayload["config"]
): config is ProactiveFeedConfig {
  return config.feedType === "proactive";
}

// ── Types ────────────────────────────────────────────────────────────────────

interface DigestSummary {
  title: string;
  content: string;
  insights: string[];
  priority: "low" | "medium" | "high";
}

interface WorkspaceData {
  activitySummary: {
    entitiesCreated: number;
    entitiesUpdated: number;
  };
  tasksDue: Array<{
    title: string;
    dueDate?: string;
  }>;
  pendingProposals: Array<{
    title: string;
  }>;
  recentEntities: Array<{
    title: string;
    type: string;
    createdAt: Date;
  }>;
  recentCaptures: Array<{
    title: string;
    url?: string;
  }>;
}

interface ExecutionResult {
  success: boolean;
  hasContent: boolean;
  messagePosted: boolean;
  errors: string[];
  partialSuccess: boolean;
}

// ── IS Summarization ─────────────────────────────────────────────────────────

/**
 * Generate basic digest when IS is unavailable.
 */
function generateBasicDigest(
  data: WorkspaceData,
  config: ProactiveFeedConfig
): string {
  const parts: string[] = [];
  const style = config.summarization?.style || "brief";

  parts.push(`## 📊 Workspace Update — ${new Date().toLocaleDateString()}`);
  parts.push("");

  const summary = data.activitySummary;
  if (summary.entitiesCreated > 0 || summary.entitiesUpdated > 0) {
    parts.push(
      `**Activity:** ${summary.entitiesCreated} created, ${summary.entitiesUpdated} updated`
    );
    parts.push("");
  }

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
    parts.push("");
  }

  if (data.pendingProposals.length > 0) {
    parts.push(`### ⚡ Pending Proposals (${data.pendingProposals.length})`);
    const displayProposals =
      style === "brief"
        ? data.pendingProposals.slice(0, 3)
        : data.pendingProposals.slice(0, 5);
    for (const proposal of displayProposals) {
      parts.push(`- **${proposal.title}**`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Generate digest via Intelligence Service with retry logic.
 */
async function generateDigestWithIS(
  data: WorkspaceData,
  config: ProactiveFeedConfig
): Promise<string> {
  // Canonical IS credential resolution (decrypted DB key), not stale env.
  const { endpoint: isUrl, apiKey: isApiKey } = await getDefaultActiveService();

  if (!isUrl || !isApiKey) {
    logger.warn("IS not configured, using basic digest fallback");
    return generateBasicDigest(data, config);
  }

  try {
    const response = await withRetry(
      async () => {
        const res = await fetch(`${isUrl}/v1/tools/generate_feed_digest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${isApiKey}`,
          },
          body: JSON.stringify({
            items: data.recentEntities.map((e) => ({
              title: e.title,
              type: e.type,
              createdAt: e.createdAt,
            })),
            style: config.summarization?.style || "brief",
            maxLength: 500,
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          throw new Error(`IS summarization failed: ${response.status}`);
        }

        return res;
      },
      {
        ...FEED_RETRY_OPTIONS,
        maxRetries: 2,
        onRetry: (error: Error, attempt: number) => {
          logger.warn(
            { error: error.message, attempt },
            "IS summarization retry"
          );
        },
      }
    );

    const result = (await response.json()) as {
      digest?: string;
      insights?: unknown;
    };

    // Validate response
    const digest = result.digest;
    if (!digest || typeof digest !== "string") {
      logger.warn("IS returned invalid digest structure, using fallback");
      throw new Error("Invalid IS response: missing digest");
    }

    return digest;
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        isUrl: isUrl?.replace(/\/v1.*$/, ""),
      },
      "IS summarization failed after retries, using fallback"
    );
    // Fallback: generate basic markdown summary
    return generateBasicDigest(data, config);
  }
}

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
  const summarization = config.summarization || {};
  const style = summarization.style || "brief";

  const workspaceData: WorkspaceData = {
    activitySummary: data.activitySummary,
    tasksDue: data.tasksDue,
    pendingProposals: data.pendingProposals,
    recentEntities: data.recentEntities,
    recentCaptures: data.recentCaptures,
  };

  try {
    const digest = await generateDigestWithIS(workspaceData, config);

    // Determine priority based on content
    let priority: "low" | "medium" | "high" = "low";
    if (data.tasksDue.length > 5 || data.pendingProposals.length > 3) {
      priority = "high";
    } else if (data.tasksDue.length > 0 || data.pendingProposals.length > 0) {
      priority = "medium";
    }

    const insights: string[] = [];
    if (data.tasksDue.length > 5) {
      insights.push(
        `You have ${data.tasksDue.length} tasks due soon. Consider prioritizing your work.`
      );
    }
    if (data.pendingProposals.length > 0) {
      insights.push(
        `You have ${data.pendingProposals.length} proposals awaiting review.`
      );
    }

    return {
      title: `Workspace Update — ${new Date().toLocaleDateString()}`,
      content: digest,
      insights,
      priority,
    };
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to generate IS digest completely, using emergency stub"
    );
    return generateStubDigest(data, style);
  }
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
 * Enhanced with error handling.
 */
async function postDigest(
  channelId: string,
  userId: string,
  digest: DigestSummary,
  _runId: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const messageId = randomUUID();
    const hash = createHash("sha256")
      .update(`${messageId}${digest.content}`)
      .digest("hex");

    const metadata: FeedMessageMetadata = {
      feedItem: true,
      feedType: "proactive",
      source: {
        platform: "proactive",
        url: "",
      },
      topics: [],
      categories: [],
      relevanceScore: 0.5,
      aiClassified: true,
      crossFeeds: [],
      batched: true,
    };

    await db.insert(messages).values({
      channelId,
      userId,
      role: MessageRole.SYSTEM,
      authorType: MessageAuthorType.BOT,
      content: digest.content,
      hash,
      previousHash: "",
      metadata: metadata as unknown as null,
    });

    logger.info(
      { messageId, priority: digest.priority },
      "Posted proactive digest"
    );

    return { success: true, messageId };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      { error: errorMsg, channelId, userId },
      "Failed to post proactive digest"
    );
    return { success: false, error: errorMsg };
  }
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export async function handleFeedProactiveExecute(job: {
  data: FeedExecutionPayload;
}): Promise<ExecutionResult> {
  const { channelId, userId, workspaceId, config, runId } = job.data;
  const errors: string[] = [];

  // Type guard: ensure this is a proactive feed config
  if (!isProactiveFeedConfig(config)) {
    const error = `Expected proactive feed config, got ${config.feedType}`;
    logger.error({ channelId, feedType: config.feedType }, error);
    throw new Error(error);
  }

  logger.info(
    { channelId, runId, workspaceId },
    "Starting proactive feed execution"
  );

  const startTime = Date.now();
  const proactiveConfig = config;

  try {
    // 1. Validate workspace
    if (!workspaceId) {
      const error = "Proactive feed requires workspaceId";
      logger.error({ channelId, runId }, error);
      throw new Error(error);
    }

    // 2. Aggregate workspace data
    let aggregatedData: Awaited<ReturnType<typeof aggregateWorkspaceData>>;
    try {
      aggregatedData = await aggregateWorkspaceData(
        workspaceId,
        proactiveConfig
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { error: errorMsg, workspaceId, channelId },
        "Failed to aggregate workspace data"
      );
      errors.push(`Data aggregation failed: ${errorMsg}`);

      await updateFeedStatus(
        channelId,
        {
          lastRunAt: new Date().toISOString(),
          lastRunStatus: "error",
          lastError: errorMsg,
        },
        config
      );

      return {
        success: false,
        hasContent: false,
        messagePosted: false,
        errors,
        partialSuccess: false,
      };
    }

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

      return {
        success: true,
        hasContent: false,
        messagePosted: false,
        errors: [],
        partialSuccess: false,
      };
    }

    // 3. Summarize with IS (with fallback)
    let digest: DigestSummary;
    try {
      digest = await summarizeWithIS(
        aggregatedData,
        proactiveConfig,
        userId,
        workspaceId
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { error: errorMsg, channelId, workspaceId },
        "Summarization failed completely, using emergency stub"
      );
      errors.push(`Summarization failed: ${errorMsg}`);

      // Emergency fallback
      digest = generateStubDigest(
        aggregatedData,
        proactiveConfig.summarization?.style || "brief"
      );
    }

    // 4. Post digest
    const postResult = await postDigest(channelId, userId, digest, runId);

    if (!postResult.success) {
      errors.push(`Post failed: ${postResult.error}`);

      await updateFeedStatus(
        channelId,
        {
          lastRunAt: new Date().toISOString(),
          lastRunStatus: "error",
          lastError: postResult.error,
        },
        config
      );

      return {
        success: false,
        hasContent: true,
        messagePosted: false,
        errors,
        partialSuccess: false,
      };
    }

    // 5. Emit side effects (non-fatal)
    try {
      await emitSideEffects({
        subjectType: "feed",
        action: "execution",
        subjectId: runId,
        userId,
        workspaceId,
        data: {
          channelId,
          feedType: "proactive",
          messageId: postResult.messageId,
          priority: digest.priority,
          tasksDue: aggregatedData.tasksDue.length,
          pendingProposals: aggregatedData.pendingProposals.length,
          recentEntities: aggregatedData.recentEntities.length,
          recentCaptures: aggregatedData.recentCaptures.length,
          durationMs: Date.now() - startTime,
          hasErrors: errors.length > 0,
        },
      });
    } catch (error) {
      logger.warn(
        { error, feedId: channelId, messageId: postResult.messageId },
        "Side effects failed (non-fatal)"
      );
    }

    // 6. Emit event (non-fatal)
    try {
      await eventRepository.append({
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
          messageId: postResult.messageId,
          priority: digest.priority,
          tasksDue: aggregatedData.tasksDue.length,
          pendingProposals: aggregatedData.pendingProposals.length,
          recentEntities: aggregatedData.recentEntities.length,
          recentCaptures: aggregatedData.recentCaptures.length,
          durationMs: Date.now() - startTime,
          errors: errors.length > 0 ? errors : undefined,
        },
      });
    } catch (error) {
      logger.warn(
        { error, feedId: channelId },
        "Event append failed (non-fatal)"
      );
    }

    // 7. Update feed status
    const partialSuccess = errors.length > 0;
    await updateFeedStatus(
      channelId,
      {
        lastRunAt: new Date().toISOString(),
        lastRunStatus: partialSuccess ? "partial" : "success",
        lastRunItemCount: 1,
        lastError: partialSuccess ? errors.join("; ") : undefined,
      },
      config
    );

    logger.info(
      {
        runId,
        durationMs: Date.now() - startTime,
        messageId: postResult.messageId,
        errors: errors.length,
        partialSuccess,
      },
      "Proactive feed execution complete"
    );

    return {
      success: true,
      hasContent: true,
      messagePosted: true,
      errors,
      partialSuccess,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        err,
        channelId,
        runId,
        stack: err instanceof Error ? err.stack : undefined,
      },
      "Proactive feed execution failed catastrophically"
    );
    errors.push(`Catastrophic failure: ${error}`);

    // Update status with error
    try {
      await updateFeedStatus(
        channelId,
        {
          lastRunAt: new Date().toISOString(),
          lastRunStatus: "error",
          lastError: error,
        },
        config
      );
    } catch (statusError) {
      logger.error({ statusError }, "Failed to update feed status after error");
    }

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
    lastRunStatus: "success" | "error" | "running" | "partial";
    lastRunItemCount?: number;
    lastError?: string;
  },
  config: ProactiveFeedConfig
): Promise<void> {
  try {
    const channel = await db.query.channels.findFirst({
      where: eq(channels.id, channelId),
      columns: { metadata: true },
    });

    if (!channel) {
      logger.warn({ channelId }, "Channel not found for status update");
      return;
    }

    const metadata = (channel.metadata as Record<string, unknown>) ?? {};
    const currentStatus =
      (metadata.feedStatus as Record<string, unknown>) ?? {};

    // Calculate next run
    const schedule = config.schedule ?? "0 9 * * *";
    const timezone = config.timezone ?? "UTC";
    const nextRunAt = calculateNextRun(schedule, timezone);

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

    logger.debug(
      { channelId, status: status.lastRunStatus },
      "Feed status updated"
    );
  } catch (error) {
    logger.error({ error, channelId }, "Failed to update feed status");
    // Non-fatal: don't throw
  }
}
