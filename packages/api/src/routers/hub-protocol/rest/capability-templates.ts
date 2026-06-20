/**
 * Hub Protocol REST — capability templates (templates-as-data CRUD)
 *
 * The write/read door for the `capability_templates` table. Templates are CONFIG
 * (seed CapabilityDefinitions), not entity DATA — so there is no governed entity
 * router to delegate to; these routes write `capability_templates` directly,
 * gated on `hub-protocol.write` / `hub-protocol.read` scope and the trusted
 * acting identity (resolveActingContext), with an audit-log row per mutation.
 *
 * This is what lets `eve capabilities sync` push the vendored seed definitions
 * into the DB so a `templateKey` apply resolves on a deployed pod (where the JSON
 * files are not bundled).
 *
 * Routes:
 *   POST   /capabilities/templates       — upsert by (key, workspaceId); bump
 *                                           version, clear soft-delete.
 *   GET    /capabilities/templates       — list LIVE templates (deleted_at IS NULL).
 *   DELETE /capabilities/templates/:key  — soft-delete (set deleted_at/deleted_by).
 */

import { z } from "@hono/zod-openapi";

import { db, capabilityTemplates, and, eq, isNull } from "@synap/database";

import { auditLog } from "../../../utils/audit-log.js";

import { CapabilityDefinitionSchema } from "./capabilities.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

// ── Local OpenAPI schemas ────────────────────────────────────────────────────

const UpsertTemplateRequestSchema = z.object({
  /** templateKey, e.g. "generic-apikey". `^[a-z0-9-]+$`. */
  key: z
    .string()
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().optional(),
  /** The full CapabilityDefinition (validated with the shared schema). */
  definition: CapabilityDefinitionSchema,
  /** Omit for pod-wide. */
  workspaceId: z.string().uuid().optional(),
  /** Provenance hint. Defaults to "manual". */
  source: z.string().max(64).optional(),
});

const TemplateResponseSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  workspaceId: z.string().nullable(),
  version: z.number(),
  source: z.string().nullable(),
  status: z.enum(["created", "updated"]).optional(),
});

const ListTemplatesResponseSchema = z.object({
  templates: z.array(TemplateResponseSchema),
});

// ── Register function ──────────────────────────────────────────────────────

export function registerCapabilityTemplatesRoutes(app: HubHono): void {
  // ── POST /capabilities/templates — upsert ──────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/capabilities/templates",
    tags: ["Capabilities"],
    summary: "Upsert a capability template",
    description:
      "Stores a seed CapabilityDefinition in the DB (templates-as-data). Upsert " +
      "by (key, workspaceId): bumps `version` and clears any prior soft-delete. " +
      "Omit `workspaceId` for a pod-wide template. Requires hub-protocol.write scope.",
    request: { body: UpsertTemplateRequestSchema },
    responses: {
      200: { description: "Upserted template", schema: TemplateResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/capabilities/templates", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const parsed = UpsertTemplateRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const body = parsed.data;

    try {
      const acting = await resolveActingContext(c, {
        workspaceId: body.workspaceId,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const workspaceId = body.workspaceId ?? null;

      // Upsert by (key, workspaceId). The unique partial index only covers
      // pod-wide rows, so we find-then-update/insert explicitly to handle both
      // pod-wide and workspace-scoped rows uniformly.
      const existing = await db
        .select({
          id: capabilityTemplates.id,
          version: capabilityTemplates.version,
        })
        .from(capabilityTemplates)
        .where(
          and(
            eq(capabilityTemplates.key, body.key),
            workspaceId
              ? eq(capabilityTemplates.workspaceId, workspaceId)
              : isNull(capabilityTemplates.workspaceId)
          )
        )
        .limit(1);

      let row;
      let status: "created" | "updated";
      if (existing.length > 0) {
        const [updated] = await db
          .update(capabilityTemplates)
          .set({
            name: body.name,
            description: body.description ?? null,
            definition: body.definition,
            version: existing[0].version + 1,
            source: body.source ?? "manual",
            deletedAt: null, // un-delete on upsert
            deletedBy: null,
            updatedAt: new Date(),
          })
          .where(eq(capabilityTemplates.id, existing[0].id))
          .returning();
        row = updated;
        status = "updated";
      } else {
        const [created] = await db
          .insert(capabilityTemplates)
          .values({
            key: body.key,
            workspaceId,
            name: body.name,
            description: body.description ?? null,
            definition: body.definition,
            version: 1,
            source: body.source ?? "manual",
            createdBy: acting.userId,
          })
          .returning();
        row = created;
        status = "created";
      }

      await auditLog({
        subjectType: "capability_template",
        action: status === "created" ? "created" : "updated",
        phase: "completed",
        subjectId: row.id,
        userId: acting.userId,
        workspaceId,
        data: { key: row.key, version: row.version },
      });

      return c.json(
        {
          id: row.id,
          key: row.key,
          name: row.name,
          description: row.description,
          workspaceId: row.workspaceId,
          version: row.version,
          source: row.source,
          status,
        },
        200
      );
    } catch (err) {
      logger.error({ err }, "capability template upsert failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /capabilities/templates — list live ────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/capabilities/templates",
    tags: ["Capabilities"],
    summary: "List capability templates",
    description:
      "Lists LIVE capability templates (pod-wide + workspace overlays). " +
      "Requires hub-protocol.read scope.",
    responses: {
      200: { description: "Templates", schema: ListTemplatesResponseSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/capabilities/templates", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    try {
      const rows = await db
        .select({
          id: capabilityTemplates.id,
          key: capabilityTemplates.key,
          name: capabilityTemplates.name,
          description: capabilityTemplates.description,
          workspaceId: capabilityTemplates.workspaceId,
          version: capabilityTemplates.version,
          source: capabilityTemplates.source,
        })
        .from(capabilityTemplates)
        .where(isNull(capabilityTemplates.deletedAt));

      return c.json({ templates: rows }, 200);
    } catch (err) {
      logger.error({ err }, "capability template list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── DELETE /capabilities/templates/:key — soft-delete ──────────────────────
  registerOpenApi(app, {
    method: "delete",
    path: "/capabilities/templates/{key}",
    tags: ["Capabilities"],
    summary: "Soft-delete a capability template",
    description:
      "Soft-deletes the LIVE template for `key` (pod-wide, or the acting " +
      "workspace if `workspaceId` query is given). Requires hub-protocol.write scope.",
    request: {
      params: z.object({ key: z.string() }),
    },
    responses: {
      200: {
        description: "Deleted",
        schema: z.object({ deleted: z.boolean() }),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.delete("/capabilities/templates/:key", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const key = c.req.param("key");
    const workspaceIdQuery = c.req.query("workspaceId");

    try {
      const acting = await resolveActingContext(c, {
        workspaceId: workspaceIdQuery,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const workspaceId = workspaceIdQuery ?? null;

      const [deleted] = await db
        .update(capabilityTemplates)
        .set({ deletedAt: new Date(), deletedBy: acting.userId })
        .where(
          and(
            eq(capabilityTemplates.key, key),
            isNull(capabilityTemplates.deletedAt),
            workspaceId
              ? eq(capabilityTemplates.workspaceId, workspaceId)
              : isNull(capabilityTemplates.workspaceId)
          )
        )
        .returning({ id: capabilityTemplates.id });

      if (!deleted) {
        return c.json({ error: `Template not found: ${key}` }, 404);
      }

      await auditLog({
        subjectType: "capability_template",
        action: "deleted",
        phase: "completed",
        subjectId: deleted.id,
        userId: acting.userId,
        workspaceId,
        data: { key },
      });

      return c.json({ deleted: true }, 200);
    } catch (err) {
      logger.error({ err }, "capability template delete failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
