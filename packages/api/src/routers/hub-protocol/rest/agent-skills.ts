/**
 * Hub Protocol REST — agent skills (knowledge base)
 *
 * Skills are structured knowledge packages stored as real tables (not entities),
 * shared pod-wide across all agents. Routes use direct Drizzle — simple CRUD
 * on the agent_skills table.
 *
 * Routes (static before dynamic — Hono is first-match):
 *   GET    /agent-skills                    — list all skills
 *   GET    /agent-skills/search             — search by topics/query
 *   GET    /agent-skills/:id                — get a single skill by id
 *   GET    /agent-skills/by-slug/:slug      — get a skill by slug
 *   POST   /agent-skills                    — create a skill
 *   PATCH  /agent-skills/:slug              — update a skill by slug
 *   DELETE /agent-skills/:id                — delete a skill by id
 */

import { z } from "@hono/zod-openapi";
import { db, eq, and, agentSkills } from "@synap/database";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

// ── Wire schemas ───────────────────────────────────────────────────────────

const AgentSkillWireSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  topics: z.array(z.string()),
  body: z.string(),
  source: z.string().nullable(),
  author: z.string().nullable(),
  version: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateAgentSkillBodySchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  topics: z.array(z.string()).optional(),
  body: z.string().min(1),
  source: z.string().optional(),
  author: z.string().optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const UpdateAgentSkillBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  topics: z.array(z.string()).optional(),
  body: z.string().min(1).optional(),
  source: z.string().optional(),
  author: z.string().optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const AgentSkillsListSchema = z.object({
  skills: z.array(AgentSkillWireSchema),
  total: z.number(),
});

// ── Helpers ────────────────────────────────────────────────────────────────

function wireSkill(
  row: typeof agentSkills.$inferSelect
): z.infer<typeof AgentSkillWireSchema> {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    topics: row.topics ?? [],
    body: row.body,
    source: row.source,
    author: row.author,
    version: row.version,
    tags: row.tags ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Register function ──────────────────────────────────────────────────────

export function registerAgentSkillsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────

  registerOpenApi(app, {
    method: "get",
    path: "/agent-skills/list",
    tags: ["Agent Skills"],
    summary: "List all agent skills",
    request: {
      query: z.object({
        topic: z.string().optional(),
        q: z.string().optional(),
        tag: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    },
    responses: {
      200: { description: "Skills", schema: AgentSkillsListSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/agent-skills/get",
    tags: ["Agent Skills"],
    summary: "Get a single agent skill by slug",
    request: {
      query: z.object({ slug: z.string().min(1) }),
    },
    responses: {
      200: { description: "Skill", schema: AgentSkillWireSchema },
      404: { description: "Not found", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/agent-skills/create",
    tags: ["Agent Skills"],
    summary: "Create a agent skill",
    request: {
      body: CreateAgentSkillBodySchema,
    },
    responses: {
      200: { description: "Created skill", schema: AgentSkillWireSchema },
      409: { description: "Slug conflict", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/agent-skills/update",
    tags: ["Agent Skills"],
    summary: "Update a agent skill by slug",
    request: {
      query: z.object({ slug: z.string().min(1) }),
      body: UpdateAgentSkillBodySchema,
    },
    responses: {
      200: { description: "Updated skill", schema: AgentSkillWireSchema },
      404: { description: "Not found", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "delete",
    path: "/agent-skills/delete",
    tags: ["Agent Skills"],
    summary: "Delete a agent skill by id",
    request: {
      query: z.object({ id: z.string().uuid() }),
    },
    responses: {
      200: { description: "Deleted" },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  /**
   * GET /agent-skills — list skills with optional topic/query/tag filtering
   */
  app.get("/agent-skills", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const topic = c.req.query("topic");
    const q = c.req.query("q");
    const tag = c.req.query("tag");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);

    try {
      const conditions: SQL[] = [];

      if (topic) {
        conditions.push(
          drizzleSql`${agentSkills.topics} @> ARRAY[${topic}]::text[]`
        );
      }

      if (tag) {
        conditions.push(
          drizzleSql`${agentSkills.tags} @> ARRAY[${tag}]::text[]`
        );
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select()
        .from(agentSkills)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(agentSkills.name);

      if (q) {
        // Post-filter by string matching on name/description/topics
        const lowered = q.toLowerCase();
        const filtered = rows.filter(
          (r) =>
            r.name.toLowerCase().includes(lowered) ||
            (r.description ?? "").toLowerCase().includes(lowered) ||
            (r.topics ?? []).some((t) => t.toLowerCase().includes(lowered))
        );
        return c.json(
          {
            skills: filtered.map(wireSkill),
            total: filtered.length,
          },
          200
        );
      }

      return c.json(
        {
          skills: rows.map(wireSkill),
          total: rows.length,
        },
        200
      );
    } catch (err) {
      logger.error({ err }, "list agent skills failed");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  /**
   * GET /agent-skills/by-slug/:slug — get skill by unique slug
   */
  app.get("/agent-skills/by-slug/:slug", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const slug = c.req.param("slug");
    try {
      const [row] = await db
        .select()
        .from(agentSkills)
        .where(eq(agentSkills.slug, slug))
        .limit(1);
      if (!row) {
        return c.json({ error: "Skill not found" }, 404);
      }
      return c.json(wireSkill(row), 200);
    } catch (err) {
      logger.error({ err }, "get agent skill by slug failed");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  /**
   * GET /agent-skills/:id — get skill by UUID
   */
  app.get("/agent-skills/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const id = c.req.param("id");
    try {
      const [row] = await db
        .select()
        .from(agentSkills)
        .where(eq(agentSkills.id, id))
        .limit(1);
      if (!row) {
        return c.json({ error: "Skill not found" }, 404);
      }
      return c.json(wireSkill(row), 200);
    } catch (err) {
      logger.error({ err }, "get agent skill by id failed");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  /**
   * POST /agent-skills — create a skill
   */
  app.post("/agent-skills", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const body = await c.req.json<z.infer<typeof CreateAgentSkillBodySchema>>();

    const parsed = CreateAgentSkillBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    try {
      // Check slug uniqueness
      const [existing] = await db
        .select({ id: agentSkills.id })
        .from(agentSkills)
        .where(eq(agentSkills.slug, parsed.data.slug))
        .limit(1);
      if (existing) {
        return c.json({ error: "Skill with this slug already exists" }, 409);
      }

      const [row] = await db
        .insert(agentSkills)
        .values({
          slug: parsed.data.slug,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          topics: parsed.data.topics ?? [],
          body: parsed.data.body,
          source: parsed.data.source ?? null,
          author: parsed.data.author ?? null,
          version: parsed.data.version ?? null,
          tags: parsed.data.tags ?? [],
        })
        .returning();

      return c.json(wireSkill(row), 200);
    } catch (err) {
      logger.error({ err }, "create agent skill failed");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  /**
   * PATCH /agent-skills/:slug — update a skill by slug
   */
  app.patch("/agent-skills/:slug", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const slug = c.req.param("slug");
    const body = await c.req.json<z.infer<typeof UpdateAgentSkillBodySchema>>();

    const parsed = UpdateAgentSkillBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    try {
      const [row] = await db
        .update(agentSkills)
        .set({
          ...parsed.data,
          updatedAt: new Date(),
        })
        .where(eq(agentSkills.slug, slug))
        .returning();

      if (!row) {
        return c.json({ error: "Skill not found" }, 404);
      }

      return c.json(wireSkill(row), 200);
    } catch (err) {
      logger.error({ err }, "update agent skill failed");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  /**
   * DELETE /agent-skills/:id — delete a skill by UUID
   */
  app.delete("/agent-skills/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const id = c.req.param("id");
    try {
      await db.delete(agentSkills).where(eq(agentSkills.id, id));
      return c.json({ success: true }, 200);
    } catch (err) {
      logger.error({ err }, "delete agent skill failed");
      return c.json({ error: "Internal error" }, 500);
    }
  });
}
