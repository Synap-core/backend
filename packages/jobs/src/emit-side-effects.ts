/**
 * Side-Effect Emitter
 *
 * Enqueues async side-effect jobs (search indexing, notifications, etc.)
 * after successful synchronous CRUD operations.
 *
 * Replaces the old Inngest-based event forwarding for side-effects.
 */

import { getBoss } from "./boss.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "side-effects" });

export interface SideEffectPayload {
  subjectType: string;
  action: string;
  subjectId: string;
  userId: string;
  workspaceId?: string;
  data?: Record<string, unknown>;
}

/**
 * Enqueue side-effect jobs after a successful CRUD operation.
 *
 * This is fire-and-forget — failures in side-effects don't affect
 * the CRUD response. pg-boss handles retries automatically.
 */
export async function emitSideEffects(payload: SideEffectPayload): Promise<void> {
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
    if (
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
      (payload.subjectType === "entity" || payload.subjectType === "document") &&
      payload.action === "update"
    ) {
      await boss.send("cross-thread-notify", {
        subjectType: payload.subjectType,
        subjectId: payload.subjectId,
        userId: payload.userId,
        workspaceId: payload.workspaceId,
      });
    }
  } catch (error) {
    // Side-effects are non-critical — log and move on
    logger.warn(
      { err: error, subjectType: payload.subjectType, action: payload.action },
      "Failed to enqueue side-effects (non-fatal)"
    );
  }
}
