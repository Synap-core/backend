/**
 * Connectors REST Router
 *
 * Handles CP → Pod communication for external connector syncing.
 * All endpoints use JWT verification (same as provision router).
 *
 * Routes:
 *   POST /pull-sync   — Receive "sync ready" signal, pull records from Nango
 *   POST /disconnect   — Mark external links as disconnected
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  getDb,
  sql,
  eq,
  and,
  EntityRepository,
  EventRepository,
  ProfileResolutionService,
} from "@synap/database";
import {
  entities,
  entityExternalLinks,
  workspaces,
} from "@synap/database/schema";
import { verifyCpJwt } from "@synap/api";
import { config, createLogger } from "@synap-core/core";
import crypto from "crypto";

const logger = createLogger({ module: "connectors-router" });

export const connectorsRouter = new Hono();

// ---------------------------------------------------------------------------
// Entity mapping: convert Nango records to Synap entity format
// ---------------------------------------------------------------------------

interface NangoRecord {
  id: string;
  [key: string]: unknown;
}

interface MappedEntity {
  profileSlug: string;
  title: string;
  properties: Record<string, unknown>;
  externalId: string;
}

/**
 * Map a Nango record to a Synap entity based on provider + model.
 */
function mapNangoRecord(
  provider: string,
  model: string,
  record: NangoRecord
): MappedEntity | null {
  switch (provider) {
    case "google-calendar": {
      return {
        profileSlug: "event",
        title:
          (record.summary as string) ||
          (record.name as string) ||
          "Untitled Event",
        externalId: record.id,
        properties: {
          startDate: record.start_datetime || record.start_date,
          endDate: record.end_datetime || record.end_date,
          location: record.location || null,
          description: record.description || null,
          attendees: Array.isArray(record.attendees)
            ? record.attendees.map((a: any) => a.email || a)
            : [],
          calendarLink: record.html_link || null,
          source: "google-calendar",
        },
      };
    }
    case "google-contacts": {
      const name =
        (record.given_name as string) || (record.name as string) || "Unnamed";
      return {
        profileSlug: "contact",
        title: name,
        externalId: record.id,
        properties: {
          email: record.email || null,
          phone: record.phone || null,
          company: record.organization || null,
          notes: record.notes || null,
          source: "google-contacts",
        },
      };
    }
    case "github": {
      if (model === "Repository") {
        return {
          profileSlug: "repository",
          title: (record.name as string) || "Untitled Repo",
          externalId: record.id,
          properties: {
            description: record.description || null,
            url: record.html_url || record.url || null,
            language: record.language || null,
            stars: record.stargazers_count || 0,
            source: "github",
          },
        };
      }
      if (model === "Issue") {
        return {
          profileSlug: "task",
          title: (record.title as string) || "Untitled Issue",
          externalId: record.id,
          properties: {
            description: record.body || null,
            status: record.state === "closed" ? "done" : "todo",
            url: record.html_url || null,
            labels: Array.isArray(record.labels)
              ? record.labels.map((l: any) => l.name || l)
              : [],
            source: "github",
          },
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Generate a hash of a record for change detection.
 */
function hashRecord(record: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(record))
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// POST /pull-sync — Receive sync-ready JWT, pull records from Nango
// ---------------------------------------------------------------------------

connectorsRouter.post("/pull-sync", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ token: z.string().min(1) }).safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const cpUrl = config.server.controlPlaneUrl;
  const payload = await verifyCpJwt<{
    type: string;
    podId: string;
    userId: string;
    provider: string;
    nangoConnectionId: string;
    model: string;
  }>(parsed.data.token, cpUrl);

  if (!payload || payload.type !== "connector_sync_ready") {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const { userId, provider, nangoConnectionId, model } = payload;

  logger.info(
    { provider, model, userId },
    "Pull-sync: received sync-ready signal"
  );

  // Resolve Nango host and API key from workspace settings (provisioned by CP)
  const database = await getDb();
  const ws = await database.query.workspaces.findFirst();
  const wsSettings = (ws?.settings as Record<string, unknown>) ?? {};
  const cpSettings = (wsSettings.controlPlane as Record<string, unknown>) ?? {};

  const nangoHost = (cpSettings.nangoHost as string) || process.env.NANGO_HOST;
  const nangoKey =
    (cpSettings.nangoRecordsApiKey as string) ||
    process.env.NANGO_RECORDS_API_KEY;

  if (!nangoHost || !nangoKey) {
    logger.error(
      "Nango not configured — missing nangoHost or nangoRecordsApiKey in workspace settings"
    );
    return c.json({ error: "Nango not configured on this pod" }, 503);
  }

  // Fetch records from Nango Records API
  let records: NangoRecord[];
  try {
    const url = new URL(`/records`, nangoHost);
    url.searchParams.set("model", model);
    url.searchParams.set("connection_id", nangoConnectionId);
    url.searchParams.set("provider_config_key", provider);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${nangoKey}`,
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      logger.error(
        { status: response.status, body: errBody },
        "Failed to fetch Nango records"
      );
      return c.json({ error: "Failed to fetch records from Nango" }, 502);
    }

    const data = await response.json();
    records = data.records || data.data || [];
  } catch (err) {
    logger.error({ err }, "Nango records fetch failed");
    return c.json({ error: "Failed to fetch records" }, 502);
  }

  logger.info(
    { provider, model, recordCount: records.length },
    "Fetched records from Nango"
  );

  if (records.length === 0) {
    return c.json({ success: true, entitiesProcessed: 0 });
  }

  // Get repositories (database already resolved above for Nango config)
  const eventRepo = new EventRepository(sql);
  const entityRepo = new EntityRepository(database, eventRepo);

  if (!ws) {
    return c.json({ error: "No workspace found" }, 404);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const record of records) {
    const mapped = mapNangoRecord(provider, model, record);
    if (!mapped) {
      skipped++;
      continue;
    }

    const recordHash = hashRecord(record);

    try {
      // Check if we already have this external record linked
      const existingLink = await database.query.entityExternalLinks.findFirst({
        where: and(
          eq(entityExternalLinks.provider, provider),
          eq(entityExternalLinks.externalId, mapped.externalId)
        ),
      });

      if (existingLink) {
        // Check if the record actually changed
        if (existingLink.syncHash === recordHash) {
          skipped++;
          continue;
        }

        // Update existing entity
        await entityRepo.update(
          existingLink.entityId,
          {
            title: mapped.title,
            properties: mapped.properties,
          },
          userId
        );

        // Update sync hash
        await database
          .update(entityExternalLinks)
          .set({
            syncHash: recordHash,
            lastSyncedAt: new Date(),
          })
          .where(eq(entityExternalLinks.id, existingLink.id));

        updated++;
      } else {
        // Create new entity
        const createdEntity = await entityRepo.create(
          {
            profileSlug: mapped.profileSlug,
            title: mapped.title,
            properties: mapped.properties,
            workspaceId: ws.id,
            userId,
            skipValidation: true, // External data may not match profile schema exactly
          },
          userId
        );

        // Create external link
        await database.insert(entityExternalLinks).values({
          entityId: createdEntity.id,
          provider,
          externalId: mapped.externalId,
          nangoConnectionId,
          status: "active",
          syncHash: recordHash,
        });

        created++;
      }
    } catch (err) {
      logger.warn(
        { err, externalId: mapped.externalId, provider },
        "Failed to upsert entity from connector"
      );
      skipped++;
    }
  }

  logger.info(
    { provider, model, created, updated, skipped },
    "Pull-sync completed"
  );

  return c.json({
    success: true,
    entitiesProcessed: created + updated,
    created,
    updated,
    skipped,
  });
});

// ---------------------------------------------------------------------------
// POST /disconnect — Mark external links as disconnected
// ---------------------------------------------------------------------------

connectorsRouter.post("/disconnect", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ token: z.string().min(1) }).safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const cpUrl = config.server.controlPlaneUrl;
  const payload = await verifyCpJwt<{
    type: string;
    podId: string;
    provider: string;
    nangoConnectionId: string;
  }>(parsed.data.token, cpUrl);

  if (!payload || payload.type !== "connector_disconnect") {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const { provider, nangoConnectionId } = payload;
  const database = await getDb();

  // Mark all external links for this connection as disconnected
  const result = await database
    .update(entityExternalLinks)
    .set({
      status: "disconnected",
      disconnectedAt: new Date(),
    })
    .where(
      and(
        eq(entityExternalLinks.nangoConnectionId, nangoConnectionId),
        eq(entityExternalLinks.status, "active")
      )
    )
    .returning({ id: entityExternalLinks.id });

  logger.info(
    { provider, nangoConnectionId, disconnectedCount: result.length },
    "External links marked as disconnected"
  );

  return c.json({
    success: true,
    disconnectedCount: result.length,
  });
});
