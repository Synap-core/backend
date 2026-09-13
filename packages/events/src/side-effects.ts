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
  /**
   * THE `events` ROW this emit is about — the immutable audit record's id, not
   * anything reconstructed. Set by `recordDomainMutation` from the `EventRecord`
   * that `auditLog` has already returned by the time the fan-out runs, so it
   * costs no extra query.
   *
   * Forwarded by the `automation-trigger-match` reactor and stamped onto every
   * run the event opens (`automation_runs.trigger_event_id`, 0256), which is
   * what lets a spawned session be walked back to the FACT that caused it
   * rather than to a rebuilt JSONB envelope.
   *
   * Nullable: a bare `emitSideEffects` that fires WITHOUT a matching log row
   * (a facet change's parent-entity refresh, document re-indexing) genuinely
   * has no event to name, and so does a failed best-effort append. NULL means
   * "no event is claimed", never "the event was lost".
   *
   * ⚠️ A TOP-LEVEL field, and it must NEVER be moved into `data`.
   * `resolveAutomationEventFingerprintId` reads `data.eventId` FIRST, so a
   * per-event unique id there would give every event a unique fingerprint and
   * silently disable the D5 exactly-once claim that the `stableJsonHash`
   * fallback provides — turning a dedupe guarantee off as a side effect of
   * adding provenance. Pinned by
   * `automation-trigger-matcher.fingerprint-provenance.test.ts`.
   */
  eventId?: string | null;
  /**
   * WHERE this mutation came from, when that changes who should react to it.
   * `"sync"` = a bulk mirror of an external source (a connection sync run, or the
   * approval of its grouped import proposal). Absent = an ordinary write.
   *
   * Read by exactly ONE consumer: the automation-trigger matcher, which skips
   * event automations for a sync-origin payload unless the automation opted in
   * (`triggerConfig.includeSyncOrigin === true`) — a 200-contact first sync must
   * not fan out 200 enrollment runs. Every other reactor (search index,
   * embedding, webhooks, …) ignores it, so mirrored records stay searchable.
   * Pinned by `__tests__/side-effects.sync-origin.test.ts`.
   *
   * TOP-LEVEL, never `data.origin`: `data` is the automation-visible payload and
   * feeds the D5 event fingerprint.
   */
  origin?: "sync";
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
  // Fire on workspace-scoped events (unchanged) AND on pod-wide inbound messages
  // (external_message with a null workspace — a pod-wide Discord turn). The worker
  // matches a null-workspace event across the user's accessible workspaces (F1).
  match: (payload) =>
    Boolean(payload.workspaceId) || payload.subjectType === "external_message",
  async handler(payload, { boss }) {
    await boss.send("automation-trigger-match", {
      eventType: `${payload.subjectType}.${payload.action}.completed`,
      subjectId: payload.subjectId,
      userId: payload.userId,
      workspaceId: payload.workspaceId,
      data: payload.data,
      // Provenance: WHICH `events` row this is. Top-level, never inside `data`
      // — see the fingerprint warning on `SideEffectPayload.eventId`. Null for
      // an emit with no log row, which is the honest answer, not a loss.
      eventId: payload.eventId ?? null,
      automationContext: payload.automationContext,
      sessionId: payload.sessionId ?? null,
      // Sync-origin payloads reach the matcher (so an opted-in automation can
      // still fire); the matcher, not this reactor, decides who skips.
      ...(payload.origin ? { origin: payload.origin } : {}),
      // CONFUSED-DEPUTY GUARD: carry the event's ACTOR as the causal-chain
      // producer. Agent-authored governed writes emit with `userId = agentUserId`
      // (the Hub write door collapses the two), so this IS the producing agent
      // for an agent write and the human for a human write. The trigger matcher
      // threads it to the executor, which governs the fired automation's
      // THEN-actions against this producer — confirming agent-ness first, so a
      // human producer is a no-op (owner path unchanged).
      producerAgentUserId: payload.userId,
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

// 8. Connection sync approval — approving a connection's
// first `import.graph` with "keep syncing" on mints the connection's `auto`
// governance rule. Hangs off the ONE approved-proposal emit
// (`emitProposalReviewed`), so no approval door needs to know about sync. The
// payload carries no proposal type, so every approval enqueues; the worker loads
// the row and no-ops for anything that is not a connection sync. Idempotent
// (`ensureConnectionAutoRule`), so a redelivered job cannot mint a second rule.
const connectionSyncApprovalReactor: Reactor = {
  id: "connection-sync-approval",
  match: (payload) =>
    payload.subjectType === "proposal" && payload.action === "approved",
  async handler(payload, { boss }) {
    await enqueueConnectionSyncApproval(
      { proposalId: payload.subjectId, userId: payload.userId },
      boss
    );
  },
};

/**
 * THE one enqueue for the connection-sync-approval job — used by the reactor
 * above AND by the approval path for a pod-wide (workspace-less) proposal, which
 * `emitProposalReviewed` does not fan out. Same job shape + same singletonKey on
 * both, so a proposal reached by both can never be processed twice concurrently,
 * and `ensureConnectionAutoRule` is idempotent behind it.
 */
export async function enqueueConnectionSyncApproval(
  input: { proposalId: string; userId: string },
  boss: Pick<ReturnType<typeof getBoss>, "send"> = getBoss()
): Promise<void> {
  await boss.send(
    "connection-sync-approval",
    { proposalId: input.proposalId, userId: input.userId },
    { singletonKey: `connection-sync-approval:${input.proposalId}` }
  );
}

// Registration order === original inline order. Do not reorder.
registerReactor(searchIndexReactor);
registerReactor(entityEmbeddingReactor);
registerReactor(webhookDeliveryReactor);
registerReactor(crossThreadNotifyReactor);
registerReactor(automationTriggerMatchReactor);
registerReactor(hydrationSummaryReactor);
registerReactor(sessionRecapReactor);
registerReactor(connectionSyncApprovalReactor);

// ============================================================================

/**
 * Enqueue side-effect jobs after a successful CRUD operation.
 *
 * This is fire-and-forget — failures in side-effects don't affect
 * the CRUD response. pg-boss handles retries automatically.
 *
 * Error semantics: reactors run sequentially in registration order, each in
 * its OWN try/catch. A throwing reactor is logged (with its id) and skipped —
 * it can no longer starve the reactors after it (before this, ONE shared
 * try/catch meant reactor 1 throwing aborted embedding + automation enqueues,
 * the 2026-07-16 silent-failure shape). Ordering is otherwise unchanged.
 */
export async function emitSideEffects(
  payload: SideEffectPayload
): Promise<void> {
  let boss: ReturnType<typeof getBoss>;
  try {
    boss = getBoss();
  } catch (error) {
    // No queue → nothing can be enqueued; log once and bail (non-fatal).
    logger.warn(
      { err: error, subjectType: payload.subjectType, action: payload.action },
      "Failed to enqueue side-effects: pg-boss unavailable (non-fatal)"
    );
    return;
  }

  for (const reactor of getReactors()) {
    if (reactor.match && !reactor.match(payload)) continue;
    try {
      await reactor.handler(payload, { boss });
    } catch (error) {
      // One reactor failing must not starve the rest — isolate and continue.
      logger.warn(
        {
          err: error,
          reactorId: reactor.id,
          subjectType: payload.subjectType,
          action: payload.action,
        },
        "Side-effect reactor failed (non-fatal, skipping)"
      );
    }
  }
}
