/**
 * Hub Protocol REST — skills CRUD (capability substrate)
 *
 * Headless seam so an external CLI (eve) can seed `skills` rows — the AI
 * know-how packages of the playbooks/capability substrate. Mirrors the tRPC
 * `skills.create` / `skills.list` 1:1, with the SAME governance
 * (proposal-gated via `checkPermissionOrPropose` inside the tRPC handler).
 *
 * Reuse, not duplication: routes resolve the trusted acting identity
 * (resolveActingContext) then invoke the top-level `skillsRouter` through a
 * hub-protocol caller context — the permission check, insert, audit log, and
 * side-effects all run inside the tRPC handler (same pattern hub-protocol/
 * skills.ts uses). The `requires: toolId[]` tool links reuse the SAME router's
 * `setRequiredTools` (which writes `skill → requires → tool` edges via the
 * links service) — no inline link writes here.
 *
 * NOTE: the EXISTING rest/skills.ts owns the static `/skills/system` doc
 * endpoint. These routes add the CRUD seam. Static `/skills` (no param) is
 * registered here and never collides with `/skills/system` (different path).
 *
 * Routes:
 *   POST   /skills      — create a skill (proposal-gated; optional `requires` tool links)
 *   GET    /skills      — list skills (pod + user + workspace scope)
 *   DELETE /skills/:id   — delete a skill (proposal-gated; reuses skillsRouter.delete)
 */

import { z } from "@hono/zod-openapi";

import { skillsRouter } from "../../skills.js";
import { createHubProtocolCallerContext } from "../utils.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

// ── Local OpenAPI schemas ────────────────────────────────────────────────────

const CreateSkillRequestSchema = z.object({
  name: z.string().min(1).max(255),
  /** instruction = prompt-injected know-how; code = sandbox-executed. */
  kind: z.enum(["instruction", "code"]).optional(),
  scope: z.enum(["pod", "user", "workspace"]).optional(),
  agentTypes: z.array(z.string()).optional(),
  description: z.string().optional(),
  /**
   * The skill payload. For kind='code' this is executable source; for
   * kind='instruction' it is the instruction text. `body` is accepted as an
   * alias for `code` (both map to the skills.code column).
   */
  code: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  category: z.string().optional(),
  executionMode: z.enum(["sync", "async"]).optional(),
  timeoutSeconds: z.number().min(1).max(300).optional(),
  /** Tool ids this skill requires — written as `skill → requires → tool` links. */
  requires: z.array(z.string().uuid()).optional(),
  workspaceId: z.string().uuid().optional(),
});

const CreateSkillResponseSchema = z.object({
  id: z.string(),
  status: z.enum(["created", "proposed"]),
  proposalId: z.string().nullable(),
  requires: z.array(z.string()).optional(),
});

const ListSkillsResponseSchema = z.object({
  skills: z.array(z.record(z.string(), z.unknown())),
});

const DeleteSkillResponseSchema = z.object({
  status: z.enum(["deleted", "proposed"]),
  proposalId: z.string().nullable(),
});

// ── Register function ──────────────────────────────────────────────────────

export function registerSkillsCrudRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────

  registerOpenApi(app, {
    method: "post",
    path: "/skills",
    tags: ["Skills"],
    summary: "Create a skill (capability substrate)",
    description:
      "Seeds a `skills` row — AI know-how. kind='instruction' injects into the " +
      "agent prompt; kind='code' is sandbox-executed. Proposal-gated: returns " +
      "status='proposed' with a proposalId when governance requires review. " +
      "Optional `requires` writes `skill → requires → tool` links. Requires " +
      "hub-protocol.write scope.",
    request: { body: CreateSkillRequestSchema },
    responses: {
      200: {
        description: "Created or proposed skill",
        schema: CreateSkillResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/skills",
    tags: ["Skills"],
    summary: "List skills",
    description:
      "Lists skills visible to the caller across the three-tier scope (pod ∪ " +
      "user-owned ∪ workspace). Requires hub-protocol.read scope.",
    request: {
      query: z.object({
        workspaceId: z.string().uuid().optional(),
        kind: z.enum(["instruction", "code"]).optional(),
        scope: z.enum(["pod", "user", "workspace"]).optional(),
        status: z.enum(["active", "inactive", "error", "all"]).optional(),
        limit: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Skill list", schema: ListSkillsResponseSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "delete",
    path: "/skills/{id}",
    tags: ["Skills"],
    summary: "Delete a skill (capability substrate)",
    description:
      "Deletes a `skills` row. Proposal-gated: returns status='proposed' with a " +
      "proposalId when governance requires review (AI-initiated deletes propose, " +
      "human deletes execute). Requires hub-protocol.write scope.",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: {
        description: "Deleted or proposed",
        schema: DeleteSkillResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── POST /skills ───────────────────────────────────────────────────────────
  app.post("/skills", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const parsed = CreateSkillRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const body = parsed.data;

    // `body` is an alias for `code` — the skills.code column stores both
    // executable source and instruction text (kind discriminates).
    const codeText = body.code ?? body.body;
    if (!codeText) {
      return c.json({ error: "code (or body) is required" }, 400);
    }

    try {
      const acting = await resolveActingContext(c, {
        workspaceId: body.workspaceId,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[],
        body.workspaceId ?? null
      );
      const caller = skillsRouter.createCaller(ctx as never);

      // Reuse the tRPC create — governance, insert, audit, side-effects all run
      // inside the handler. No duplicated logic.
      const result = await caller.create({
        name: body.name,
        kind: body.kind ?? "code",
        scope: body.scope ?? "pod",
        agentTypes: body.agentTypes,
        description: body.description,
        code: codeText,
        parameters: body.parameters,
        category: body.category,
        executionMode: body.executionMode ?? "sync",
        timeoutSeconds: body.timeoutSeconds ?? 30,
        workspaceId: body.workspaceId,
      });

      // Wire required-tool links only when the skill was actually created
      // (a proposed skill has no row yet to attach links to).
      if (
        result.status === "created" &&
        body.requires &&
        body.requires.length > 0
      ) {
        await caller.setRequiredTools({
          skillId: result.id,
          toolIds: body.requires,
        });
      }

      return c.json(
        {
          id: result.id,
          status: result.status,
          proposalId:
            "proposalId" in result ? (result.proposalId ?? null) : null,
          requires:
            result.status === "created" ? (body.requires ?? []) : undefined,
        },
        200
      );
    } catch (err) {
      logger.error({ err }, "skills create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /skills ─────────────────────────────────────────────────────────
  // NOTE: `/skills/system` (the static doc route in rest/skills.ts) is a
  // DIFFERENT path — no collision. Bare `/skills` is its own match.
  app.get("/skills", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const workspaceId = c.req.query("workspaceId");
    const kind = c.req.query("kind") as "instruction" | "code" | undefined;
    const scope = c.req.query("scope") as
      | "pod"
      | "user"
      | "workspace"
      | undefined;
    const status = c.req.query("status") as
      | "active"
      | "inactive"
      | "error"
      | "all"
      | undefined;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 50, 100) : 50;

    try {
      const acting = await resolveActingContext(c, { workspaceId });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[],
        workspaceId ?? null
      );
      const caller = skillsRouter.createCaller(ctx as never);
      const result = await caller.list({
        workspaceId,
        kind,
        scope,
        status,
        limit,
      });
      return c.json({ skills: result.skills }, 200);
    } catch (err) {
      logger.error({ err }, "skills list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── DELETE /skills/:id ─────────────────────────────────────────────────────
  // Thin door over the existing governed skillsRouter.delete (permission/propose
  // + audit + db.delete all run inside the tRPC handler). No new logic here.
  app.delete("/skills/:id", async (c) => {
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
      const caller = skillsRouter.createCaller(ctx as never);
      const result = await caller.delete({ id });

      return c.json(
        {
          status: result.status,
          proposalId:
            "proposalId" in result ? (result.proposalId ?? null) : null,
        },
        200
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.toLowerCase().includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      logger.error({ err, id }, "skills delete failed");
      return c.json({ error: msg }, 500);
    }
  });
}
