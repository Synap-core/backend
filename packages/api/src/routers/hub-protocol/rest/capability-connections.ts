/**
 * Hub Protocol REST — capability credentials CRUD (Wave 4).
 *
 * Thin governed door over `services/capabilities/capability-connections.ts` (the
 * single writer). A credential is a `secrets` row carrying `capability_id` — the
 * vault IS the credential registry (plan §3.2). No route ever returns a secret
 * value; the service is owner-gated.
 *
 *   GET    /capabilities/:capabilityId/credentials        (read)
 *   POST   /capabilities/:capabilityId/credentials        (write)
 *   PATCH  /capabilities/:capabilityId/credentials/:id     (write)
 *   DELETE /capabilities/:capabilityId/credentials/:id     (write)
 */

import { z } from "zod";

import {
  addCredential,
  listCredentials,
  removeCredential,
  updateCredential,
} from "../../../services/capabilities/capability-connections.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
  readJsonBody,
  requireUuidParam,
} from "./_shared.js";

// ── OpenAPI schemas ────────────────────────────────────────────────────────────

const CredentialSchema = z.object({
  id: z.string(),
  label: z.string(),
  contextType: z.string().nullable(),
  contextId: z.string().nullable(),
  isDefault: z.boolean(),
  accountHint: z.string().nullable(),
  kind: z.enum(["nango", "vault"]),
  isPodWide: z.boolean(),
  // Merged live-truth fields (capability-connections.listCredentials): the Nango
  // provider key, connection health, and whether the row is a real secrets row or
  // a synthetic live-Nango connection with no registry row yet.
  provider: z.string().nullable(),
  health: z.enum(["connected", "needs_reauth"]),
  persisted: z.boolean(),
});

const ListCredentialsResponseSchema = z.object({
  credentials: z.array(CredentialSchema),
});

const AddCredentialRequestSchema = z.object({
  label: z.string().min(1).max(255),
  value: z.string().optional(),
  contextType: z.string().nullable().optional(),
  contextId: z.string().nullable().optional(),
  accountHint: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  isPodWide: z.boolean().optional(),
});

const UpdateCredentialRequestSchema = z.object({
  label: z.string().min(1).max(255).optional(),
  value: z.string().optional(),
  contextType: z.string().nullable().optional(),
  contextId: z.string().nullable().optional(),
  accountHint: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  isPodWide: z.boolean().optional(),
});

/** Map a service error to an HTTP status (owner gate → 403, not found → 404). */
function statusForError(msg: string): 400 | 403 | 404 | 500 {
  const lower = msg.toLowerCase();
  if (lower.includes("not found")) return 404;
  if (
    lower.includes("only pod administrators") ||
    lower.includes("pod administration") ||
    lower.includes("forbidden")
  ) {
    return 403;
  }
  // Vault-only validation (a Nango/account credential can't be pod-wide).
  if (lower.includes("must be a vault key")) return 400;
  return 500;
}

export function registerCapabilityCredentialsRoutes(app: HubHono): void {
  // ── GET /capabilities/:capabilityId/credentials ─────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/capabilities/{capabilityId}/credentials",
    tags: ["Capabilities"],
    summary: "List a capability's credentials",
    description:
      "Returns metadata for the capability's credentials (vault rows carrying " +
      "capability_id). NEVER returns secret values. Owner-scoped. Requires " +
      "hub-protocol.read.",
    request: { params: z.object({ capabilityId: z.string().uuid() }) },
    responses: {
      200: {
        description: "Credentials",
        schema: ListCredentialsResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/capabilities/:capabilityId/credentials", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const capabilityId = requireUuidParam(c, "capabilityId");
    if (capabilityId instanceof Response) return capabilityId;
    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const credentials = await listCredentials(capabilityId, acting.userId);
      return c.json({ credentials }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const status = statusForError(msg);
      if (status === 500)
        logger.error({ err, capabilityId }, "credentials list failed");
      return c.json({ error: msg }, status);
    }
  });

  // ── POST /capabilities/:capabilityId/credentials ────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/capabilities/{capabilityId}/credentials",
    tags: ["Capabilities"],
    summary: "Add a credential to a capability",
    description:
      "Server-encrypts and stores a new credential (secrets row) for the " +
      "capability. Promotes it to default when requested or when it is the " +
      "capability's first credential. Requires hub-protocol.write.",
    request: {
      params: z.object({ capabilityId: z.string().uuid() }),
      body: AddCredentialRequestSchema,
    },
    responses: {
      200: { description: "Created credential", schema: CredentialSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/capabilities/:capabilityId/credentials", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const capabilityId = requireUuidParam(c, "capabilityId");
    if (capabilityId instanceof Response) return capabilityId;
    const jsonRead = await readJsonBody(c);
    if (!jsonRead.ok) return jsonRead.res;
    const parsed = AddCredentialRequestSchema.safeParse(jsonRead.body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const credential = await addCredential({
        capabilityId,
        actorUserId: acting.userId,
        label: parsed.data.label,
        value: parsed.data.value,
        contextType: parsed.data.contextType,
        contextId: parsed.data.contextId,
        accountHint: parsed.data.accountHint,
        isDefault: parsed.data.isDefault,
        isPodWide: parsed.data.isPodWide,
      });
      return c.json(credential, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const status = statusForError(msg);
      if (status === 500)
        logger.error({ err, capabilityId }, "credential add failed");
      return c.json({ error: msg }, status);
    }
  });

  // ── PATCH /capabilities/:capabilityId/credentials/:id ───────────────────────
  registerOpenApi(app, {
    method: "patch",
    path: "/capabilities/{capabilityId}/credentials/{id}",
    tags: ["Capabilities"],
    summary: "Update a capability credential",
    description:
      "Updates credential fields; rotates (re-encrypts) when `value` is given; " +
      "enforces a single default. Requires hub-protocol.write.",
    request: {
      params: z.object({
        capabilityId: z.string().uuid(),
        id: z.string().uuid(),
      }),
      body: UpdateCredentialRequestSchema,
    },
    responses: {
      200: { description: "Updated credential", schema: CredentialSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.patch("/capabilities/:capabilityId/credentials/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const capabilityId = requireUuidParam(c, "capabilityId");
    if (capabilityId instanceof Response) return capabilityId;
    const id = requireUuidParam(c, "id");
    if (id instanceof Response) return id;
    const jsonRead = await readJsonBody(c);
    if (!jsonRead.ok) return jsonRead.res;
    const parsed = UpdateCredentialRequestSchema.safeParse(jsonRead.body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const credential = await updateCredential({
        capabilityId,
        credentialId: id,
        actorUserId: acting.userId,
        label: parsed.data.label,
        value: parsed.data.value,
        contextType: parsed.data.contextType,
        contextId: parsed.data.contextId,
        accountHint: parsed.data.accountHint,
        isDefault: parsed.data.isDefault,
        isPodWide: parsed.data.isPodWide,
      });
      return c.json(credential, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const status = statusForError(msg);
      if (status === 500)
        logger.error({ err, capabilityId, id }, "credential update failed");
      return c.json({ error: msg }, status);
    }
  });

  // ── DELETE /capabilities/:capabilityId/credentials/:id ──────────────────────
  registerOpenApi(app, {
    method: "delete",
    path: "/capabilities/{capabilityId}/credentials/{id}",
    tags: ["Capabilities"],
    summary: "Remove a capability credential",
    description:
      "Soft-deletes a credential; promotes the oldest remaining credential to " +
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

  app.delete("/capabilities/:capabilityId/credentials/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const capabilityId = requireUuidParam(c, "capabilityId");
    if (capabilityId instanceof Response) return capabilityId;
    const id = requireUuidParam(c, "id");
    if (id instanceof Response) return id;
    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const result = await removeCredential({
        capabilityId,
        credentialId: id,
        actorUserId: acting.userId,
      });
      return c.json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      const status = statusForError(msg);
      if (status === 500)
        logger.error({ err, capabilityId, id }, "credential remove failed");
      return c.json({ error: msg }, status);
    }
  });
}
