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
} from "@synap/database";
import { entityExternalLinks } from "@synap/database/schema";
import { verifyCpJwtWithTrust } from "@synap/api";
import { emitSideEffects } from "@synap/jobs";
import { createLogger } from "@synap-core/core";
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
    case "google-mail": {
      // Emails map to "note" entities — they're captured communications.
      // The subject becomes the title; body_text + snippet go into content.
      // from_email is stored so the pod can later match it to a person entity.
      const fromEmail = (record.from_email as string) || "";
      const subject = (record.subject as string) || "(no subject)";
      const bodyText = (record.body_text as string) || null;
      const snippet = (record.snippet as string) || null;
      const content = bodyText || snippet || null;
      const date = (record.date as string) || null;

      return {
        profileSlug: "note",
        title: subject,
        externalId: record.id as string,
        properties: {
          content,
          fromEmail,
          fromName: record.from_name || null,
          toEmails: Array.isArray(record.to_emails) ? record.to_emails : [],
          emailDate: date,
          threadId: record.thread_id || null,
          isUnread: record.is_unread ?? false,
          source: "google-mail",
          tags: ["email"],
        },
      };
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

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "pull-sync refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  let cpUrl: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { url?: string } | undefined;
    cpUrl = cp?.url;
  } catch {
    /* fall through */
  }

  const payload = await verifyCpJwtWithTrust<{
    type: string;
    podId: string;
    userId: string;
    provider: string;
    nangoConnectionId: string;
    model: string;
  }>(parsed.data.token, {
    pinnedIssuer: cpUrl,
    audience: podPublicUrl,
  });

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
    (cpSettings.nangoRecordsApiKey as string) || process.env.NANGO_SECRET_KEY;

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

    const data = (await response.json()) as Record<string, unknown>;
    records = (data.records || data.data || []) as NangoRecord[];
  } catch (err) {
    logger.error({ err }, "Nango records fetch failed");
    // Automation side-effects: connector.sync.completed (error) for connector_sync triggers
    const wsForErr = await getDb()
      .then((d) => d.query.workspaces.findFirst())
      .catch(() => null);
    if (wsForErr) {
      emitSideEffects({
        subjectType: "connector_sync",
        action: "sync_completed",
        subjectId: nangoConnectionId,
        userId,
        workspaceId: wsForErr.id,
        data: {
          provider,
          syncStatus: "error",
        },
      });
    }
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

  // Automation side-effects: connector.sync.completed for connector_sync triggers
  if (ws) {
    emitSideEffects({
      subjectType: "connector_sync",
      action: "sync_completed",
      subjectId: nangoConnectionId,
      userId,
      workspaceId: ws.id,
      data: {
        provider,
        syncStatus: "success",
        entitiesProcessed: created + updated,
      },
    });
  }

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

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "connector disconnect refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  let cpUrl: string | undefined;
  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });
    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as { url?: string } | undefined;
    cpUrl = cp?.url;
  } catch {
    /* fall through */
  }

  const payload = await verifyCpJwtWithTrust<{
    type: string;
    podId: string;
    provider: string;
    nangoConnectionId: string;
  }>(parsed.data.token, {
    pinnedIssuer: cpUrl,
    audience: podPublicUrl,
  });

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
