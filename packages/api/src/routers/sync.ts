/**
 * Sync Endpoint — Pod-to-Pod Event Log Replication
 *
 * Hono REST route (NOT tRPC) mounted at /api/sync.
 *
 * POST /receive — accepts a batch of events from a push peer, materializes
 * them into local database tables (idempotent upserts), and stores them
 * in the local events table for audit trail. Includes LWW conflict resolution.
 *
 * GET /pull — serves local events to a pulling peer (mirror of push).
 * Used by bidirectional peers to pull events written during failover.
 *
 * GET /health — simple health check.
 */

import { Hono } from "hono";
import { z } from "zod";
import { createLogger, config } from "@synap-core/core";
import {
  db,
  syncPeers,
  events,
  messages,
  automations,
  automationRuns,
  intelligenceCommands,
  documents,
  documentVersions,
  proposals,
  focusSessions,
  widgetDefinitions,
  eq,
  and,
  or,
  inArray,
  isNull,
  drizzleSql,
  syncReceiveInputSchema,
  materializeBatch,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
} from "@synap/database";
import {
  intelligenceServices,
  channels,
  workspaces,
  workspaceMembers,
  propertyDefs,
} from "@synap/database/schema";
import { verifyCpJwt } from "../utils/jwks-client.js";
import { invalidateSyncPeerCache } from "../utils/sync-realtime-hook.js";
import {
  recordPeerGeneration,
  getSyncGenerationState,
  getSyncGenerationRow,
  promoteToPrimary,
} from "../utils/split-brain-service.js";
import { upsertSyncPeer } from "./sync-management.js";
import { flowValidationErrorMessage } from "../services/automations/validate-flow.js";
import { safeTokenEqual } from "@synap/auth";

const logger = createLogger({ module: "sync-receive" });

// ============================================================================
// Auth helpers
// ============================================================================

/**
 * Authenticate a peer that is pushing events TO us.
 * Matches peers with direction "pull" or "bidirectional" (from their perspective
 * they push, from ours we receive / pull).
 */
async function authenticateReceivePeer(
  authHeader: string | null
): Promise<{ peerId: string; workspaceIds: string[] | null } | null> {
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();

  // A peer that pushes to us is registered locally with direction "pull" or
  // "bidirectional" — OR "inbound" (an auth-only peer that never runs outbound
  // workers, used by an UNREACHABLE peer like the user's local pod behind NAT:
  // the local pod drives both push+pull from its side, and this pod just needs
  // to authenticate its inbound calls without trying to reach 127.0.0.1).
  const peer = await db.query.syncPeers.findFirst({
    where: and(
      or(
        eq(syncPeers.direction, "pull"),
        eq(syncPeers.direction, "bidirectional"),
        eq(syncPeers.direction, "inbound")
      ),
      eq(syncPeers.enabled, true),
      eq(syncPeers.authToken, token)
    ),
    columns: { id: true, workspaceIds: true },
  });

  if (!peer) return null;
  return { peerId: peer.id, workspaceIds: peer.workspaceIds };
}

/**
 * Authenticate a peer that is pulling events FROM us.
 * Matches peers with direction "push" or "bidirectional" (from their perspective
 * they pull, from ours we push / serve).
 */
async function authenticatePullPeer(
  authHeader: string | null
): Promise<{ peerId: string; workspaceIds: string[] | null } | null> {
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();

  // A peer that pulls from us is registered locally with direction "push" or
  // "bidirectional" — OR "inbound" (auth-only; see authenticateReceivePeer). An
  // inbound peer (the user's NAT'd local pod) pulls our events from its side; we
  // only authenticate the request and never try to reach it.
  const peer = await db.query.syncPeers.findFirst({
    where: and(
      or(
        eq(syncPeers.direction, "push"),
        eq(syncPeers.direction, "bidirectional"),
        eq(syncPeers.direction, "inbound")
      ),
      eq(syncPeers.enabled, true),
      eq(syncPeers.authToken, token)
    ),
    columns: { id: true, workspaceIds: true },
  });

  if (!peer) return null;
  return { peerId: peer.id, workspaceIds: peer.workspaceIds };
}

// ============================================================================
// Hono app
// ============================================================================

const app = new Hono();

// ── Global body size limit (20 MB) ─────────────────────────────────────────
// Prevents DoS via oversized payloads on all sync endpoints.
const MAX_BODY_SIZE = 20 * 1024 * 1024;
app.use("*", async (c, next): Promise<void | Response> => {
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return c.json({ error: "Payload too large" }, 413);
  }
  await next();
});

// ── Max batch sizes ─────────────────────────────────────────────────────────
const MAX_EVENT_BATCH = 1000;
const MAX_SUPPLEMENTARY_BATCH = 500;

/**
 * POST /receive — Accept a batch of events from a push peer
 */
app.post("/receive", async (c) => {
  // 1. Authenticate
  const authHeader = c.req.header("authorization") ?? null;
  const sourcePodId = c.req.header("x-source-pod-id") ?? null;

  const auth = await authenticateReceivePeer(authHeader);
  if (!auth) {
    return c.json(
      { error: "Unauthorized — invalid or missing sync token" },
      401
    );
  }

  // 2. Parse & validate body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = syncReceiveInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid input",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  const { events: incomingEvents, cursor } = parsed.data;

  if (incomingEvents.length === 0) {
    return c.json({ received: true, processed: 0 });
  }

  if (incomingEvents.length > MAX_EVENT_BATCH) {
    return c.json({ error: `Batch too large (max ${MAX_EVENT_BATCH})` }, 413);
  }

  logger.info(
    {
      peerId: auth.peerId,
      eventCount: incomingEvents.length,
      cursor,
      sourcePodId,
    },
    "Received sync batch"
  );

  // 3. Materialize events with conflict resolution
  const result = await materializeBatch(incomingEvents, {
    syncPeerId: auth.peerId,
    checkConflicts: true,
  });

  logger.info(
    {
      peerId: auth.peerId,
      received: incomingEvents.length,
      materialized: result.materialized,
      conflicts: result.conflicts,
      storedInEvents: result.stored,
    },
    "Sync batch processed"
  );

  // 4. Split-brain detection: check peer generation headers
  const peerGen = parseInt(c.req.header("x-sync-generation") ?? "0", 10);
  const peerRole = c.req.header("x-sync-role") ?? "unknown";

  let splitBrainResult = { splitBrain: false };
  if (peerGen > 0) {
    splitBrainResult = await recordPeerGeneration(peerGen, peerRole);
  }

  // Return our own generation so the peer can detect split-brain too
  const localState = await getSyncGenerationState();

  return c.json({
    received: true,
    processed: incomingEvents.length,
    generation: localState.generation,
    role: localState.role,
    splitBrain: splitBrainResult.splitBrain || localState.splitBrainDetected,
  });
});

/**
 * GET /pull — Serve local events to a pulling peer
 *
 * Query params:
 *   since — ISO timestamp cursor (events after this timestamp)
 *   limit — max events to return (default 500, max 1000)
 *
 * Returns: { events: [...], cursor: string | null, hasMore: boolean }
 */
app.get("/pull", async (c) => {
  // 1. Authenticate
  const authHeader = c.req.header("authorization") ?? null;

  const auth = await authenticatePullPeer(authHeader);
  if (!auth) {
    return c.json(
      { error: "Unauthorized — invalid or missing sync token" },
      401
    );
  }

  // 2. Parse query params
  const sinceParam = c.req.query("since");
  const limitParam = c.req.query("limit");

  const since = sinceParam ? new Date(sinceParam) : new Date(0);
  if (isNaN(since.getTime())) {
    return c.json(
      { error: "Invalid 'since' parameter — must be ISO timestamp" },
      400
    );
  }

  const limitSchema = z.coerce.number().int().min(1).max(1000).default(500);
  const limitResult = limitSchema.safeParse(limitParam ?? 500);
  const limit = limitResult.success ? limitResult.data : 500;

  // 3. Query local completed events after cursor (with workspace filtering)
  const conditions = [
    drizzleSql`${events.timestamp} > ${since}`,
    drizzleSql`${events.type} LIKE '%.completed'`,
  ];

  // Apply workspace filtering if the peer has workspaceIds configured.
  // Use parameterized inArray/isNull — no raw SQL interpolation.
  if (auth.workspaceIds && auth.workspaceIds.length > 0) {
    const workspaceIdExpr = drizzleSql<string>`(${events.data}->>'workspaceId')`;
    conditions.push(
      or(inArray(workspaceIdExpr, auth.workspaceIds), isNull(workspaceIdExpr))!
    );
  }

  const batch = await db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(events.timestamp)
    .limit(limit + 1); // Fetch one extra to detect hasMore

  const hasMore = batch.length > limit;
  const resultBatch = hasMore ? batch.slice(0, limit) : batch;

  const lastEvent = resultBatch[resultBatch.length - 1];
  const cursor = lastEvent
    ? lastEvent.timestamp instanceof Date
      ? lastEvent.timestamp.toISOString()
      : String(lastEvent.timestamp)
    : null;

  logger.debug(
    {
      peerId: auth.peerId,
      since: since.toISOString(),
      returned: resultBatch.length,
      hasMore,
    },
    "Serving pull batch"
  );

  // Check for peer generation in pull request headers
  const peerGen = parseInt(c.req.header("x-sync-generation") ?? "0", 10);
  const peerRole = c.req.header("x-sync-role") ?? "unknown";

  if (peerGen > 0) {
    await recordPeerGeneration(peerGen, peerRole);
  }

  // Include our generation info in the pull response
  const localState = await getSyncGenerationState();

  return c.json({
    events: resultBatch.map((evt) => ({
      id: evt.id,
      type: evt.type,
      subjectType: evt.subjectType,
      subjectId: evt.subjectId,
      data: evt.data,
      metadata: evt.metadata,
      source: evt.source,
      userId: evt.userId,
      timestamp:
        evt.timestamp instanceof Date
          ? evt.timestamp.toISOString()
          : String(evt.timestamp),
      correlationId: evt.correlationId ?? undefined,
    })),
    cursor,
    hasMore,
    generation: localState.generation,
    role: localState.role,
    splitBrain: localState.splitBrainDetected,
  });
});

// ============================================================================
// POST /receive-supplementary — Accept supplementary table rows from a push peer
// ============================================================================

const supplementaryInputSchema = z.object({
  table: z.string(),
  rows: z.array(z.record(z.string(), z.unknown())),
  cursor: z.string(), // ISO datetime of last row in batch
});

/** Supported supplementary tables and their upsert logic */
const SUPPLEMENTARY_TABLES: Record<
  string,
  (rows: Record<string, unknown>[]) => Promise<number>
> = {
  /**
   * workspaces — no FK dependencies on other synced tables.
   * Must arrive before workspace_members, channels, property_defs, widget_definitions.
   *
   * Excluded: stripeCustomerId (billing credential), subscriptionStatus/Tier
   * (billing state — intentionally kept per-pod).
   */
  workspaces: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        const values: typeof workspaces.$inferInsert = {
          id: row.id as string,
          ownerId: row.ownerId as string,
          name: (row.name as string) ?? "Synced Workspace",
          description: (row.description as string) ?? null,
          settings:
            (row.settings as typeof workspaces.$inferInsert.settings) ?? {},
          systemSlug: (row.systemSlug as string) ?? null,
          packageSlug: (row.packageSlug as string) ?? null,
          provisioningProposalId:
            (row.provisioningProposalId as string) ?? null,
          provisioningStatus: (row.provisioningStatus as string) ?? null,
          workspaceType: (row.workspaceType as string) ?? "personal",
          // Billing columns are intentionally NOT synced (per-pod state):
          subscriptionTier: null,
          subscriptionStatus: null,
          stripeCustomerId: null,
          createdAt: row.createdAt
            ? new Date(row.createdAt as string)
            : new Date(),
          updatedAt: row.updatedAt
            ? new Date(row.updatedAt as string)
            : new Date(),
          archivedAt: row.archivedAt
            ? new Date(row.archivedAt as string)
            : null,
        };
        const updateSet: Partial<typeof workspaces.$inferInsert> = {
          name: values.name,
          description: values.description,
          settings: values.settings,
          systemSlug: values.systemSlug,
          packageSlug: values.packageSlug,
          provisioningProposalId: values.provisioningProposalId,
          provisioningStatus: values.provisioningStatus,
          workspaceType: values.workspaceType,
          archivedAt: values.archivedAt,
          updatedAt: values.updatedAt,
        };
        await db.insert(workspaces).values(values).onConflictDoUpdate({
          target: workspaces.id,
          set: updateSet,
        });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "workspaces", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },

  /**
   * workspace_members — FK → workspaces.id (ON DELETE CASCADE).
   * Must arrive after workspaces. Silently skips if workspace not present yet.
   *
   * No secret/credential columns.
   */
  workspace_members: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        const values: typeof workspaceMembers.$inferInsert = {
          id: row.id as string,
          workspaceId: row.workspaceId as string,
          userId: row.userId as string,
          role: (row.role as string) ?? "viewer",
          joinedAt: row.joinedAt
            ? new Date(row.joinedAt as string)
            : new Date(),
          invitedBy: (row.invitedBy as string) ?? null,
        };
        const updateSet: Partial<typeof workspaceMembers.$inferInsert> = {
          role: values.role,
        };
        await db.insert(workspaceMembers).values(values).onConflictDoUpdate({
          target: workspaceMembers.id,
          set: updateSet,
        });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "workspace_members", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },

  /**
   * channels — FK → workspaces.id (nullable, no cascade constraint in Drizzle schema).
   * Must arrive after workspaces. assignedAgentId / senderAgentId FKs → agents.id
   * (ON DELETE SET NULL) — missing agent produces null, which is safe.
   *
   * No secret/credential columns.
   */
  channels: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        const values: typeof channels.$inferInsert = {
          id: row.id as string,
          userId: row.userId as string,
          workspaceId: (row.workspaceId as string) ?? null,
          title: (row.title as string) ?? null,
          channelType:
            (row.channelType as typeof channels.$inferInsert.channelType) ??
            "thread",
          scope:
            (row.scope as typeof channels.$inferInsert.scope) ?? "workspace",
          feedScope:
            (row.feedScope as typeof channels.$inferInsert.feedScope) ?? null,
          contextObjectType: (row.contextObjectType as string) ?? null,
          contextObjectId: (row.contextObjectId as string) ?? null,
          parentChannelId: (row.parentChannelId as string) ?? null,
          branchedFromMessageId: (row.branchedFromMessageId as string) ?? null,
          branchPurpose: (row.branchPurpose as string) ?? null,
          status:
            (row.status as typeof channels.$inferInsert.status) ?? "active",
          aiReactionMode:
            (row.aiReactionMode as typeof channels.$inferInsert.aiReactionMode) ??
            "when_confident",
          agentConfig: (row.agentConfig as Record<string, unknown>) ?? null,
          mcpServerIds: (row.mcpServerIds as string[]) ?? null,
          assignedAgentId: (row.assignedAgentId as string) ?? null,
          senderAgentId: (row.senderAgentId as string) ?? null,
          contextSummary: (row.contextSummary as string) ?? null,
          resultSummary: (row.resultSummary as string) ?? null,
          mergedIntoStateId: (row.mergedIntoStateId as string) ?? null,
          externalSource: (row.externalSource as string) ?? null,
          externalChannelId: (row.externalChannelId as string) ?? null,
          externalId: (row.externalId as string) ?? null,
          metadata: (row.metadata as Record<string, unknown>) ?? null,
          createdAt: row.createdAt
            ? new Date(row.createdAt as string)
            : new Date(),
          updatedAt: row.updatedAt
            ? new Date(row.updatedAt as string)
            : new Date(),
          mergedAt: row.mergedAt ? new Date(row.mergedAt as string) : null,
        };
        const updateSet: Partial<typeof channels.$inferInsert> = {
          title: values.title,
          status: values.status,
          aiReactionMode: values.aiReactionMode,
          agentConfig: values.agentConfig,
          contextSummary: values.contextSummary,
          resultSummary: values.resultSummary,
          mergedIntoStateId: values.mergedIntoStateId,
          metadata: values.metadata,
          mergedAt: values.mergedAt,
          updatedAt: values.updatedAt,
        };
        await db.insert(channels).values(values).onConflictDoUpdate({
          target: channels.id,
          set: updateSet,
        });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "channels", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },

  messages: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        const values: typeof messages.$inferInsert = {
          id: row.id as string,
          channelId: row.channelId as string,
          parentId: (row.parentId as string) ?? null,
          role: (row.role as typeof messages.$inferInsert.role) ?? "user",
          authorType:
            (row.authorType as typeof messages.$inferInsert.authorType) ??
            "human",
          messageCategory:
            (row.messageCategory as typeof messages.$inferInsert.messageCategory) ??
            "chat",
          externalSource: (row.externalSource as string) ?? null,
          inboxItemId: (row.inboxItemId as string) ?? null,
          content: (row.content as string) ?? "",
          metadata:
            (row.metadata as typeof messages.$inferInsert.metadata) ?? null,
          userId: (row.userId as string) ?? "sync",
          timestamp: row.timestamp
            ? new Date(row.timestamp as string)
            : new Date(),
          previousHash: (row.previousHash as string) ?? null,
          hash: (row.hash as string) ?? "",
          sessionId: (row.sessionId as string) ?? null,
          deletedAt: row.deletedAt ? new Date(row.deletedAt as string) : null,
        };
        const updateSet: Partial<typeof messages.$inferInsert> = {
          content: values.content,
          metadata: values.metadata,
          deletedAt: values.deletedAt,
        };
        await db.insert(messages).values(values).onConflictDoUpdate({
          target: messages.id,
          set: updateSet,
        });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "messages", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },

  automations: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        const values: typeof automations.$inferInsert = {
          id: row.id as string,
          workspaceId: row.workspaceId as string,
          createdBy: (row.createdBy as string) ?? "sync",
          name: (row.name as string) ?? "Synced Automation",
          description: (row.description as string) ?? null,
          triggerType:
            (row.triggerType as typeof automations.$inferInsert.triggerType) ??
            "manual",
          triggerConfig:
            (row.triggerConfig as typeof automations.$inferInsert.triggerConfig) ??
            {},
          flowDefinition:
            (row.flowDefinition as typeof automations.$inferInsert.flowDefinition) ?? {
              nodes: [],
              edges: [],
            },
          status:
            (row.status as typeof automations.$inferInsert.status) ?? "draft",
          errorMessage: (row.errorMessage as string) ?? null,
          lastRunAt: row.lastRunAt ? new Date(row.lastRunAt as string) : null,
          nextRunAt: row.nextRunAt ? new Date(row.nextRunAt as string) : null,
          runCount: (row.runCount as number) ?? 0,
          successCount: (row.successCount as number) ?? 0,
          failureCount: (row.failureCount as number) ?? 0,
          metadata:
            (row.metadata as typeof automations.$inferInsert.metadata) ?? {},
          createdAt: row.createdAt
            ? new Date(row.createdAt as string)
            : new Date(),
          updatedAt: row.updatedAt
            ? new Date(row.updatedAt as string)
            : new Date(),
        };
        const updateSet: Partial<typeof automations.$inferInsert> = {
          name: values.name,
          description: values.description,
          triggerConfig: values.triggerConfig,
          flowDefinition: values.flowDefinition,
          status: values.status,
          errorMessage: values.errorMessage,
          runCount: values.runCount,
          successCount: values.successCount,
          failureCount: values.failureCount,
          metadata: values.metadata,
          updatedAt: values.updatedAt,
        };
        // Replicated rows never pass through the automations create/update door,
        // so run the SAME validator here. LOG, don't reject: this pod is a
        // REPLICA, not the author — the peer already holds this row, so dropping
        // it would leave the two pods permanently divergent with only a log line
        // to show for it, whereas a structurally broken flow fails loudly at
        // execution time exactly as it does on the peer.
        const syncFlowError = flowValidationErrorMessage(values.flowDefinition);
        if (syncFlowError) {
          logger.warn(
            { table: "automations", rowId: row.id, flowError: syncFlowError },
            "Replicated automation has an invalid flowDefinition — storing it anyway (replica fidelity)"
          );
        }
        await db.insert(automations).values(values).onConflictDoUpdate({
          target: automations.id,
          set: updateSet,
        });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "automations", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },

  automation_runs: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        const values: typeof automationRuns.$inferInsert = {
          id: row.id as string,
          automationId: row.automationId as string,
          workspaceId: row.workspaceId as string,
          triggeredBy: (row.triggeredBy as string) ?? null,
          triggerPayload:
            (row.triggerPayload as typeof automationRuns.$inferInsert.triggerPayload) ??
            {},
          status:
            (row.status as typeof automationRuns.$inferInsert.status) ??
            "running",
          errorMessage: (row.errorMessage as string) ?? null,
          stepsCompleted: (row.stepsCompleted as number) ?? 0,
          stepsFailed: (row.stepsFailed as number) ?? 0,
          outputSummary: (row.outputSummary as Record<string, unknown>) ?? null,
          startedAt: row.startedAt
            ? new Date(row.startedAt as string)
            : new Date(),
          completedAt: row.completedAt
            ? new Date(row.completedAt as string)
            : null,
        };
        const updateSet: Partial<typeof automationRuns.$inferInsert> = {
          status: values.status,
          errorMessage: values.errorMessage,
          stepsCompleted: values.stepsCompleted,
          stepsFailed: values.stepsFailed,
          outputSummary: values.outputSummary,
          completedAt: values.completedAt,
        };
        await db.insert(automationRuns).values(values).onConflictDoUpdate({
          target: automationRuns.id,
          set: updateSet,
        });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "automation_runs", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },

  /**
   * Intelligence service metadata sync (NOT credentials).
   * API keys are excluded — each pod gets its own credentials from the CP.
   * This ensures both pods know about the same IS registrations (capabilities,
   * health status, endpoints) so failover routing works correctly.
   */
  intelligence_services: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        const values: typeof intelligenceServices.$inferInsert = {
          id: row.id as string,
          serviceId: row.serviceId as string,
          name: (row.name as string) ?? "Synced Service",
          description: (row.description as string) ?? null,
          version: (row.version as string) ?? null,
          webhookUrl: (row.webhookUrl as string) ?? "",
          mcpEndpoint: (row.mcpEndpoint as string) ?? null,
          // apiKey is NOT synced — each pod gets its own from the CP
          apiKey: "SYNC_PLACEHOLDER",
          capabilities:
            (row.capabilities as typeof intelligenceServices.$inferInsert.capabilities) ??
            [],
          pricing: (row.pricing as string) ?? "free",
          status: (row.status as string) ?? "active",
          enabled: (row.enabled as boolean) ?? true,
          mcpApproved: (row.mcpApproved as boolean) ?? false,
          metadata:
            (row.metadata as typeof intelligenceServices.$inferInsert.metadata) ??
            {},
          createdAt: row.createdAt
            ? new Date(row.createdAt as string)
            : new Date(),
          updatedAt: row.updatedAt
            ? new Date(row.updatedAt as string)
            : new Date(),
          lastHealthCheck: row.lastHealthCheck
            ? new Date(row.lastHealthCheck as string)
            : null,
          lastHealthStatus: (row.lastHealthStatus as string) ?? null,
        };
        // Only update non-credential fields on conflict — never overwrite apiKey
        const updateSet: Partial<typeof intelligenceServices.$inferInsert> = {
          name: values.name,
          description: values.description,
          version: values.version,
          webhookUrl: values.webhookUrl,
          mcpEndpoint: values.mcpEndpoint,
          capabilities: values.capabilities,
          pricing: values.pricing,
          status: values.status,
          enabled: values.enabled,
          mcpApproved: values.mcpApproved,
          metadata: values.metadata,
          updatedAt: values.updatedAt,
          lastHealthCheck: values.lastHealthCheck,
          lastHealthStatus: values.lastHealthStatus,
        };
        await db
          .insert(intelligenceServices)
          .values(values)
          .onConflictDoUpdate({
            target: intelligenceServices.id,
            set: updateSet,
          });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "intelligence_services", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },

  intelligence_commands: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        const values: typeof intelligenceCommands.$inferInsert = {
          id: row.id as string,
          workspaceId: row.workspaceId as string,
          createdBy: (row.createdBy as string) ?? "sync",
          title: (row.title as string) ?? "Synced Command",
          promptTemplate: (row.promptTemplate as string) ?? "",
          compiledTemplateAst:
            (row.compiledTemplateAst as typeof intelligenceCommands.$inferInsert.compiledTemplateAst) ??
            null,
          derivedInputs:
            (row.derivedInputs as typeof intelligenceCommands.$inferInsert.derivedInputs) ??
            null,
          inputOverrides:
            (row.inputOverrides as typeof intelligenceCommands.$inferInsert.inputOverrides) ??
            null,
          allowedTools: (row.allowedTools as string[]) ?? null,
          allowedEntityTypes: (row.allowedEntityTypes as string[]) ?? null,
          maxEntitiesCreatedPerRun:
            (row.maxEntitiesCreatedPerRun as number) ?? null,
          canCreateViews: (row.canCreateViews as boolean) ?? false,
          outputMode:
            (row.outputMode as typeof intelligenceCommands.$inferInsert.outputMode) ??
            "text",
          permissionsProfile:
            (row.permissionsProfile as typeof intelligenceCommands.$inferInsert.permissionsProfile) ??
            "propose_writes",
          sharedScope:
            (row.sharedScope as typeof intelligenceCommands.$inferInsert.sharedScope) ??
            "workspace",
          createdAt: row.createdAt
            ? new Date(row.createdAt as string)
            : new Date(),
          updatedAt: row.updatedAt
            ? new Date(row.updatedAt as string)
            : new Date(),
        };
        const updateSet: Partial<typeof intelligenceCommands.$inferInsert> = {
          title: values.title,
          promptTemplate: values.promptTemplate,
          compiledTemplateAst: values.compiledTemplateAst,
          derivedInputs: values.derivedInputs,
          inputOverrides: values.inputOverrides,
          allowedTools: values.allowedTools,
          allowedEntityTypes: values.allowedEntityTypes,
          maxEntitiesCreatedPerRun: values.maxEntitiesCreatedPerRun,
          canCreateViews: values.canCreateViews,
          outputMode: values.outputMode,
          permissionsProfile: values.permissionsProfile,
          sharedScope: values.sharedScope,
          updatedAt: values.updatedAt,
        };
        await db
          .insert(intelligenceCommands)
          .values(values)
          .onConflictDoUpdate({
            target: intelligenceCommands.id,
            set: updateSet,
          });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "intelligence_commands", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },

  /**
   * Proposals sync.
   *
   * Pod-portability audit:
   * - `workspaceId` (text, nullable) — pod-scoped; UUIDs are stable across pods.
   * - `threadId` FK → channels.id  — channels are replicated via event log
   *   (channel.created.completed events). The FK is ON DELETE SET NULL, so a
   *   missing channel does not prevent the upsert; it leaves threadId null.
   * - `commandRunId` FK → command_runs.id — NOT replicated; set to null on sync
   *   (ON DELETE SET NULL semantics preserved).
   * - `sourceMessageId` FK → messages.id — messages ARE replicated (supplementary).
   *   Order dependency: sync messages before proposals. Null-safe on missing row.
   * - `agentUserId` FK → users.id — user records are replicated via event log
   *   (user.created.completed). ON DELETE SET NULL if user not present yet.
   * - `data` (jsonb) — payload; references entity UUIDs but no DB FK enforced.
   *
   * Conclusion: proposals ARE pod-portable. FK columns are all nullable with
   * ON DELETE SET NULL, so missing referenced rows produce null fields rather
   * than constraint failures. Upsert is safe.
   */
  proposals: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        const values: typeof proposals.$inferInsert = {
          id: row.id as string,
          workspaceId: (row.workspaceId as string) ?? null,
          targetType: (row.targetType as string) ?? "unknown",
          targetId: (row.targetId as string) ?? "",
          proposalType: (row.proposalType as string) ?? "edit",
          data: (row.data as Record<string, unknown>) ?? {},
          status:
            (row.status as typeof proposals.$inferInsert.status) ?? "pending",
          createdBy: (row.createdBy as string) ?? null,
          // FK columns: carry the value but accept null if referenced row absent
          threadId: (row.threadId as string) ?? null,
          commandRunId: (row.commandRunId as string) ?? null,
          sourceMessageId: (row.sourceMessageId as string) ?? null,
          agentUserId: (row.agentUserId as string) ?? null,
          correlationId: (row.correlationId as string) ?? null,
          requestedEventId: (row.requestedEventId as string) ?? null,
          sessionId: (row.sessionId as string) ?? null,
          expiresAt: row.expiresAt ? new Date(row.expiresAt as string) : null,
          reviewedBy: (row.reviewedBy as string) ?? null,
          reviewedAt: row.reviewedAt
            ? new Date(row.reviewedAt as string)
            : null,
          rejectionReason: (row.rejectionReason as string) ?? null,
          comments: (row.comments as unknown[]) ?? [],
          createdAt: row.createdAt
            ? new Date(row.createdAt as string)
            : new Date(),
          updatedAt: row.updatedAt
            ? new Date(row.updatedAt as string)
            : new Date(),
        };
        const updateSet: Partial<typeof proposals.$inferInsert> = {
          status: values.status,
          data: values.data,
          reviewedBy: values.reviewedBy,
          reviewedAt: values.reviewedAt,
          rejectionReason: values.rejectionReason,
          comments: values.comments,
          expiresAt: values.expiresAt,
          updatedAt: values.updatedAt,
        };
        await db.insert(proposals).values(values).onConflictDoUpdate({
          target: proposals.id,
          set: updateSet,
        });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "proposals", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },

  /**
   * Focus sessions sync.
   *
   * Pod-portability audit:
   * - `workspaceId` (text, not null) — pod-scoped; stable UUID.
   * - `userId` (text, not null) — user records replicated via event log; stable.
   * - `channelId` (uuid, nullable) FK → channels.id — no ON DELETE constraint
   *   in schema (nullable uuid). Safe to carry; a missing channel leaves a
   *   dangling FK until the channel event is replicated. Acceptable for sync
   *   purposes (session is still queryable by id/workspaceId/userId).
   * - `correlationId` (text, nullable, unique) — IS correlation token, not a DB FK.
   *   UNIQUE constraint: if the same correlationId already exists from a prior sync
   *   the row is deduplicated by the ON CONFLICT on `id`; no duplicate issue.
   *
   * Conclusion: focus_sessions ARE pod-portable.
   */
  focus_sessions: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        const values: typeof focusSessions.$inferInsert = {
          id: row.id as string,
          workspaceId: row.workspaceId as string,
          userId: row.userId as string,
          correlationId: (row.correlationId as string) ?? null,
          goal: (row.goal as string) ?? "",
          status:
            (row.status as typeof focusSessions.$inferInsert.status) ??
            "active",
          templateId: (row.templateId as string) ?? null,
          expectedOutputs:
            (row.expectedOutputs as typeof focusSessions.$inferInsert.expectedOutputs) ??
            [],
          channelId: (row.channelId as string) ?? null,
          progress: (row.progress as number) ?? null,
          agentIds: (row.agentIds as string[]) ?? [],
          closedAt: row.closedAt ? new Date(row.closedAt as string) : null,
          verificationReport:
            (row.verificationReport as Record<string, unknown>) ?? null,
          startedAt: row.startedAt
            ? new Date(row.startedAt as string)
            : new Date(),
          createdAt: row.createdAt
            ? new Date(row.createdAt as string)
            : new Date(),
          updatedAt: row.updatedAt
            ? new Date(row.updatedAt as string)
            : new Date(),
        };
        const updateSet: Partial<typeof focusSessions.$inferInsert> = {
          status: values.status,
          progress: values.progress,
          agentIds: values.agentIds,
          closedAt: values.closedAt,
          verificationReport: values.verificationReport,
          updatedAt: values.updatedAt,
        };
        await db.insert(focusSessions).values(values).onConflictDoUpdate({
          target: focusSessions.id,
          set: updateSet,
        });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "focus_sessions", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },

  /**
   * Widget definitions sync.
   *
   * Pod-portability audit:
   * - `workspaceId` (uuid, nullable) FK → workspaces.id ON DELETE CASCADE.
   *   If the workspace does not exist on the receiving pod, the insert will
   *   fail with an FK violation. Strategy: skip silently (logged as warn) —
   *   workspace-scoped widgets are only useful once their workspace is present.
   *   System-wide widgets (workspaceId = null) have no FK and are always safe.
   * - No user or credential FK columns.
   * - `bundleSource` / `rendererSource` (text, nullable) — compiled bundles;
   *   large but contain no secrets.
   * - `configSchema` / `defaultConfig` (jsonb) — no secrets.
   *
   * Conclusion: widget_definitions ARE pod-portable with the FK caveat above.
   * System-wide (workspaceId = null) widgets replicate unconditionally.
   * Workspace-scoped widgets may silently skip if workspace is not present yet;
   * a subsequent sync cycle after workspace replication will succeed.
   */
  widget_definitions: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        const values: typeof widgetDefinitions.$inferInsert = {
          id: row.id as string,
          typeKey: (row.typeKey as string) ?? "synced-widget",
          workspaceId: (row.workspaceId as string) ?? null,
          name: (row.name as string) ?? "Synced Widget",
          description: (row.description as string) ?? null,
          icon: (row.icon as string) ?? null,
          category: (row.category as string) ?? null,
          rendererType:
            (row.rendererType as typeof widgetDefinitions.$inferInsert.rendererType) ??
            "builtin",
          rendererSource: (row.rendererSource as string) ?? null,
          source: (row.source as string) ?? null,
          bundleSource: (row.bundleSource as string) ?? null,
          configSchema: (row.configSchema as Record<string, unknown>) ?? {},
          defaultConfig: (row.defaultConfig as Record<string, unknown>) ?? {},
          defaultSize: (row.defaultSize as { w: number; h: number }) ?? {
            w: 6,
            h: 4,
          },
          minSize: (row.minSize as { w: number; h: number }) ?? null,
          deps: (row.deps as Record<string, string>) ?? {},
          isActive: (row.isActive as boolean) !== false,
          version: (row.version as string) ?? "1.0.0",
          trustLevel:
            (row.trustLevel as typeof widgetDefinitions.$inferInsert.trustLevel) ??
            "generated",
          role:
            (row.role as typeof widgetDefinitions.$inferInsert.role) ??
            "widget",
          contentKind:
            (row.contentKind as typeof widgetDefinitions.$inferInsert.contentKind) ??
            "widget",
          createdAt: row.createdAt
            ? new Date(row.createdAt as string)
            : new Date(),
          updatedAt: row.updatedAt
            ? new Date(row.updatedAt as string)
            : new Date(),
        };
        const updateSet: Partial<typeof widgetDefinitions.$inferInsert> = {
          name: values.name,
          description: values.description,
          icon: values.icon,
          category: values.category,
          rendererType: values.rendererType,
          rendererSource: values.rendererSource,
          source: values.source,
          bundleSource: values.bundleSource,
          configSchema: values.configSchema,
          defaultConfig: values.defaultConfig,
          defaultSize: values.defaultSize,
          minSize: values.minSize,
          deps: values.deps,
          isActive: values.isActive,
          version: values.version,
          trustLevel: values.trustLevel,
          role: values.role,
          contentKind: values.contentKind,
          updatedAt: values.updatedAt,
        };
        await db.insert(widgetDefinitions).values(values).onConflictDoUpdate({
          target: widgetDefinitions.id,
          set: updateSet,
        });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "widget_definitions", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },

  /**
   * property_defs — FK → profiles.id (ON DELETE CASCADE, nullable) and
   * workspaces.id (ON DELETE CASCADE, nullable). Both FKs are nullable so
   * a missing profile/workspace produces null rather than a constraint error.
   * relationDefId FK → relation_defs.id (ON DELETE SET NULL) — safe.
   * targetProfileId FK → profiles.id (ON DELETE SET NULL) — safe.
   *
   * Excluded: valueType=SECRET properties carry no raw secret value in this
   * table (secrets live in secrets_vault), so the row itself is safe to sync.
   * However we exclude SECRET-typed rows as a defence-in-depth measure since
   * the field name alone may be sensitive.
   */
  property_defs: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        // Defence-in-depth: never replicate secret-typed property definitions
        if (
          typeof row.valueType === "string" &&
          row.valueType.toLowerCase() === "secret"
        ) {
          continue;
        }
        const values: typeof propertyDefs.$inferInsert = {
          id: row.id as string,
          slug: row.slug as string,
          profileId: (row.profileId as string) ?? null,
          workspaceId: (row.workspaceId as string) ?? null,
          valueType:
            (row.valueType as typeof propertyDefs.$inferInsert.valueType) ??
            "string",
          constraints:
            (row.constraints as typeof propertyDefs.$inferInsert.constraints) ??
            {},
          uiHints:
            (row.uiHints as typeof propertyDefs.$inferInsert.uiHints) ?? {},
          relationDefId: (row.relationDefId as string) ?? null,
          targetProfileId: (row.targetProfileId as string) ?? null,
          createdAt: row.createdAt
            ? new Date(row.createdAt as string)
            : new Date(),
          updatedAt: row.updatedAt
            ? new Date(row.updatedAt as string)
            : new Date(),
        };
        const updateSet: Partial<typeof propertyDefs.$inferInsert> = {
          constraints: values.constraints,
          uiHints: values.uiHints,
          relationDefId: values.relationDefId,
          targetProfileId: values.targetProfileId,
          updatedAt: values.updatedAt,
        };
        await db.insert(propertyDefs).values(values).onConflictDoUpdate({
          target: propertyDefs.id,
          set: updateSet,
        });
        processed++;
      } catch (err) {
        logger.warn(
          { table: "property_defs", rowId: row.id, err },
          "Failed to upsert supplementary row"
        );
      }
    }
    return processed;
  },
};

app.post("/receive-supplementary", async (c) => {
  // 1. Authenticate (same as /receive)
  const authHeader = c.req.header("authorization") ?? null;
  const sourcePodId = c.req.header("x-source-pod-id") ?? null;

  const auth = await authenticateReceivePeer(authHeader);
  if (!auth) {
    return c.json(
      { error: "Unauthorized — invalid or missing sync token" },
      401
    );
  }

  // 2. Parse & validate body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = supplementaryInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid input",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  const { table, rows, cursor } = parsed.data;

  if (rows.length === 0) {
    return c.json({ received: true, processed: 0 });
  }

  if (rows.length > MAX_SUPPLEMENTARY_BATCH) {
    return c.json(
      { error: `Batch too large (max ${MAX_SUPPLEMENTARY_BATCH})` },
      413
    );
  }

  // 3. Look up the upsert handler for this table
  const handler = SUPPLEMENTARY_TABLES[table];
  if (!handler) {
    return c.json({ error: `Unsupported supplementary table: ${table}` }, 400);
  }

  logger.info(
    {
      peerId: auth.peerId,
      table,
      rowCount: rows.length,
      cursor,
      sourcePodId,
    },
    "Received supplementary sync batch"
  );

  // 4. Upsert rows
  const processed = await handler(rows);

  logger.info(
    {
      peerId: auth.peerId,
      table,
      received: rows.length,
      processed,
    },
    "Supplementary sync batch processed"
  );

  return c.json({
    received: true,
    processed,
  });
});

// ─── File Sync Endpoints ───────────────────────────────────────────────────

const filePayloadSchema = z.object({
  documentId: z.string(),
  storageKey: z.string(),
  mimeType: z.string().default("application/octet-stream"),
  size: z.number().optional(),
  title: z.string().optional(),
  type: z.string().optional(),
  currentVersion: z.number().optional(),
  workspaceId: z.string().optional(),
  contentBase64: z.string(),
});

const fileVersionPayloadSchema = z.object({
  versionId: z.string(),
  documentId: z.string(),
  version: z.number().optional(),
  content: z.string().nullable().optional(),
  contentBase64: z.string().optional(),
  mimeType: z.string().nullable().optional(),
  size: z.number().nullable().optional(),
  checksum: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  authorId: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  createdAt: z.string().optional(),
});

/**
 * POST /receive-file — Receives base64 document content + metadata from a push peer.
 * Stores content in local S3/MinIO, upserts documents row.
 */
app.post("/receive-file", async (c) => {
  const authResult = await authenticateReceivePeer(
    c.req.header("authorization") ?? null
  );
  if (!authResult) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: z.infer<typeof filePayloadSchema>;
  try {
    body = filePayloadSchema.parse(await c.req.json());
  } catch (err) {
    logger.warn({ err }, "Invalid payload in /receive-file");
    return c.json({ error: "Invalid payload" }, 400);
  }

  // Validate storageKey before passing to storage layer
  if (
    !/^[a-zA-Z0-9_\-/.]+$/.test(body.storageKey) ||
    body.storageKey.includes("..")
  ) {
    return c.json({ error: "Invalid storageKey" }, 400);
  }

  try {
    // Store content in local S3/MinIO
    const buffer = Buffer.from(body.contentBase64, "base64");
    const { storage } = await import("@synap/storage");
    await storage.upload(body.storageKey, buffer, {
      contentType: body.mimeType,
    });

    // Upsert document row
    const docValues: typeof documents.$inferInsert = {
      id: body.documentId,
      userId: "sync",
      workspaceId: body.workspaceId ?? null,
      title: body.title ?? "Synced Document",
      type: body.type ?? "document",
      storageKey: body.storageKey,
      mimeType: body.mimeType,
      size: body.size ?? buffer.length,
      currentVersion: body.currentVersion ?? 1,
    };
    const docUpdateSet: Partial<typeof documents.$inferInsert> = {
      storageKey: docValues.storageKey,
      mimeType: docValues.mimeType,
      size: docValues.size,
      currentVersion: docValues.currentVersion,
      updatedAt: new Date(),
    };
    await db
      .insert(documents)
      .values(docValues)
      .onConflictDoUpdate({
        target: [documents.id],
        set: docUpdateSet,
      });

    logger.debug({ documentId: body.documentId }, "File received and stored");
    return c.json({ received: true, backpressure: false });
  } catch (err) {
    logger.error(
      { err, documentId: body.documentId },
      "Failed to store received file"
    );
    return c.json({ received: false, error: "Storage failed" }, 500);
  }
});

/**
 * POST /receive-file-version — Receives a document version snapshot.
 */
app.post("/receive-file-version", async (c) => {
  const authResult = await authenticateReceivePeer(
    c.req.header("authorization") ?? null
  );
  if (!authResult) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: z.infer<typeof fileVersionPayloadSchema>;
  try {
    body = fileVersionPayloadSchema.parse(await c.req.json());
  } catch (err) {
    logger.warn({ err }, "Invalid payload in /receive-file-version");
    return c.json({ error: "Invalid payload" }, 400);
  }

  try {
    const existingDoc = await db.query.documents.findFirst({
      where: eq(documents.id, body.documentId),
    });
    const contentBuffer = body.contentBase64
      ? Buffer.from(body.contentBase64, "base64")
      : Buffer.from(body.content ?? "", "utf-8");
    const snapshot = await uploadDocumentVersionSnapshot({
      userId: existingDoc?.userId ?? "sync",
      documentId: body.documentId,
      versionId: body.versionId,
      documentType: existingDoc?.type,
      mimeType:
        body.mimeType ?? existingDoc?.mimeType ?? "application/octet-stream",
      content: contentBuffer,
    });
    const versionValues: typeof documentVersions.$inferInsert = {
      id: body.versionId,
      documentId: body.documentId,
      version: body.version ?? 1,
      ...storedVersionValues(snapshot),
      author: body.author ?? "sync",
      authorId: body.authorId ?? "sync",
      message: body.message,
      createdAt: body.createdAt ? new Date(body.createdAt) : new Date(),
    };
    await db
      .insert(documentVersions)
      .values(versionValues)
      .onConflictDoNothing();

    logger.debug({ versionId: body.versionId }, "File version received");
    return c.json({ received: true, backpressure: false });
  } catch (err) {
    logger.error(
      { err, versionId: body.versionId },
      "Failed to store file version"
    );
    return c.json({ received: false, error: "Storage failed" }, 500);
  }
});

// ============================================================================
// CP-Authenticated Setup Endpoints — used by Control Plane to orchestrate
// pod linking for redundancy. Auth: CP-signed ES256 JWT.
// ============================================================================

const httpsUrl = z
  .string()
  .url()
  .refine(
    (u) => u.startsWith("https://") || process.env.NODE_ENV === "development",
    "Peer URL must use HTTPS"
  );

const setupPeerInputSchema = z.object({
  peerUrl: httpsUrl,
  direction: z.enum(["push", "pull", "bidirectional", "inbound"]),
  authToken: z.string().min(1),
  label: z.string().optional(),
});

const removePeerInputSchema = z.object({
  peerUrl: httpsUrl,
});

/**
 * Verify a CP-signed JWT from the Authorization header.
 * Returns the decoded payload or null if invalid.
 */
async function verifyCpAuth<T extends object>(
  authHeader: string | null
): Promise<T | null> {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  // Pass cpUrl as optional allowlist — if set, only tokens from that issuer
  // are accepted. If unset, verifyCpJwt reads the issuer from the token's iss claim.
  return verifyCpJwt<T>(token, config.server.controlPlaneUrl);
}

/**
 * POST /setup-peer — Create a sync peer entry (called by CP during pod linking)
 *
 * Auth: CP-signed JWT with type "sync-setup"
 */
app.post("/setup-peer", async (c) => {
  const payload = await verifyCpAuth<{
    type: string;
    podId: string;
    action: string;
  }>(c.req.header("authorization") ?? null);

  if (!payload || payload.type !== "sync-setup" || payload.action !== "add") {
    return c.json({ error: "Unauthorized — invalid or missing CP JWT" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = setupPeerInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { peerUrl, direction, authToken, label } = parsed.data;

  // Delegate to shared helper — same logic used by the operator tRPC path
  const peerId = await upsertSyncPeer({
    peerPodUrl: peerUrl,
    direction,
    authToken,
    label,
    enabled: true,
  });

  logger.info(
    { peerId, peerUrl, direction, cpPodId: payload.podId },
    "Sync peer upserted via CP setup"
  );

  return c.json({ peerId });
});

/**
 * DELETE /setup-peer — Remove a sync peer entry (called by CP during pod unlinking)
 *
 * Auth: CP-signed JWT with type "sync-setup"
 */
app.delete("/setup-peer", async (c) => {
  const payload = await verifyCpAuth<{
    type: string;
    podId: string;
    action: string;
  }>(c.req.header("authorization") ?? null);

  if (
    !payload ||
    payload.type !== "sync-setup" ||
    payload.action !== "remove"
  ) {
    return c.json({ error: "Unauthorized — invalid or missing CP JWT" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = removePeerInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { peerUrl } = parsed.data;

  // Find and remove all peers matching this URL
  const peers = await db
    .select({ id: syncPeers.id })
    .from(syncPeers)
    .where(eq(syncPeers.peerPodUrl, peerUrl));

  if (peers.length === 0) {
    logger.info({ peerUrl }, "No sync peers found for URL — nothing to remove");
    return c.json({ removed: true });
  }

  for (const peer of peers) {
    await db.delete(syncPeers).where(eq(syncPeers.id, peer.id));
  }

  logger.info(
    { peerUrl, removedCount: peers.length, cpPodId: payload.podId },
    "Sync peers removed via CP setup"
  );

  invalidateSyncPeerCache();
  return c.json({ removed: true });
});

/**
 * GET /health — Sync health check.
 *
 * Unauthenticated: returns only status + peer count (no URLs, no errors).
 * Authenticated (Bearer token matches any peer): returns full peer details.
 * This prevents topology leakage to unauthenticated callers.
 */
app.get("/health", async (c) => {
  const base = { status: "ok" as const, service: "sync" as const };

  try {
    const peers = await db.query.syncPeers.findMany({
      columns: {
        id: true,
        peerPodUrl: true,
        direction: true,
        enabled: true,
        authToken: true,
      },
    });

    if (peers.length === 0) {
      return c.json({ ...base, peerCount: 0 });
    }

    // Check if caller is authenticated (matches any peer token)
    const authHeader = c.req.header("authorization") ?? "";
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const callerToken = tokenMatch?.[1]?.trim();
    const isAuthenticated =
      callerToken &&
      peers.some(
        (p) => p.authToken != null && safeTokenEqual(p.authToken, callerToken)
      );

    const states = await db.query.syncState.findMany();
    const stateMap = new Map(states.map((s) => [s.syncPeerId, s]));

    if (isAuthenticated) {
      // Full details for authenticated callers (CP health check)
      const peerSummaries = peers.map((peer) => {
        const state = stateMap.get(peer.id);
        return {
          peerId: peer.id,
          direction: peer.direction,
          enabled: peer.enabled,
          status: state?.status ?? "unknown",
          lastSyncAt: state?.lastSyncAt?.toISOString() ?? null,
          eventsProcessed: state?.eventsProcessed ?? 0,
          errorCount: state?.errorCount ?? 0,
          lastError: state?.lastError ?? null,
          /** Outbound event-log cursor (push) or legacy combined cursor */
          lastCursor: state?.lastCursor?.toISOString() ?? null,
          /** Bidirectional: outbound push cursor */
          lastPushCursor: state?.lastPushCursor?.toISOString() ?? null,
          /** Bidirectional / pull: inbound cursor */
          lastPullCursor: state?.lastPullCursor?.toISOString() ?? null,
        };
      });
      return c.json({ ...base, peerCount: peers.length, peers: peerSummaries });
    }

    // Unauthenticated: status only — no topology leakage (no peerCount)
    return c.json(base);
  } catch {
    return c.json(base);
  }
});

// ============================================================================
// GET /status — Comprehensive sync + intelligence status for CP monitoring
// ============================================================================

/**
 * GET /status — Returns sync peer status plus intelligence service readiness.
 *
 * Auth: CP-signed JWT with type "sync-setup" (reuses the same JWT type CP already
 * issues for pod-linking operations).
 *
 * Response:
 * {
 *   syncPeers: [{ peerId, direction, enabled, status, lastSyncAt, eventsProcessed }],
 *   intelligenceService: {
 *     configured: boolean,
 *     serviceCount: number,
 *     services: [{ serviceId, name, status, enabled, lastHealthStatus, credentialsValid }]
 *   }
 * }
 */
app.get("/status", async (c) => {
  // Authenticate with CP JWT or peer token
  const payload = await verifyCpAuth<{
    type: string;
    podId: string;
  }>(c.req.header("authorization") ?? null);

  if (!payload || payload.type !== "sync-setup") {
    // Also allow peer token auth (same as /health authenticated path)
    const authHeader = c.req.header("authorization") ?? "";
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const callerToken = tokenMatch?.[1]?.trim();

    if (!callerToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const peers = await db.query.syncPeers.findMany({
      columns: { authToken: true },
    });
    const isAuthenticated =
      callerToken &&
      peers.some(
        (p) => p.authToken != null && safeTokenEqual(p.authToken, callerToken)
      );
    if (!isAuthenticated) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  // Sync peers status
  const peers = await db.query.syncPeers.findMany({
    columns: {
      id: true,
      peerPodUrl: true,
      direction: true,
      enabled: true,
    },
  });

  const states = await db.query.syncState.findMany();
  const stateMap = new Map(states.map((s) => [s.syncPeerId, s]));

  const peerSummaries = peers.map((peer) => {
    const state = stateMap.get(peer.id);
    return {
      peerId: peer.id,
      direction: peer.direction,
      enabled: peer.enabled,
      status: state?.status ?? "unknown",
      lastSyncAt: state?.lastSyncAt?.toISOString() ?? null,
      eventsProcessed: state?.eventsProcessed ?? 0,
      errorCount: state?.errorCount ?? 0,
      lastError: state?.lastError ?? null,
      lastCursor: state?.lastCursor?.toISOString() ?? null,
      lastPushCursor: state?.lastPushCursor?.toISOString() ?? null,
      lastPullCursor: state?.lastPullCursor?.toISOString() ?? null,
    };
  });

  // Intelligence service status
  const services = await db.query.intelligenceServices.findMany({
    columns: {
      serviceId: true,
      name: true,
      status: true,
      enabled: true,
      lastHealthCheck: true,
      lastHealthStatus: true,
      apiKey: true,
    },
  });

  const serviceSummaries = services.map((svc) => ({
    serviceId: svc.serviceId,
    name: svc.name,
    status: svc.status,
    enabled: svc.enabled,
    lastHealthStatus: svc.lastHealthStatus ?? "unknown",
    lastHealthCheck: svc.lastHealthCheck?.toISOString() ?? null,
    // A service has valid credentials if apiKey is not a placeholder
    credentialsValid:
      !!svc.apiKey &&
      svc.apiKey !== "SYNC_PLACEHOLDER" &&
      svc.apiKey.length > 0,
  }));

  const activeServices = services.filter(
    (s) =>
      s.enabled &&
      s.status === "active" &&
      s.apiKey &&
      s.apiKey !== "SYNC_PLACEHOLDER"
  );

  // Split-brain / generation status
  const generationInfo = await getSyncGenerationRow();

  return c.json({
    syncPeers: peerSummaries,
    intelligenceService: {
      configured: activeServices.length > 0,
      serviceCount: services.length,
      services: serviceSummaries,
    },
    syncGeneration: {
      generation: generationInfo.generation,
      role: generationInfo.role,
      splitBrainDetected: generationInfo.splitBrainDetected,
      splitBrainDetectedAt:
        generationInfo.splitBrainDetectedAt?.toISOString() ?? null,
      splitBrainLocalGen: generationInfo.splitBrainLocalGen,
      splitBrainRemoteGen: generationInfo.splitBrainRemoteGen,
      lastPeerGeneration: generationInfo.lastPeerGeneration,
      lastPeerContact: generationInfo.lastPeerContact?.toISOString() ?? null,
      promotedAt: generationInfo.promotedAt?.toISOString() ?? null,
    },
  });
});

// ============================================================================
// POST /promote — Manually promote this pod to primary (admin action)
// ============================================================================

/**
 * POST /promote — Promote this pod to primary after split-brain.
 *
 * Auth: CP-signed JWT with type "sync-setup" and action "promote".
 *
 * Clears the split-brain flag, sets role = 'primary'. The peer pod should
 * automatically detect this on next sync and adjust accordingly.
 */
app.post("/promote", async (c) => {
  const payload = await verifyCpAuth<{
    type: string;
    podId: string;
    action: string;
  }>(c.req.header("authorization") ?? null);

  if (
    !payload ||
    payload.type !== "sync-setup" ||
    payload.action !== "promote"
  ) {
    return c.json(
      { error: "Unauthorized — requires CP JWT with action: promote" },
      401
    );
  }

  await promoteToPrimary();

  const state = await getSyncGenerationRow();
  logger.info(
    { cpPodId: payload.podId, generation: state.generation },
    "Pod promoted to primary via CP action"
  );

  return c.json({
    promoted: true,
    generation: state.generation,
    role: state.role,
    splitBrainDetected: state.splitBrainDetected,
  });
});

// ============================================================================
// GET /generation — Public generation info (for health checks)
// ============================================================================

/**
 * GET /generation — Returns the pod's current generation and role.
 * Unauthenticated — returns only non-sensitive generation data.
 */
app.get("/generation", async (c) => {
  const state = await getSyncGenerationState();
  return c.json({
    generation: state.generation,
    role: state.role,
    splitBrainDetected: state.splitBrainDetected,
  });
});

export const syncReceiveApp = app;
