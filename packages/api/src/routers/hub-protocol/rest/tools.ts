/**
 * Hub Protocol REST — tools (capability substrate)
 *
 * Headless seam so an external CLI (eve) can seed `tools` rows — the agnostic
 * integration registry of the playbooks/capability substrate. Mirrors the tRPC
 * `tools.*` procedures 1:1, with the SAME governance
 * (proposal-gated via `checkPermissionOrPropose`).
 *
 * Reuse, not duplication: every route resolves the trusted acting identity
 * (resolveActingContext — closes the cross-tenant IDOR) then invokes the
 * top-level `toolsRouter` through a hub-protocol caller context. The insert,
 * the permission check, and the side-effects all run inside the tRPC handler —
 * this file is a thin HTTP door, never a second copy of the business logic.
 * (Same pattern hub-protocol/skills.ts uses with the regular skills router.)
 *
 * Routes (static before dynamic — Hono is first-match):
 *   POST   /tools                             — create a tool (proposal-gated)
 *   GET    /tools                             — list tools (pod-wide + the given workspace)
 *   GET    /tools/:id                         — get a tool + the skills that `require` it
 *   PATCH  /tools/:id                         — update a tool (proposal-gated; resets approval on exec-defining field changes)
 *   POST   /tools/:id/approve                 — approve/revoke tool execution (owner/pod-admin gated)
 *   POST   /tools/:id/auth-binding            — set a tool's dynamic auth binding (owner/pod-admin gated)
 *   GET    /tools/:id/credentials             — list bound credentials for a tool (owner-gated)
 *   POST   /tools/:id/credentials             — bind a credential to a principal/entity (owner-gated)
 *   DELETE /tools/:id/credentials/:linkId     — unbind a credential (owner-gated)
 *   DELETE /tools/:id                         — delete a tool (proposal-gated)
 */

import { z } from "@hono/zod-openapi";

import { TRPCError } from "@trpc/server";

import { toolsRouter } from "../../tools.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { getConfinedWorkspace } from "../confine-workspace.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

// ── Local OpenAPI schemas ────────────────────────────────────────────────────

const TOOL_KINDS = [
  "builtin",
  "api",
  "mcp",
  "provider",
  "external",
  "script",
] as const;
const EXECUTORS = ["is-agent", "external-agent", "hybrid"] as const;

const CreateToolRequestSchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(TOOL_KINDS),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  credentialRef: z.string().optional(),
  executor: z.enum(EXECUTORS).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Omit for pod-wide (null workspaceId). */
  workspaceId: z.string().uuid().optional(),
  agentUserId: z.string().uuid().optional(),
  source: z.string().optional(),
  reasoning: z.string().optional(),
});

const ToolWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
});

const CreateToolResponseSchema = z.object({
  tool: ToolWireSchema.nullable(),
  status: z.enum(["created", "proposed"]),
  proposalId: z.string().nullable(),
});

const ListToolsResponseSchema = z.object({
  tools: z.array(z.record(z.string(), z.unknown())),
});

const GetToolResponseSchema = z.object({
  tool: z.record(z.string(), z.unknown()),
  skills: z.array(z.record(z.string(), z.unknown())),
});

const DeleteToolResponseSchema = z.object({
  status: z.enum(["deleted", "proposed"]),
  proposalId: z.string().nullable(),
});

const ApproveToolRequestSchema = z.object({
  approved: z.boolean().default(true),
});

const ApproveToolResponseSchema = z.object({
  id: z.string(),
  approved: z.boolean(),
});

const UpdateToolResponseSchema = z.object({
  tool: ToolWireSchema.nullable(),
  status: z.enum(["updated", "proposed"]),
  proposalId: z.string().nullable(),
});

const SetAuthBindingResponseSchema = z.object({
  tool: ToolWireSchema,
});

const CredentialBindingSchema = z.object({
  linkId: z.string(),
  principalType: z.string(),
  principalId: z.string(),
  secretId: z.string(),
});

const ListCredentialsResponseSchema = z.object({
  credentials: z.array(CredentialBindingSchema),
});

const BindCredentialResponseSchema = z.object({
  linkId: z.string().nullable(),
});

const UnbindCredentialResponseSchema = z.object({
  ok: z.literal(true),
});

// ── Register function ──────────────────────────────────────────────────────

export function registerToolsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────

  registerOpenApi(app, {
    method: "post",
    path: "/tools",
    tags: ["Tools"],
    summary: "Create a tool (capability substrate)",
    description:
      "Seeds a `tools` row — the agnostic integration registry. Proposal-gated: " +
      "if the workspace governance requires review, returns status='proposed' " +
      "with a proposalId instead of creating. Requires hub-protocol.write scope.",
    request: { body: CreateToolRequestSchema },
    responses: {
      200: {
        description: "Created or proposed tool",
        schema: CreateToolResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/tools",
    tags: ["Tools"],
    summary: "List tools",
    description:
      "Lists tools visible to the caller: pod-wide (null workspaceId) plus the " +
      "given workspace. Requires hub-protocol.read scope.",
    request: {
      query: z.object({
        workspaceId: z.string().uuid().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Tool list", schema: ListToolsResponseSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/tools/{id}",
    tags: ["Tools"],
    summary: "Get a tool and the skills that require it",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: {
        description: "Tool + requiring skills",
        schema: GetToolResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/tools/{id}/approve",
    tags: ["Tools"],
    summary: "Approve or revoke a tool's execution",
    description:
      "Sets the `approved` flag on a tool — the draft→approve→run gate. " +
      "Owner-gated (workspace owner, or pod-admin for pod-wide tools) via the " +
      "governed toolsRouter.setApproved. Requires hub-protocol.write scope.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: ApproveToolRequestSchema,
    },
    responses: {
      200: {
        description: "Updated approval state",
        schema: ApproveToolResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "delete",
    path: "/tools/{id}",
    tags: ["Tools"],
    summary: "Delete a tool (capability substrate)",
    description:
      "Deletes a `tools` row. Proposal-gated: returns status='proposed' with a " +
      "proposalId when governance requires review (AI-initiated deletes propose, " +
      "human deletes execute). Requires hub-protocol.write scope.",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: {
        description: "Deleted or proposed",
        schema: DeleteToolResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── PATCH /tools/:id ──────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "patch",
    path: "/tools/{id}",
    tags: ["Tools"],
    summary: "Update a tool (capability substrate)",
    description:
      "Updates a `tools` row. Proposal-gated: returns status='proposed' with " +
      "a proposalId when governance requires review. Changing " +
      "execution-defining fields (credentialRef, config, executor, kind, " +
      "inputSchema) resets approval to false. Pod-wide tools require pod-admin. " +
      "Requires hub-protocol.write scope.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: z.object({
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        credentialRef: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        executor: z.enum(EXECUTORS).optional(),
        kind: z.enum(TOOL_KINDS).optional(),
        inputSchema: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(["active", "inactive", "error"]).optional(),
      }),
    },
    responses: {
      200: {
        description: "Updated or proposed tool",
        schema: UpdateToolResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── POST /tools/:id/auth-binding ──────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/tools/{id}/auth-binding",
    tags: ["Tools"],
    summary: "Set a tool's dynamic auth binding",
    description:
      "Sets the `authBinding` on a tool (static/per_user/per_agent/per_entity). " +
      "Owner-gated: workspace owner, or pod-admin for pod-wide tools. " +
      "Changing the binding resets approval. Requires hub-protocol.write scope.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: z.object({
        authBinding: z.enum(["static", "per_user", "per_agent", "per_entity"]),
      }),
    },
    responses: {
      200: {
        description: "Updated auth binding",
        schema: SetAuthBindingResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── GET /tools/:id/credentials ───────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/tools/{id}/credentials",
    tags: ["Tools"],
    summary: "List bound credentials for a tool",
    description:
      "Lists the connections (vault secrets) scoped to this tool's capability. " +
      "Owner-gated. Requires hub-protocol.read scope.",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: {
        description: "Bound credential list",
        schema: ListCredentialsResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── POST /tools/:id/credentials ──────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/tools/{id}/credentials",
    tags: ["Tools"],
    summary: "Bind a credential to a principal/entity for a tool",
    description:
      "Binds a vault secret to a principal (participant or entity) for this " +
      "tool's capability, stamping the secret's connection context. Owner-gated. " +
      "The secret must exist and belong to the acting user. Requires hub-protocol.write scope.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: z.object({
        principalType: z.enum(["participant", "entity"]),
        principalId: z.string().min(1),
        secretId: z.string().uuid(),
      }),
    },
    responses: {
      200: {
        description: "Bound credential link",
        schema: BindCredentialResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── DELETE /tools/:id/credentials/:linkId ────────────────────────────────
  registerOpenApi(app, {
    method: "delete",
    path: "/tools/{id}/credentials/{linkId}",
    tags: ["Tools"],
    summary: "Unbind a credential from a tool",
    description:
      "Clears a secret's connection context (the `linkId` path param is the " +
      "secret id). Gated on secret ownership. Requires hub-protocol.write scope.",
    request: {
      params: z.object({
        id: z.string().uuid(),
        linkId: z.string().uuid(),
      }),
    },
    responses: {
      200: {
        description: "Credential unbound",
        schema: UnbindCredentialResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── POST /tools ────────────────────────────────────────────────────────────
  app.post("/tools", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const parsed = CreateToolRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const body = parsed.data;

    // Service-key workspace confinement (Item 3): pin/clamp the requested
    // workspace at the point of read, before it flows to resolveActingContext,
    // the caller ctx, OR the re-supplied `tools.create` input (input wins).
    let workspaceId: string | null | undefined;
    try {
      workspaceId = getConfinedWorkspace(c, body.workspaceId);
    } catch (err) {
      if (err instanceof TRPCError && err.code === "FORBIDDEN")
        return c.json({ error: err.message }, 403);
      throw err;
    }

    try {
      // Trusted acting identity + workspace (closes the cross-tenant IDOR).
      // workspaceId may be omitted for pod-wide tools; only membership-check
      // when one is supplied (resolveActingContext otherwise picks the caller's
      // first workspace, which would wrongly scope a pod-wide tool).
      const acting = await resolveActingContext(c, {
        workspaceId: workspaceId ?? undefined,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[],
        workspaceId ?? null
      );
      const caller = toolsRouter.createCaller(ctx as never);

      // Reuse the tRPC create — governance (checkPermissionOrPropose), insert,
      // and side-effects all run inside the handler. No duplicated logic.
      const result = await caller.create({
        name: body.name,
        kind: body.kind,
        description: body.description,
        inputSchema: body.inputSchema,
        credentialRef: body.credentialRef,
        executor: body.executor ?? "is-agent",
        config: body.config,
        workspaceId: workspaceId ?? undefined,
        agentUserId:
          body.agentUserId ?? (c.get("agentUserId") as string | undefined),
        source: body.source,
        reasoning: body.reasoning,
      });

      return c.json(result, 200);
    } catch (err) {
      logger.error({ err }, "tools create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /tools ───────────────────────────────────────────────────────────
  app.get("/tools", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const workspaceId = c.req.query("workspaceId");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 100, 200) : 100;

    try {
      const acting = await resolveActingContext(c, { workspaceId });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[],
        workspaceId ?? null
      );
      const caller = toolsRouter.createCaller(ctx as never);
      const tools = await caller.list({ workspaceId, limit });
      return c.json({ tools }, 200);
    } catch (err) {
      logger.error({ err }, "tools list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /tools/:id ─────────────────────────────────────────────────────────
  app.get("/tools/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const id = c.req.param("id");
    const idCheck = z.string().uuid().safeParse(id);
    if (!idCheck.success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }
    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[]
      );
      const caller = toolsRouter.createCaller(ctx as never);
      const result = await caller.get({ id });
      return c.json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.toLowerCase().includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      logger.error({ err, id }, "tools get failed");
      return c.json({ error: msg }, 500);
    }
  });

  // ── POST /tools/:id/approve ────────────────────────────────────────────────
  // Thin door over the governed toolsRouter.setApproved (owner / pod-admin gate
  // runs inside the tRPC handler). Different method+path from /tools/:id — no
  // collision with GET/DELETE.
  app.post("/tools/:id/approve", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const id = c.req.param("id");
    const idCheck = z.string().uuid().safeParse(id);
    if (!idCheck.success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }

    const parsed = ApproveToolRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const approved = parsed.data.approved;

    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[]
      );
      const caller = toolsRouter.createCaller(ctx as never);
      // Reuse the governed setApproved — owner/pod-admin gate runs inside.
      await caller.setApproved({ id, approved });

      return c.json({ id, approved }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.toLowerCase().includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      logger.error({ err, id }, "tools approve failed");
      return c.json({ error: msg }, 500);
    }
  });

  // ── DELETE /tools/:id ──────────────────────────────────────────────────────
  // Thin door over the governed toolsRouter.delete (write-gate on the loaded
  // row's workspaceId + checkPermissionOrPropose + audit all run inside).
  app.delete("/tools/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const id = c.req.param("id");
    const idCheck = z.string().uuid().safeParse(id);
    if (!idCheck.success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }

    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[]
      );
      const caller = toolsRouter.createCaller(ctx as never);
      const result = await caller.delete({ id });

      return c.json(
        { status: result.status, proposalId: result.proposalId ?? null },
        200
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.toLowerCase().includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      logger.error({ err, id }, "tools delete failed");
      return c.json({ error: msg }, 500);
    }
  });

  // ── PATCH /tools/:id ────────────────────────────────────────────────────────
  app.patch("/tools/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const id = c.req.param("id");
    const idCheck = z.string().uuid().safeParse(id);
    if (!idCheck.success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }

    const parsed = z
      .object({
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        credentialRef: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        executor: z.enum(EXECUTORS).optional(),
        kind: z.enum(TOOL_KINDS).optional(),
        inputSchema: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(["active", "inactive", "error"]).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const body = parsed.data;

    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[]
      );
      const caller = toolsRouter.createCaller(ctx as never);
      const result = await caller.update({
        id,
        name: body.name,
        description: body.description,
        credentialRef: body.credentialRef,
        config: body.config,
        metadata: body.metadata,
        executor: body.executor,
        kind: body.kind,
        inputSchema: body.inputSchema,
        status: body.status,
      });

      return c.json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.toLowerCase().includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      if (
        msg.toLowerCase().includes("pod admin") ||
        msg.toLowerCase().includes("forbidden")
      ) {
        return c.json({ error: msg }, 403);
      }
      logger.error({ err, id }, "tools update failed");
      return c.json({ error: msg }, 500);
    }
  });

  // ── POST /tools/:id/auth-binding ────────────────────────────────────────────
  app.post("/tools/:id/auth-binding", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const id = c.req.param("id");
    const idCheck = z.string().uuid().safeParse(id);
    if (!idCheck.success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }

    const parsed = z
      .object({
        authBinding: z.enum(["static", "per_user", "per_agent", "per_entity"]),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const { authBinding } = parsed.data;

    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[]
      );
      const caller = toolsRouter.createCaller(ctx as never);
      const result = await caller.setAuthBinding({ id, authBinding });

      return c.json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.toLowerCase().includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      if (
        msg.toLowerCase().includes("owner") ||
        msg.toLowerCase().includes("pod admin") ||
        msg.toLowerCase().includes("forbidden")
      ) {
        return c.json({ error: msg }, 403);
      }
      logger.error({ err, id }, "tools setAuthBinding failed");
      return c.json({ error: msg }, 500);
    }
  });

  // ── GET /tools/:id/credentials ──────────────────────────────────────────────
  app.get("/tools/:id/credentials", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const id = c.req.param("id");
    const idCheck = z.string().uuid().safeParse(id);
    if (!idCheck.success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }

    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[]
      );
      const caller = toolsRouter.createCaller(ctx as never);
      const result = await caller.listBoundCredentials({ toolId: id });

      return c.json({ credentials: result }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.toLowerCase().includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      if (
        msg.toLowerCase().includes("owner") ||
        msg.toLowerCase().includes("pod admin")
      ) {
        return c.json({ error: msg }, 403);
      }
      logger.error({ err, id }, "tools listBoundCredentials failed");
      return c.json({ error: msg }, 500);
    }
  });

  // ── POST /tools/:id/credentials ─────────────────────────────────────────────
  app.post("/tools/:id/credentials", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const id = c.req.param("id");
    const idCheck = z.string().uuid().safeParse(id);
    if (!idCheck.success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }

    const parsed = z
      .object({
        principalType: z.enum(["participant", "entity"]),
        principalId: z.string().min(1),
        secretId: z.string().uuid(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const { principalType, principalId, secretId } = parsed.data;

    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[]
      );
      const caller = toolsRouter.createCaller(ctx as never);
      const result = await caller.bindCredential({
        toolId: id,
        principalType,
        principalId,
        secretId,
      });

      return c.json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.toLowerCase().includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      if (
        msg.toLowerCase().includes("forbidden") ||
        msg.toLowerCase().includes("owner") ||
        msg.toLowerCase().includes("pod admin")
      ) {
        return c.json({ error: msg }, 403);
      }
      logger.error({ err, id }, "tools bindCredential failed");
      return c.json({ error: msg }, 500);
    }
  });

  // ── DELETE /tools/:id/credentials/:linkId ───────────────────────────────────
  app.delete("/tools/:id/credentials/:linkId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const linkId = c.req.param("linkId");
    const linkIdCheck = z.string().uuid().safeParse(linkId);
    if (!linkIdCheck.success) {
      return c.json({ error: "linkId must be a UUID" }, 400);
    }

    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[]
      );
      const caller = toolsRouter.createCaller(ctx as never);
      const result = await caller.unbindCredential({ linkId });

      return c.json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.toLowerCase().includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      if (
        msg.toLowerCase().includes("owner") ||
        msg.toLowerCase().includes("pod admin") ||
        msg.toLowerCase().includes("forbidden")
      ) {
        return c.json({ error: msg }, 403);
      }
      logger.error({ err, linkId }, "tools unbindCredential failed");
      return c.json({ error: msg }, 500);
    }
  });
}
