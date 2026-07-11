/**
 * Side-Effect Emitter
 *
 * Enqueues async side-effect jobs (search indexing, notifications, etc.)
 * after successful synchronous CRUD operations.
 *
 * Replaces the old Inngest-based event forwarding for side-effects.
 *
 * The individual reactions live in the reactor registry (reactors.ts). Each is
 * registered once at module load; `emitSideEffects` iterates them in
 * registration order. Adding a new reaction = `registerReactor(...)`, never an
 * edit to the emit loop below.
 */

import { getBoss } from "./boss.js";
import { createLogger, config } from "@synap-core/core";
import { registerReactor, getReactors } from "./reactors.js";
import type { Reactor } from "./reactors.js";

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
  /**
   * Focus session that produced this event. When set, the automation-trigger
   * matcher resolves the session's playbook and ALSO selects automations linked
   * to that playbook, so playbook-scoped automations fire for entities produced
   * by their session. Threaded from the materialize chokepoint.
   */
  sessionId?: string | null;
}

// Re-export the reactor registry surface so future reactions can register
// without importing emitSideEffects' internals.
export { registerReactor, getReactors };
export type { Reactor, ReactorDeps, ReactorPayload } from "./reactors.js";

// ============================================================================
// Built-in reactors — registered at module load, in their original order.
// Each owns the EXACT guard + boss.send it had inline in emitSideEffects.
// ============================================================================

// 1. Search indexing (Typesense)
const searchIndexReactor: Reactor = {
  id: "search-index",
  async handler(payload, { boss }) {
    const collectionMap: Record<string, string> = {
      entity: "entities",
      document: "documents",
      view: "views",
      chatThread: "chat_threads",
      agent: "agents",
      channel_message: "messages",
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
  },
};

// 2. Entity embedding (for entity create/update)
// Skip on shared pods where vector search is disabled
const entityEmbeddingReactor: Reactor = {
  id: "entity-embedding",
  match: (payload) =>
    config.server.vectorSearchEnabled &&
    payload.subjectType === "entity" &&
    (payload.action === "create" || payload.action === "update"),
  async handler(payload, { boss }) {
    await boss.send(
      "entity-embedding",
      {
        entityId: payload.subjectId,
        userId: payload.userId,
        workspaceId: payload.workspaceId,
      },
      // Debounce per entity: mirrors the direct entities.update path's
      // singleton throttle so burst writers (e.g. bulk facet attach) can't
      // enqueue N embedding-model calls for the same row.
      {
        singletonKey: `entity-embedding:${payload.subjectId}`,
        singletonSeconds: 30,
      }
    );
  },
};

// 3. Webhook delivery (runs for every emit)
const webhookDeliveryReactor: Reactor = {
  id: "webhook-delivery",
  async handler(payload, { boss }) {
    await boss.send("webhook-delivery", {
      eventType: `${payload.subjectType}.${payload.action}.completed`,
      subjectId: payload.subjectId,
      userId: payload.userId,
      workspaceId: payload.workspaceId,
      data: payload.data,
    });
  },
};

// 4. Cross-thread notifications (for entity/document updates)
const crossThreadNotifyReactor: Reactor = {
  id: "cross-thread-notify",
  match: (payload) =>
    (payload.subjectType === "entity" || payload.subjectType === "document") &&
    payload.action === "update",
  async handler(payload, { boss }) {
    await boss.send("cross-thread-notify", {
      subjectType: payload.subjectType,
      subjectId: payload.subjectId,
      userId: payload.userId,
      workspaceId: payload.workspaceId,
    });
  },
};

// 5. Automation trigger matching — THE trigger hop (load-bearing, byte-identical)
const automationTriggerMatchReactor: Reactor = {
  id: "automation-trigger-match",
  match: (payload) => Boolean(payload.workspaceId),
  async handler(payload, { boss }) {
    await boss.send("automation-trigger-match", {
      eventType: `${payload.subjectType}.${payload.action}.completed`,
      subjectId: payload.subjectId,
      userId: payload.userId,
      workspaceId: payload.workspaceId,
      data: payload.data,
      automationContext: payload.automationContext,
      sessionId: payload.sessionId ?? null,
    });
  },
};

// 6. Hydration summary — proactive welcome message after import review.
// Fired from capture.executeWithSchema once the import pipeline completes.
// The worker resolves the personal channel + inserts a single AI greeting
// summarizing what was just imported. Fire-and-forget, no retries.
const hydrationSummaryReactor: Reactor = {
  id: "hydration-summary",
  match: (payload) =>
    payload.subjectType === "hydration" && payload.action === "imported",
  async handler(payload, { boss }) {
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
  },
};

// 7. Session recap — event-mode recap trigger. When a focus session advances to
// its `post` stage (in event mode: the bound event's endDate crossed and
// run-event-end flipped the session), enqueue the recap worker. This is the ONE
// decoupled seam: EVERY path that flips a session to `post` (cron, bridge,
// manual) flows through a `focus_session.stage_changed` emit and lands here.
// Fires pod-wide (no workspace required — sessions may be project-scoped).
const sessionRecapReactor: Reactor = {
  id: "session-recap-trigger",
  match: (payload) =>
    payload.subjectType === "focus_session" &&
    payload.action === "stage_changed" &&
    payload.data?.toStage === "post",
  async handler(payload, { boss }) {
    const sessionId =
      (payload.data?.sessionId as string | undefined) ?? payload.subjectId;
    await boss.send("session-recap", {
      sessionId,
      userId: payload.userId,
      workspaceId: payload.workspaceId ?? null,
    });
  },
};

// Registration order === original inline order. Do not reorder.
registerReactor(searchIndexReactor);
registerReactor(entityEmbeddingReactor);
registerReactor(webhookDeliveryReactor);
registerReactor(crossThreadNotifyReactor);
registerReactor(automationTriggerMatchReactor);
registerReactor(hydrationSummaryReactor);
registerReactor(sessionRecapReactor);

// ============================================================================

/**
 * Enqueue side-effect jobs after a successful CRUD operation.
 *
 * This is fire-and-forget — failures in side-effects don't affect
 * the CRUD response. pg-boss handles retries automatically.
 *
 * Error semantics (preserved from the original inline implementation):
 * the entire reactor sequence runs inside ONE try/catch. Reactors run
 * sequentially in registration order; if a reactor throws, the remaining
 * reactors are skipped and the error is logged (non-fatal). This is NOT
 * per-reactor isolation — it matches the prior behavior exactly.
 */
export async function emitSideEffects(
  payload: SideEffectPayload
): Promise<void> {
  try {
    const boss = getBoss();
    for (const reactor of getReactors()) {
      if (reactor.match && !reactor.match(payload)) continue;
      await reactor.handler(payload, { boss });
    }
  } catch (error) {
    // Side-effects are non-critical — log and move on
    logger.warn(
      { err: error, subjectType: payload.subjectType, action: payload.action },
      "Failed to enqueue side-effects (non-fatal)"
    );
  }
}
