/**
 * Side-Effect Emitter
 *
 * Enqueues async side-effect jobs (search indexing, notifications, etc.)
 * after successful synchronous CRUD operations.
 *
 * Replaces the old Inngest-based event forwarding for side-effects.
 */

import { getBoss } from "./boss.js";
import { createLogger, config } from "@synap-core/core";

const logger = createLogger({ module: "side-effects" });

export interface SideEffectPayload {
  subjectType: string;
  action: string;
  subjectId: string;
  userId: string;
  /** Pass null for workspace-less (hydration / pod-wide) operations. */
  workspaceId?: string | null;
  data?: Record<string, unknown>;
  /** Automation chain tracking — prevents circular triggers */
  automationContext?: {
    automationRunId: string;
    automationId: string;
    chainDepth: number;
    rootRunId?: string;
    chainAutomationIds?: string[];
  };
}

/**
 * Enqueue side-effect jobs after a successful CRUD operation.
 *
 * This is fire-and-forget — failures in side-effects don't affect
 * the CRUD response. pg-boss handles retries automatically.
 */
export async function emitSideEffects(
  payload: SideEffectPayload
): Promise<void> {
  try {
    const boss = getBoss();

    // 1. Search indexing (Typesense)
    const collectionMap: Record<string, string> = {
      entity: "entities",
      document: "documents",
      view: "views",
      chatThread: "chat_threads",
      agent: "agents",
    };

    const collection = collectionMap[payload.subjectType];
    if (collection) {
      await boss.send("search-index", {
        collection,
        operation: payload.action === "delete" ? "delete" : "upsert",
        documentId: payload.subjectId,
        timestamp: Date.now(),
      });
    }

    // 2. Entity embedding (for entity create/update)
    // Skip on shared pods where vector search is disabled
    if (
      config.server.vectorSearchEnabled &&
      payload.subjectType === "entity" &&
      (payload.action === "create" || payload.action === "update")
    ) {
      await boss.send("entity-embedding", {
        entityId: payload.subjectId,
        userId: payload.userId,
        workspaceId: payload.workspaceId,
      });
    }

    // 3. Webhook delivery
    await boss.send("webhook-delivery", {
      eventType: `${payload.subjectType}.${payload.action}.completed`,
      subjectId: payload.subjectId,
      userId: payload.userId,
      workspaceId: payload.workspaceId,
      data: payload.data,
    });

    // 4. Cross-thread notifications (for entity/document updates)
    if (
      (payload.subjectType === "entity" ||
        payload.subjectType === "document") &&
      payload.action === "update"
    ) {
      await boss.send("cross-thread-notify", {
        subjectType: payload.subjectType,
        subjectId: payload.subjectId,
        userId: payload.userId,
        workspaceId: payload.workspaceId,
      });
    }

    // 5. Automation trigger matching
    if (payload.workspaceId) {
      await boss.send("automation-trigger-match", {
        eventType: `${payload.subjectType}.${payload.action}.completed`,
        subjectId: payload.subjectId,
        userId: payload.userId,
        workspaceId: payload.workspaceId,
        data: payload.data,
        automationContext: payload.automationContext,
      });
    }

    // 6. Capture pattern nudge — post automation suggestion when a profile type
    //    accumulates enough captures in the last 7 days.
    if (
      payload.subjectType === "capture" &&
      payload.action === "complete" &&
      Array.isArray(payload.data?.profileSlugs) &&
      (payload.data.profileSlugs as string[]).length > 0
    ) {
      await boss.send("capture-pattern-nudge", {
        userId: payload.userId,
        workspaceId: payload.workspaceId ?? null,
        profileSlugs: payload.data.profileSlugs as string[],
      });
    }

    // 7. Hydration summary — proactive welcome message after import review.
    // Fired from capture.executeWithSchema once the import pipeline completes.
    // The worker resolves the personal channel + inserts a single AI greeting
    // summarizing what was just imported. Fire-and-forget, no retries.
    if (payload.subjectType === "hydration" && payload.action === "imported") {
      await boss.send(
        "hydration-summary-post",
        {
          userId: payload.userId,
          workspaceId: payload.workspaceId ?? null,
          data: payload.data ?? {},
        },
        {
          // Delay so the user sees /home render before the message pops.
          startAfter: new Date(Date.now() + 6_000),
          // Welcome message is best-effort — do not retry on failure.
          retryLimit: 0,
        }
      );
    }
  } catch (error) {
    // Side-effects are non-critical — log and move on
    logger.warn(
      { err: error, subjectType: payload.subjectType, action: payload.action },
      "Failed to enqueue side-effects (non-fatal)"
    );
  }
}
