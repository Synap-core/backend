/**
 * Hub Protocol REST — agent skills (knowledge base)
 *
 * Skills are structured knowledge packages stored in the unified `skills` table
 * (formerly split across `agent_skills` + `skills` — merged in migration 0133).
 *
 *   - doc-style skills → kind='instruction', body populated
 *   - executable skills → kind='code', code populated
 *   - Both share the same table, differentiated by `kind`.
 *
 * Routes (static before dynamic — Hono is first-match):
 *   GET    /agent-skills/executable         — list executable skills (kind='code')
 *   GET    /agent-skills/executable/:id      — get one executable skill by id
 *   POST   /agent-skills/executable         — create an executable skill
 *   GET    /agent-skills                    — list doc-style skills
 *   GET    /agent-skills/search             — search by topics/query
 *   GET    /agent-skills/:id                — get a single skill by id
 *   GET    /agent-skills/by-slug/:slug      — get a skill by slug
 *   POST   /agent-skills                    — create a skill
 *   PATCH  /agent-skills/:slug              — update a skill by slug
 *   DELETE /agent-skills/:id                — delete a skill by id
 */

import { z } from "@hono/zod-openapi";
import { db, eq, and, skills } from "@synap/database";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  CreateSkillRequestSchema,
  GetSkillsQuerySchema,
  WireSkillSchema,
} from "./_codecs/skill.js";
import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";
import { insertSkillGoverned } from "../../skills.js";

// ── Wire schemas ───────────────────────────────────────────────────────────

const AgentSkillWireSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  topics: z.array(z.string()),
  body: z.string().nullable(),
  source: z.string().nullable(),
  author: z.string().nullable(),
  version: z.string().nullable(),
  tags: z.array(z.string()),
  /** AI Teaching Substrate (Wave 1b/3): tool/verb names this skill teaches. */
  teachesTools: z.array(z.string()),
  skillGroup: z.string().nullable(),
  alwaysOn: z.boolean(),
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
  row: typeof skills.$inferSelect
): z.infer<typeof AgentSkillWireSchema> {
  return {
    id: row.id,
    slug: row.slug ?? "",
    name: row.name,
    description: row.description,
    topics: row.topics ?? [],
    body: row.body ?? "",
    source: row.source,
    author: row.author,
    version: row.version,
    tags: row.tags ?? [],
    teachesTools: row.teachesTools ?? [],
    skillGroup: row.skillGroup,
    alwaysOn: row.alwaysOn,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt),
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
        system: z.string().optional().openapi({
          description: "'true' to list only seeded system/* instruction skills",
        }),
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

  // ── OpenAPI metadata — executable skills (skills table) ──────────────────

  registerOpenApi(app, {
    method: "get",
    path: "/agent-skills/executable",
    tags: ["Agent Skills"],
    summary: "List executable skills (skills table)",
    request: { query: GetSkillsQuerySchema },
    responses: {
      200: {
        description: "Executable skills",
        schema: z.array(WireSkillSchema),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/agent-skills/executable/{id}",
    tags: ["Agent Skills"],
    summary: "Get one executable skill by id (skills table)",
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({ userId: z.string().optional() }),
    },
    responses: {
      200: { description: "Executable skill", schema: WireSkillSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/agent-skills/executable",
    tags: ["Agent Skills"],
    summary: "Create an executable skill (skills table)",
    request: { body: CreateSkillRequestSchema },
    responses: {
      200: { description: "Created executable skill", schema: WireSkillSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── Executable skills (skills table) — static `/executable` prefix MUST be
  //    registered before the dynamic `/agent-skills/:id` + `/:slug` routes so
  //    Hono's first-match resolves the literal segment. ───────────────────────

  /**
   * GET /agent-skills/executable?userId=&workspaceId=&status=
   * List executable skills (skills table) via the hub-protocol skills caller.
   */
  app.get("/agent-skills/executable", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const userId = c.req.query("userId") || (c.get("userId") as string);
    const workspaceId = c.req.query("workspaceId");
    const status = c.req.query("status");
    const approvedQuery = c.req.query("approved");
    const approved =
      approvedQuery === undefined ? undefined : approvedQuery === "true";
    try {
      const caller = await getCaller(c);
      const result = await caller.skills.getSkills({
        userId,
        workspaceId: workspaceId || undefined,
        status: (status as "active" | "inactive" | "error" | "all") || "all",
        approved,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "agent-skills/executable list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /agent-skills/executable/:id?userId=
   * Get a single executable skill (skills table) by id.
   */
  app.get("/agent-skills/executable/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }
    const userId = c.req.query("userId") || (c.get("userId") as string);
    const skillId = c.req.param("id");
    if (!skillId) {
      return c.json({ error: "id is required" }, 400);
    }
    try {
      const caller = await getCaller(c);
      const result = await caller.skills.getSkill({ userId, skillId });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "agent-skills/executable get failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /agent-skills/executable
   * Create an executable skill (skills table).
   */
  app.post("/agent-skills/executable", async (c) => {
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
      logger.error({ err }, "agent-skills/executable create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
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
    // AI Teaching Substrate (Wave 3): isolate seeded `system/*` instruction skills
    // (ensureSystemSkills' namespace, see ensure-system-skills.ts) — the IS
    // skill-loader pod-overlay uses this to fetch just the teaching catalog,
    // never the user's whole skill library.
    const system = c.req.query("system") === "true";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);

    try {
      const conditions: SQL[] = [];

      if (topic) {
        // topics is text[] — use array containment
        conditions.push(
          drizzleSql`${skills.topics} @> ARRAY[${topic}]::text[]`
        );
      }

      if (tag) {
        conditions.push(drizzleSql`${skills.tags} @> ARRAY[${tag}]::text[]`);
      }

      if (system) {
        conditions.push(drizzleSql`${skills.slug} LIKE 'system/%'`);
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select()
        .from(skills)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(skills.name);

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
        .from(skills)
        .where(eq(skills.slug, slug))
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
        .from(skills)
        .where(eq(skills.id, id))
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
      const authUserId = (c.get("userId") as string) ?? "system";

      // Check slug uniqueness
      const [existing] = await db
        .select({ id: skills.id })
        .from(skills)
        .where(eq(skills.slug, parsed.data.slug))
        .limit(1);
      if (existing) {
        return c.json({ error: "Skill with this slug already exists" }, 409);
      }

      const [row] = await db
        .insert(skills)
        .values({
          userId: authUserId,
          slug: parsed.data.slug,
          kind: "instruction",
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          topics: parsed.data.topics ?? [],
          body: parsed.data.body,
          source: parsed.data.source ?? null,
          author: parsed.data.author ?? null,
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
        .update(skills)
        .set({
          ...parsed.data,
          updatedAt: new Date(),
        })
        .where(eq(skills.slug, slug))
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
      await db.delete(skills).where(eq(skills.id, id));
      return c.json({ success: true }, 200);
    } catch (err) {
      logger.error({ err }, "delete agent skill failed");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // ── Import schemas ──────────────────────────────────────────────────────

  const ImportSkillDocumentSchema = z.object({
    title: z.string().min(1).max(500),
    content: z.string().optional(),
    type: z
      .enum(["text", "markdown", "code", "html", "pdf", "docx"])
      .optional()
      .default("markdown"),
  });

  const ImportSkillBodySchema = z.object({
    userId: z.string().min(1),
    skill: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      slug: z.string().min(1).max(100),
      body: z.string().optional(),
      // auto_load=true → always-loaded core DNA (body injected every turn);
      // false → on-demand (only name+description in the catalog until the agent
      // loads it). Stored in metadata; the IS loader reads it (progressive disclosure).
      autoLoad: z.boolean().optional().default(false),
    }),
    documents: z.array(ImportSkillDocumentSchema).optional().default([]),
  });

  const ImportSkillResponseSchema = z.object({
    skill: AgentSkillWireSchema,
    documents: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
      })
    ),
  });

  registerOpenApi(app, {
    method: "post",
    path: "/agent-skills/import",
    tags: ["Agent Skills"],
    summary: "Import a skill with associated documents (JSON payload)",
    description:
      "Accepts a JSON body with skill metadata and an array of reference documents. " +
      "Creates a pod-wide instruction skill and linked document rows. " +
      "TODO: support ZIP (.skill file) upload with YAML frontmatter parsing.",
    request: {
      body: ImportSkillBodySchema,
    },
    responses: {
      200: {
        description: "Imported skill + documents",
        schema: ImportSkillResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /agent-skills/import
   *
   * Import a skill from a JSON payload containing skill metadata and optional
   * reference documents. The skill is created as kind="instruction", scope="pod".
   * Persistence goes through the same governed door as every other skill
   * creation path (`insertSkillGoverned`, shared with `skills.ts`) — an
   * agent-initiated import is never born approved, and a caller lacking
   * create rights lands a reviewable proposal instead of a silent write.
   *
   * TODO: Accept multipart/form-data ZIP upload (.skill file) containing
   * SKILL.md with YAML frontmatter + reference .md files.
   */
  app.post("/agent-skills/import", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }

    const parsed = ImportSkillBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const { userId, skill: skillMeta, documents: docs } = parsed.data;
    // Set only when the bearer is an agent API key (auth middleware — see
    // HubVariables.agentUserId) — the governance signal that this install is
    // agent-initiated, not an operator's own action.
    const agentUserId = c.get("agentUserId") as string | undefined;

    try {
      // Check slug uniqueness
      const [existing] = await db
        .select({ id: skills.id })
        .from(skills)
        .where(eq(skills.slug, skillMeta.slug))
        .limit(1);
      if (existing) {
        return c.json({ error: "Skill with this slug already exists" }, 409);
      }

      // Create the skill (instruction kind, pod-wide) through the ONE governed
      // insert path — never a direct insert with a hardcoded `approved: true`.
      const result = await insertSkillGoverned({
        userId,
        agentUserId,
        workspaceId: null,
        kind: "instruction",
        scope: "pod",
        slug: skillMeta.slug,
        name: skillMeta.name,
        description: skillMeta.description ?? null,
        body: skillMeta.body ?? null,
        tags: [],
        topics: [],
        // autoLoad: true = always-loaded core DNA; false = on-demand (catalog
        // + load_skill). The IS loader reads this for progressive disclosure.
        metadata: { autoLoad: skillMeta.autoLoad ?? false },
        auditSource: "agent_skills_import",
      });

      if (result.status === "denied") {
        return c.json({ error: result.reason }, 403);
      }
      if (result.status === "proposed") {
        return c.json(
          { status: "proposed" as const, proposalId: result.proposalId },
          202
        );
      }
      const skillRow = result.skill;

      // Create the CANONICAL body document (MinIO-backed, versioned) so the skill
      // body gets version history and collaborative editing. skills.body stays as
      // the hot-path cache the IS loader reads. Storage unification: everything
      // is a document; body is a denormalized cache.
      const caller = await getCaller(c);
      if (skillMeta.body) {
        const bodyDoc = (await caller.documents.createDocument({
          userId,
          title: `${skillMeta.slug}.md`,
          content: skillMeta.body,
          type: "markdown",
          workspaceId: null,
        })) as { documentId?: string; id?: string } | undefined;
        const bodyDocId = bodyDoc?.documentId ?? (bodyDoc as any)?.id;
        if (bodyDocId) {
          await db
            .update(skills)
            .set({ bodyDocumentId: bodyDocId } as any)
            .where(eq(skills.id, skillRow.id));
        }
      }

      // Create linked reference documents — the skill OWNS the relationship
      // (documentIds TEXT[]). Documents are generic substrate that don't know
      // who references them.
      const createdDocs: Array<{ id: string; title: string }> = [];
      if (docs.length > 0) {
        for (const d of docs) {
          const result = await caller.documents.createDocument({
            userId,
            title: d.title,
            content: d.content ?? "",
            type: d.type ?? "markdown",
            workspaceId: null,
          });
          const docId = (result as any)?.documentId ?? (result as any)?.id;
          if (docId) createdDocs.push({ id: docId, title: d.title });
        }
      }

      if (createdDocs.length > 0) {
        await db
          .update(skills)
          .set({ documentIds: createdDocs.map((d) => d.id) } as any)
          .where(eq(skills.id, skillRow.id));
      }

      return c.json(
        {
          skill: wireSkill(skillRow),
          documents: createdDocs,
        },
        200
      );
    } catch (err) {
      logger.error({ err }, "import agent skill failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
