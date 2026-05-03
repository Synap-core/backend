/**
 * Hub Protocol REST — skills
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  CreateSkillRequestSchema,
  GetSkillQuerySchema,
  GetSkillsQuerySchema,
  WireSkillSchema,
} from "./_codecs/skill.js";
import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";

export function registerSkillsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/skills/getSkills",
    tags: ["Skills"],
    summary: "List available agent skills",
    request: {
      query: GetSkillsQuerySchema,
    },
    responses: {
      200: { description: "Skills", schema: z.array(WireSkillSchema) },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/skills/getSkill",
    tags: ["Skills"],
    summary: "Get a single skill",
    request: {
      query: GetSkillQuerySchema,
    },
    responses: {
      200: { description: "Skill", schema: WireSkillSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/skills/createSkill",
    tags: ["Skills"],
    summary: "Create a custom skill",
    request: {
      body: CreateSkillRequestSchema,
    },
    responses: {
      200: { description: "Created skill", schema: WireSkillSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /skills/getSkills?userId=...&workspaceId=...&status=...
   */
  app.get("/skills/getSkills", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const userId = c.req.query("userId") || (c.get("userId") as string);
    const workspaceId = c.req.query("workspaceId");
    const status = c.req.query("status");
    try {
      const caller = await getCaller(c);
      const result = await caller.skills.getSkills({
        userId,
        workspaceId: workspaceId || undefined,
        status: (status as "active" | "inactive" | "error" | "all") || "all",
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "getSkills failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /skills/getSkill?userId=...&skillId=...
   */
  app.get("/skills/getSkill", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const userId = c.req.query("userId") || (c.get("userId") as string);
    const skillId = c.req.query("skillId");
    if (!skillId) {
      return c.json({ error: "skillId is required" }, 400);
    }
    try {
      const caller = await getCaller(c);
      const result = await caller.skills.getSkill({ userId, skillId });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "getSkill failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /skills/createSkill
   */
  app.post("/skills/createSkill", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const body = await c.req.json<{
      userId: string;
      name: string;
      description?: string;
      code: string;
      parameters?: Record<string, unknown>;
      category?: "action" | "context" | "utility" | "custom";
      workspaceId?: string;
    }>();
    try {
      const caller = await getCaller(c);
      const result = await caller.skills.createSkill(body);
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "createSkill failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
