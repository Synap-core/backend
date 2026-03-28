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
import { createLogger } from "@synap-core/core";
import {
  db,
  syncPeers,
  events,
  eq,
  and,
  or,
  drizzleSql,
  syncReceiveInputSchema,
  materializeBatch,
} from "@synap/database";

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

  // A peer that pushes to us is registered locally with direction "pull" or "bidirectional"
  const peer = await db.query.syncPeers.findFirst({
    where: and(
      or(
        eq(syncPeers.direction, "pull"),
        eq(syncPeers.direction, "bidirectional")
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
): Promise<{ peerId: string } | null> {
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();

  // A peer that pulls from us is registered locally with direction "push" or "bidirectional"
  const peer = await db.query.syncPeers.findFirst({
    where: and(
      or(
        eq(syncPeers.direction, "push"),
        eq(syncPeers.direction, "bidirectional")
      ),
      eq(syncPeers.enabled, true),
      eq(syncPeers.authToken, token)
    ),
    columns: { id: true },
  });

  if (!peer) return null;
  return { peerId: peer.id };
}

// ============================================================================
// Hono app
// ============================================================================

const app = new Hono();

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

  return c.json({
    received: true,
    processed: incomingEvents.length,
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

  // 3. Query local completed events after cursor
  const batch = await db
    .select()
    .from(events)
    .where(
      and(
        drizzleSql`${events.timestamp} > ${since}`,
        drizzleSql`${events.type} LIKE '%.completed'`
      )
    )
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
  });
});

// ============================================================================
// POST /receive-supplementary — Accept supplementary table rows from a push peer
// ============================================================================

const supplementaryInputSchema = z.object({
  table: z.string(),
  rows: z.array(z.record(z.unknown())),
  cursor: z.string(), // ISO datetime of last row in batch
});

/** Supported supplementary tables and their upsert logic */
const SUPPLEMENTARY_TABLES: Record<
  string,
  (rows: Record<string, unknown>[]) => Promise<number>
> = {
  messages: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        await db
          .insert(messages)
          .values({
            id: row.id as string,
            channelId: row.channelId as string,
            parentId: (row.parentId as string) ?? null,
            role: (row.role as "user" | "assistant" | "system") ?? "user",
            authorType:
              (row.authorType as "human" | "ai_agent" | "external" | "bot") ??
              "human",
            messageCategory:
              (row.messageCategory as
                | "chat"
                | "comment"
                | "system_notification"
                | "review") ?? "chat",
            externalSource: (row.externalSource as string) ?? null,
            inboxItemId: (row.inboxItemId as string) ?? null,
            content: (row.content as string) ?? "",
            metadata: row.metadata ?? null,
            userId: (row.userId as string) ?? "sync",
            timestamp: row.timestamp
              ? new Date(row.timestamp as string)
              : new Date(),
            previousHash: (row.previousHash as string) ?? null,
            hash: (row.hash as string) ?? "",
            sessionId: (row.sessionId as string) ?? null,
            deletedAt: row.deletedAt ? new Date(row.deletedAt as string) : null,
          })
          .onConflictDoUpdate({
            target: messages.id,
            set: {
              content: (row.content as string) ?? "",
              metadata: row.metadata ?? null,
              deletedAt: row.deletedAt
                ? new Date(row.deletedAt as string)
                : null,
            },
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
        await db
          .insert(automations)
          .values({
            id: row.id as string,
            workspaceId: row.workspaceId as string,
            createdBy: (row.createdBy as string) ?? "sync",
            name: (row.name as string) ?? "Synced Automation",
            description: (row.description as string) ?? null,
            triggerType:
              (row.triggerType as "event" | "cron" | "webhook" | "manual") ??
              "manual",
            triggerConfig: (row.triggerConfig as Record<string, unknown>) ?? {},
            flowDefinition: (row.flowDefinition as {
              nodes: unknown[];
              edges: unknown[];
            }) ?? { nodes: [], edges: [] },
            status:
              (row.status as "draft" | "active" | "paused" | "error") ??
              "draft",
            errorMessage: (row.errorMessage as string) ?? null,
            lastRunAt: row.lastRunAt ? new Date(row.lastRunAt as string) : null,
            nextRunAt: row.nextRunAt ? new Date(row.nextRunAt as string) : null,
            runCount: (row.runCount as number) ?? 0,
            successCount: (row.successCount as number) ?? 0,
            failureCount: (row.failureCount as number) ?? 0,
            metadata: (row.metadata as Record<string, unknown>) ?? {},
            createdAt: row.createdAt
              ? new Date(row.createdAt as string)
              : new Date(),
            updatedAt: row.updatedAt
              ? new Date(row.updatedAt as string)
              : new Date(),
          })
          .onConflictDoUpdate({
            target: automations.id,
            set: {
              name: (row.name as string) ?? undefined,
              description: (row.description as string) ?? null,
              triggerConfig:
                (row.triggerConfig as Record<string, unknown>) ?? {},
              flowDefinition: (row.flowDefinition as {
                nodes: unknown[];
                edges: unknown[];
              }) ?? { nodes: [], edges: [] },
              status:
                (row.status as "draft" | "active" | "paused" | "error") ??
                undefined,
              errorMessage: (row.errorMessage as string) ?? null,
              runCount: (row.runCount as number) ?? 0,
              successCount: (row.successCount as number) ?? 0,
              failureCount: (row.failureCount as number) ?? 0,
              metadata: (row.metadata as Record<string, unknown>) ?? {},
              updatedAt: row.updatedAt
                ? new Date(row.updatedAt as string)
                : new Date(),
            },
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
        await db
          .insert(automationRuns)
          .values({
            id: row.id as string,
            automationId: row.automationId as string,
            workspaceId: row.workspaceId as string,
            triggeredBy: (row.triggeredBy as string) ?? null,
            triggerPayload:
              (row.triggerPayload as Record<string, unknown>) ?? {},
            status:
              (row.status as
                | "running"
                | "completed"
                | "failed"
                | "cancelled") ?? "running",
            errorMessage: (row.errorMessage as string) ?? null,
            stepsCompleted: (row.stepsCompleted as number) ?? 0,
            stepsFailed: (row.stepsFailed as number) ?? 0,
            outputSummary:
              (row.outputSummary as Record<string, unknown>) ?? null,
            startedAt: row.startedAt
              ? new Date(row.startedAt as string)
              : new Date(),
            completedAt: row.completedAt
              ? new Date(row.completedAt as string)
              : null,
          })
          .onConflictDoUpdate({
            target: automationRuns.id,
            set: {
              status:
                (row.status as
                  | "running"
                  | "completed"
                  | "failed"
                  | "cancelled") ?? undefined,
              errorMessage: (row.errorMessage as string) ?? null,
              stepsCompleted: (row.stepsCompleted as number) ?? 0,
              stepsFailed: (row.stepsFailed as number) ?? 0,
              outputSummary:
                (row.outputSummary as Record<string, unknown>) ?? null,
              completedAt: row.completedAt
                ? new Date(row.completedAt as string)
                : null,
            },
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

  intelligence_commands: async (rows) => {
    let processed = 0;
    for (const row of rows) {
      try {
        await db
          .insert(intelligenceCommands)
          .values({
            id: row.id as string,
            workspaceId: row.workspaceId as string,
            createdBy: (row.createdBy as string) ?? "sync",
            title: (row.title as string) ?? "Synced Command",
            promptTemplate: (row.promptTemplate as string) ?? "",
            compiledTemplateAst: row.compiledTemplateAst ?? null,
            derivedInputs: (row.derivedInputs as unknown[]) ?? null,
            inputOverrides:
              (row.inputOverrides as Record<string, unknown>) ?? null,
            allowedTools: (row.allowedTools as string[]) ?? null,
            allowedEntityTypes: (row.allowedEntityTypes as string[]) ?? null,
            maxEntitiesCreatedPerRun:
              (row.maxEntitiesCreatedPerRun as number) ?? null,
            canCreateViews: (row.canCreateViews as boolean) ?? false,
            outputMode:
              (row.outputMode as "text" | "proposal" | "view") ?? "text",
            permissionsProfile:
              (row.permissionsProfile as "read_only" | "propose_writes") ??
              "propose_writes",
            sharedScope:
              (row.sharedScope as "workspace" | "user") ?? "workspace",
            createdAt: row.createdAt
              ? new Date(row.createdAt as string)
              : new Date(),
            updatedAt: row.updatedAt
              ? new Date(row.updatedAt as string)
              : new Date(),
          })
          .onConflictDoUpdate({
            target: intelligenceCommands.id,
            set: {
              title: (row.title as string) ?? undefined,
              promptTemplate: (row.promptTemplate as string) ?? undefined,
              compiledTemplateAst: row.compiledTemplateAst ?? null,
              derivedInputs: (row.derivedInputs as unknown[]) ?? null,
              inputOverrides:
                (row.inputOverrides as Record<string, unknown>) ?? null,
              allowedTools: (row.allowedTools as string[]) ?? null,
              allowedEntityTypes: (row.allowedEntityTypes as string[]) ?? null,
              maxEntitiesCreatedPerRun:
                (row.maxEntitiesCreatedPerRun as number) ?? null,
              canCreateViews: (row.canCreateViews as boolean) ?? false,
              outputMode:
                (row.outputMode as "text" | "proposal" | "view") ?? "text",
              permissionsProfile:
                (row.permissionsProfile as "read_only" | "propose_writes") ??
                "propose_writes",
              sharedScope:
                (row.sharedScope as "workspace" | "user") ?? "workspace",
              updatedAt: row.updatedAt
                ? new Date(row.updatedAt as string)
                : new Date(),
            },
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
  const authResult = await authenticateSyncPeer(c.req, "pull");
  if (!authResult) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: z.infer<typeof filePayloadSchema>;
  try {
    body = filePayloadSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  try {
    // Store content in local S3/MinIO
    const buffer = Buffer.from(body.contentBase64, "base64");
    const { storage } = await import("@synap/storage");
    await storage.upload(body.storageKey, buffer, {
      contentType: body.mimeType,
    });

    // Upsert document row
    const { documents } = await import("@synap/database");
    await db
      .insert(documents)
      .values({
        id: body.documentId,
        storageKey: body.storageKey,
        mimeType: body.mimeType,
        size: body.size ?? buffer.length,
        title: body.title,
        type: body.type ?? "document",
        currentVersion: body.currentVersion ?? 1,
        workspaceId: body.workspaceId,
      } as any)
      .onConflictDoUpdate({
        target: [documents.id],
        set: {
          storageKey: body.storageKey,
          mimeType: body.mimeType,
          size: body.size ?? buffer.length,
          currentVersion: body.currentVersion ?? 1,
          updatedAt: new Date(),
        } as any,
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
  const authResult = await authenticateSyncPeer(c.req, "pull");
  if (!authResult) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: z.infer<typeof fileVersionPayloadSchema>;
  try {
    body = fileVersionPayloadSchema.parse(await c.req.json());
  } catch (err) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  try {
    const { documentVersions } = await import("@synap/database");
    await db
      .insert(documentVersions)
      .values({
        id: body.versionId,
        documentId: body.documentId,
        version: body.version ?? 1,
        content: body.content,
        author: body.author,
        authorId: body.authorId,
        message: body.message,
        createdAt: body.createdAt ? new Date(body.createdAt) : new Date(),
      } as any)
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

/**
 * GET /health — Simple health check for sync endpoint
 */
app.get("/health", (c) => c.json({ status: "ok", service: "sync" }));

export const syncReceiveApp = app;
