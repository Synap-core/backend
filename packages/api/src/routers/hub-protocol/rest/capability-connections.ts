/**
 * Hub Protocol REST — capability connections CRUD (Wave 4).
 *
 * Thin governed door over `services/capabilities/capability-connections.ts` (the
 * single writer). A connection is a `secrets` row carrying `capability_id` — the
 * vault IS the connection registry (plan §3.2). No route ever returns a secret
 * value; the service is owner-gated.
 *
 *   GET    /capabilities/:capabilityId/connections        (read)
 *   POST   /capabilities/:capabilityId/connections        (write)
 *   PATCH  /capabilities/:capabilityId/connections/:id     (write)
 *   DELETE /capabilities/:capabilityId/connections/:id     (write)
 */

import { z } from "zod";

import {
  addConnection,
  listConnections,
  removeConnection,
  updateConnection,
} from "../../../services/capabilities/capability-connections.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

// ── OpenAPI schemas ────────────────────────────────────────────────────────────

const ConnectionSchema = z.object({
  id: z.string(),
  label: z.string(),
  contextType: z.string().nullable(),
  contextId: z.string().nullable(),
  isDefault: z.boolean(),
  accountHint: z.string().nullable(),
  kind: z.enum(["nango", "vault"]),
});

const ListConnectionsResponseSchema = z.object({
  connections: z.array(ConnectionSchema),
});

const AddConnectionRequestSchema = z.object({
  label: z.string().min(1).max(255),
  value: z.string().optional(),
  contextType: z.string().nullable().optional(),
  contextId: z.string().nullable().optional(),
  accountHint: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
});

const UpdateConnectionRequestSchema = z.object({
  label: z.string().min(1).max(255).optional(),
  value: z.string().optional(),
  contextType: z.string().nullable().optional(),
  contextId: z.string().nullable().optional(),
  accountHint: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
});

/** Map a service error to an HTTP status (owner gate → 403, not found → 404). */
function statusForError(msg: string): 403 | 404 | 500 {
  const lower = msg.toLowerCase();
  if (lower.includes("not found")) return 404;
  if (
    lower.includes("only pod administrators") ||
    lower.includes("pod administration") ||
    lower.includes("forbidden")
  ) {
    return 403;
  }
  return 500;
}

export function registerCapabilityConnectionsRoutes(app: HubHono): void {
  // ── GET /capabilities/:capabilityId/connections ─────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/capabilities/{capabilityId}/connections",
    tags: ["Capabilities"],
    summary: "List a capability's connections",
    description:
      "Returns metadata for the capability's connections (vault rows carrying " +
      "capability_id). NEVER returns secret values. Owner-scoped. Requires " +
      "hub-protocol.read.",
    request: { params: z.object({ capabilityId: z.string().uuid() }) },
    responses: {
      200: {
        description: "Connections",
        schema: ListConnectionsResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/capabilities/:capabilityId/connections", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const capabilityId = c.req.param("capabilityId");
    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const connections = await listConnections(capabilityId, acting.userId);
      return c.json({ connections }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const status = statusForError(msg);
      if (status === 500)
        logger.error({ err, capabilityId }, "connections list failed");
      return c.json({ error: msg }, status);
    }
  });

  // ── POST /capabilities/:capabilityId/connections ────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/capabilities/{capabilityId}/connections",
    tags: ["Capabilities"],
    summary: "Add a connection to a capability",
    description:
      "Server-encrypts and stores a new connection (secrets row) for the " +
      "capability. Promotes it to default when requested or when it is the " +
      "capability's first connection. Requires hub-protocol.write.",
    request: {
      params: z.object({ capabilityId: z.string().uuid() }),
      body: AddConnectionRequestSchema,
    },
    responses: {
      200: { description: "Created connection", schema: ConnectionSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/capabilities/:capabilityId/connections", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const capabilityId = c.req.param("capabilityId");
    const parsed = AddConnectionRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const connection = await addConnection({
        capabilityId,
        actorUserId: acting.userId,
        label: parsed.data.label,
        value: parsed.data.value,
        contextType: parsed.data.contextType,
        contextId: parsed.data.contextId,
        accountHint: parsed.data.accountHint,
        isDefault: parsed.data.isDefault,
      });
      return c.json(connection, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const status = statusForError(msg);
      if (status === 500)
        logger.error({ err, capabilityId }, "connection add failed");
      return c.json({ error: msg }, status);
    }
  });

  // ── PATCH /capabilities/:capabilityId/connections/:id ───────────────────────
  registerOpenApi(app, {
    method: "patch",
    path: "/capabilities/{capabilityId}/connections/{id}",
    tags: ["Capabilities"],
    summary: "Update a capability connection",
    description:
      "Updates connection fields; rotates (re-encrypts) when `value` is given; " +
      "enforces a single default. Requires hub-protocol.write.",
    request: {
      params: z.object({
        capabilityId: z.string().uuid(),
        id: z.string().uuid(),
      }),
      body: UpdateConnectionRequestSchema,
    },
    responses: {
      200: { description: "Updated connection", schema: ConnectionSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.patch("/capabilities/:capabilityId/connections/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const capabilityId = c.req.param("capabilityId");
    const id = c.req.param("id");
    const parsed = UpdateConnectionRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const connection = await updateConnection({
        capabilityId,
        connectionId: id,
        actorUserId: acting.userId,
        label: parsed.data.label,
        value: parsed.data.value,
        contextType: parsed.data.contextType,
        contextId: parsed.data.contextId,
        accountHint: parsed.data.accountHint,
        isDefault: parsed.data.isDefault,
      });
      return c.json(connection, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const status = statusForError(msg);
      if (status === 500)
        logger.error({ err, capabilityId, id }, "connection update failed");
      return c.json({ error: msg }, status);
    }
  });

  // ── DELETE /capabilities/:capabilityId/connections/:id ──────────────────────
  registerOpenApi(app, {
    method: "delete",
    path: "/capabilities/{capabilityId}/connections/{id}",
    tags: ["Capabilities"],
    summary: "Remove a capability connection",
    description:
      "Soft-deletes a connection; promotes the oldest remaining connection to " +
      "default when the removed one was default. Requires hub-protocol.write.",
    request: {
      params: z.object({
        capabilityId: z.string().uuid(),
        id: z.string().uuid(),
      }),
    },
    responses: {
      200: {
        description: "Removed",
        schema: z.object({
          ok: z.boolean(),
          promotedDefaultId: z.string().nullable(),
        }),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.delete("/capabilities/:capabilityId/connections/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const capabilityId = c.req.param("capabilityId");
    const id = c.req.param("id");
    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const result = await removeConnection({
        capabilityId,
        connectionId: id,
        actorUserId: acting.userId,
      });
      return c.json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const status = statusForError(msg);
      if (status === 500)
        logger.error({ err, capabilityId, id }, "connection remove failed");
      return c.json({ error: msg }, status);
    }
  });
}
