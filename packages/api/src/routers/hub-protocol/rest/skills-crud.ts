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
 *   POST   /skills            — create a skill (proposal-gated; optional `requires` tool links)
 *   GET    /skills            — list skills (pod + user + workspace scope)
 *   POST   /skills/:id/approve — approve/revoke skill execution (owner/pod-admin gated; reuses skillsRouter.setApproved)
 *   POST   /skills/:id/dry-run — preview a skill (proxies to the IS dry-run route — external writes stubbed, reads real)
 *   DELETE /skills/:id         — delete a skill (proposal-gated; reuses skillsRouter.delete)
 */

import { z } from "@hono/zod-openapi";

import { skillsRouter } from "../../skills.js";
import { resolveIntelligenceService } from "../../../utils/intelligence-routing.js";
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

const ApproveSkillRequestSchema = z.object({
  approved: z.boolean().default(true),
});

const ApproveSkillResponseSchema = z.object({
  id: z.string(),
  approved: z.boolean(),
});

const DryRunSkillRequestSchema = z.object({
  /** Parameters to feed the skill for this preview run. */
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const DryRunSkillResponseSchema = z.object({
  /** The skill's execution result (verbatim from the IS dry-run handler). */
  result: z.unknown(),
  /** The side effects the skill INTENDED to perform (external writes stubbed). */
  dryRunEffects: z.array(z.unknown()),
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
    method: "post",
    path: "/skills/{id}/approve",
    tags: ["Skills"],
    summary: "Approve or revoke a skill's execution",
    description:
      "Sets the `approved` flag on a skill — the draft→approve→run gate. " +
      "Owner-gated (workspace owner, or pod-admin for pod-wide skills) via the " +
      "governed skillsRouter.setApproved. Requires hub-protocol.write scope.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: ApproveSkillRequestSchema,
    },
    responses: {
      200: {
        description: "Updated approval state",
        schema: ApproveSkillResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/skills/{id}/dry-run",
    tags: ["Skills"],
    summary: "Dry-run (preview) a skill to any level",
    description:
      "Executes a skill with external writes/sends STUBBED and reads kept real, " +
      "returning the side effects it intended to perform — a safe preview before " +
      "approval. Proxies to the Intelligence Service dry-run executor (it owns the " +
      "sandbox); the acting identity is server-derived. Requires hub-protocol.write " +
      "scope.",
    request: {
      params: z.object({ id: z.string().uuid() }),
      body: DryRunSkillRequestSchema,
    },
    responses: {
      200: {
        description: "Dry-run result + intended side effects",
        schema: DryRunSkillResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
      503: {
        description: "Intelligence Service unavailable",
        schema: ErrorSchema,
      },
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

  // ── POST /skills/:id/approve ───────────────────────────────────────────────
  // Thin door over the governed skillsRouter.setApproved (owner / pod-admin gate
  // + audit run inside the tRPC handler). Different method+path from /skills/:id
  // and never collides with the static /skills/system doc route.
  app.post("/skills/:id/approve", async (c) => {
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

    const parsed = ApproveSkillRequestSchema.safeParse(
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
      const caller = skillsRouter.createCaller(ctx as never);
      // Reuse the governed setApproved — owner/pod-admin gate runs inside.
      await caller.setApproved({ id, approved });

      return c.json({ id, approved }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.toLowerCase().includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      logger.error({ err, id }, "skills approve failed");
      return c.json({ error: msg }, 500);
    }
  });

  // ── POST /skills/:id/dry-run ───────────────────────────────────────────────
  // Headless door for the "preview a skill to any level" dry-run. The sandbox
  // executor lives on the Intelligence Service, so this PROXIES to the IS
  // dry-run route — mirroring external-dispatch's mcpHandler exactly
  // (resolveIntelligenceService → fetch(`${endpoint}/api/...`, X-API-Key)). The
  // IS handler reads `{ userId, parameters }`; we pass the SERVER-DERIVED acting
  // userId (never a body-supplied one) and forward parameters verbatim. Different
  // method+suffix from /skills/:id/approve (POST) and /skills/:id (DELETE) — no
  // route collision.
  app.post("/skills/:id/dry-run", async (c) => {
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

    const parsed = DryRunSkillRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const parameters = parsed.data.parameters;

    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      // Resolve the IS endpoint + service key (same util external-dispatch uses).
      let endpoint: string;
      let serviceApiKey: string;
      try {
        const resolved = await resolveIntelligenceService({
          userId: acting.userId,
          workspaceId: acting.workspaceId ?? undefined,
        });
        endpoint = resolved.endpoint;
        serviceApiKey = resolved.serviceApiKey;
      } catch (err) {
        return c.json(
          {
            error: `Intelligence Service unavailable for skill dry-run: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          503
        );
      }

      // Forward to the IS dry-run route (mounted at /api → /api/skills/:id/dry-run).
      // The IS handler reads `{ userId, parameters }` and returns { result, dryRunEffects }.
      let res: Response;
      try {
        res = await fetch(`${endpoint}/api/skills/${id}/dry-run`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": serviceApiKey,
          },
          body: JSON.stringify({
            userId: acting.userId,
            parameters: parameters ?? {},
          }),
        });
      } catch (err) {
        return c.json(
          {
            error: `Skill dry-run call to the Intelligence Service failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          503
        );
      }

      // A 404 from the IS means the dry-run route is absent on this IS version
      // (or the skill itself wasn't found) — surface it as a clear message.
      if (res.status === 404) {
        return c.json(
          {
            error:
              `Intelligence Service returned 404 for skill dry-run "${id}" — ` +
              "the skill was not found, or the IS version does not expose the dry-run route.",
          },
          404
        );
      }

      const data = (await res.json().catch(() => null)) as {
        result?: unknown;
        dryRunEffects?: unknown[];
        error?: string;
      } | null;

      if (!res.ok) {
        return c.json(
          {
            error:
              data?.error ??
              `Intelligence Service dry-run failed (${res.status})`,
          },
          res.status >= 400 && res.status <= 599 ? (res.status as never) : 500
        );
      }

      // Return the IS response verbatim ({ result, dryRunEffects }).
      return c.json(
        {
          result: data?.result ?? null,
          dryRunEffects: data?.dryRunEffects ?? [],
        },
        200
      );
    } catch (err) {
      logger.error({ err, id }, "skills dry-run failed");
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
