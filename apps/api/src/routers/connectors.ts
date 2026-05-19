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
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";
import crypto from "crypto";
import { matchAttendeesToContacts } from "../services/connector-matching.js";

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
// Core sync logic — shared between pull-sync (CP mode) and nango-webhook
// ---------------------------------------------------------------------------

interface SyncParams {
  userId: string;
  provider: string;
  nangoConnectionId: string;
  model: string;
  nangoHost: string;
  nangoKey: string;
}

interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
  recordCount: number;
}

async function runNangoSync(
  params: SyncParams
): Promise<SyncResult | { error: string; status: number }> {
  const { userId, provider, nangoConnectionId, model, nangoHost, nangoKey } =
    params;

  // Fetch records from Nango Records API
  let records: NangoRecord[];
  try {
    const url = new URL(`/records`, nangoHost);
    url.searchParams.set("model", model);
    url.searchParams.set("connection_id", nangoConnectionId);
    url.searchParams.set("provider_config_key", provider);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${nangoKey}` },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      logger.error(
        { status: response.status, body: errBody },
        "Failed to fetch Nango records"
      );
      return { error: "Failed to fetch records from Nango", status: 502 };
    }

    const data = (await response.json()) as Record<string, unknown>;
    records = (data.records || data.data || []) as NangoRecord[];
  } catch (err) {
    logger.error({ err }, "Nango records fetch failed");
    const ws = await getDb()
      .then((d) => d.query.workspaces.findFirst())
      .catch(() => null);
    if (ws) {
      emitSideEffects({
        subjectType: "connector_sync",
        action: "sync_completed",
        subjectId: nangoConnectionId,
        userId,
        workspaceId: ws.id,
        data: { provider, syncStatus: "error" },
      });
    }
    return { error: "Failed to fetch records", status: 502 };
  }

  if (records.length === 0) {
    return { created: 0, updated: 0, skipped: 0, recordCount: 0 };
  }

  const database = await getDb();
  const ws = await database.query.workspaces.findFirst();
  if (!ws) return { error: "No workspace found", status: 404 };

  const eventRepo = new EventRepository(sql);
  const entityRepo = new EntityRepository(database, eventRepo);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const createdEntityIds: string[] = [];

  for (const record of records) {
    const mapped = mapNangoRecord(provider, model, record);
    if (!mapped) {
      skipped++;
      continue;
    }

    const recordHash = hashRecord(record);

    try {
      const existingLink = await database.query.entityExternalLinks.findFirst({
        where: and(
          eq(entityExternalLinks.provider, provider),
          eq(entityExternalLinks.externalId, mapped.externalId)
        ),
      });

      if (existingLink) {
        if (existingLink.syncHash === recordHash) {
          skipped++;
          continue;
        }
        await entityRepo.update(
          existingLink.entityId,
          { title: mapped.title, properties: mapped.properties },
          userId
        );
        await database
          .update(entityExternalLinks)
          .set({ syncHash: recordHash, lastSyncedAt: new Date() })
          .where(eq(entityExternalLinks.id, existingLink.id));
        updated++;
      } else {
        const createdEntity = await entityRepo.create(
          {
            profileSlug: mapped.profileSlug,
            title: mapped.title,
            properties: mapped.properties,
            workspaceId: ws.id,
            userId,
            skipValidation: true,
          },
          userId
        );
        await database.insert(entityExternalLinks).values({
          entityId: createdEntity.id,
          provider,
          externalId: mapped.externalId,
          nangoConnectionId,
          status: "active",
          syncHash: recordHash,
        });
        createdEntityIds.push(createdEntity.id);
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

  logger.info({ provider, model, created, updated, skipped }, "Sync completed");

  // Match calendar attendees / email senders to existing person entities
  if (createdEntityIds.length > 0) {
    matchAttendeesToContacts(ws.id, createdEntityIds).catch((err) =>
      logger.warn({ err }, "Attendee matching failed (non-fatal)")
    );
  }

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

  return { created, updated, skipped, recordCount: records.length };
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

  // Resolve Nango credentials from workspace settings (CP mode) or env (local mode)
  const database = await getDb();
  const ws = await database.query.workspaces.findFirst();
  const wsSettings = (ws?.settings as Record<string, unknown>) ?? {};
  const cpSettings = (wsSettings.controlPlane as Record<string, unknown>) ?? {};

  const nangoHost = (cpSettings.nangoHost as string) || process.env.NANGO_HOST;
  const nangoKey =
    (cpSettings.nangoRecordsApiKey as string) || process.env.NANGO_SECRET_KEY;

  if (!nangoHost || !nangoKey) {
    logger.error("Nango not configured — missing nangoHost / NANGO_SECRET_KEY");
    return c.json({ error: "Nango not configured on this pod" }, 503);
  }

  const result = await runNangoSync({
    userId,
    provider,
    nangoConnectionId,
    model,
    nangoHost,
    nangoKey,
  });
  if ("error" in result)
    return c.json(
      { error: result.error },
      result.status as 400 | 401 | 403 | 404 | 500 | 502 | 503
    );

  return c.json({
    success: true,
    entitiesProcessed: result.created + result.updated,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
  });
});

// ---------------------------------------------------------------------------
// POST /nango-webhook — Self-hosted Nango sync notification
//
// Called by Nango (self-hosted) when a sync job completes. No CP JWT needed;
// authenticity is verified via HMAC-SHA256 of the raw body using the pod's
// NANGO_SECRET_KEY. This is the local-mode equivalent of /pull-sync.
//
// Nango webhook payload shape:
//   { from, type, connectionId, providerConfigKey, model, success, ... }
//
// connectionId is set to the userId (from end_user.id in createSession).
// ---------------------------------------------------------------------------

const NangoWebhookSchema = z.object({
  from: z.string(),
  type: z.string(),
  connectionId: z.string().min(1),
  providerConfigKey: z.string().min(1),
  model: z.string().min(1),
  success: z.boolean().optional(),
});

connectorsRouter.post("/nango-webhook", async (c) => {
  const nangoKey = process.env.NANGO_SECRET_KEY;
  if (!nangoKey) {
    // Self-hosted Nango not configured — ignore webhook
    return c.json({ ok: true, skipped: true });
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("x-nango-signature") ?? "";

  // Validate HMAC signature
  const expected = `sha256=${crypto
    .createHmac("sha256", nangoKey)
    .update(rawBody)
    .digest("hex")}`;

  if (
    Buffer.byteLength(signature) !== Buffer.byteLength(expected) ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    logger.warn({ signature }, "nango-webhook: invalid HMAC signature");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const parsed = NangoWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Unexpected webhook payload" }, 400);
  }

  const { connectionId, providerConfigKey, model, success } = parsed.data;

  if (success === false) {
    logger.info(
      { connectionId, providerConfigKey, model },
      "nango-webhook: sync failed, skipping ingest"
    );
    return c.json({ ok: true, skipped: true });
  }

  // connectionId = userId (we set end_user.id = userId in createSession)
  const userId = connectionId;
  const nangoHost = process.env.NANGO_HOST ?? "http://localhost:3003";

  logger.info(
    { userId, provider: providerConfigKey, model },
    "nango-webhook: triggering sync ingest"
  );

  const result = await runNangoSync({
    userId,
    provider: providerConfigKey,
    nangoConnectionId: connectionId,
    model,
    nangoHost,
    nangoKey,
  });

  if ("error" in result) {
    logger.error({ error: result.error }, "nango-webhook: sync ingest failed");
    return c.json(
      { error: result.error },
      result.status as 400 | 401 | 403 | 404 | 500 | 502 | 503
    );
  }

  return c.json({
    ok: true,
    entitiesProcessed: result.created + result.updated,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
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
