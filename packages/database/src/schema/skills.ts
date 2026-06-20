/**
 * Skills Schema
 *
 * The canonical skills table — merged from the (now-dropped) agent_skills table.
 * Two kinds, differentiated by `kind`:
 *
 *   instruction — text injected into the agent system prompt (always-on
 *                 knowledge/methodology). Uses the `body` column (Markdown).
 *   code        — JS/TS function executed in the Intelligence Hub sandbox
 *                 (callable tool). Uses the `code` column.
 *
 * Columns absorbed from agent_skills: slug, body, topics, source, author,
 * version, tags. Doc-style skills set kind='instruction' with body populated;
 * executable skills set kind='code' with code populated.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export type SkillKind = "instruction" | "code";
/**
 * pod       — visible to all users on the data pod (default)
 * user      — visible only to the owning user
 * workspace — visible to all members of the workspace
 */
export type SkillScope = "pod" | "user" | "workspace";

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // ── Ownership ────────────────────────────────────────────────────────

    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),

    // ── Identity (from agent_skills merge) ───────────────────────────────

    /** Human-readable unique identifier (e.g. "gsap-react", "synap-ui"). Nullable for legacy rows. */
    slug: text("slug"),

    // ── Classification ───────────────────────────────────────────────────

    /**
     * instruction — text appended to the agent system prompt
     * code        — JS/TS function executed in the sandbox
     */
    kind: text("kind", { enum: ["instruction", "code"] })
      .notNull()
      .default("code")
      .$type<SkillKind>(),

    /**
     * pod       — visible to all users on the data pod (default)
     * user      — visible only to the owning user
     * workspace — visible to all members of the workspace
     */
    scope: text("scope", { enum: ["pod", "user", "workspace"] })
      .notNull()
      .default("pod")
      .$type<SkillScope>(),

    /**
     * Which agent types this skill applies to.
     * NULL = applies to all agents.
     * e.g. ["assistant", "research"]
     */
    agentTypes: jsonb("agent_types").$type<string[] | null>(),

    // ── Definition ───────────────────────────────────────────────────────

    name: text("name").notNull(),
    description: text("description"),

    /**
     * For kind='instruction': the skill body (Markdown), stored for agent
     * injection. Absorbed from agent_skills.body.
     */
    body: text("body"),

    /**
     * For kind='code': the JavaScript/TypeScript function body.
     * Nullable — doc-style skills (kind='instruction') have no code.
     */
    code: text("code"),

    /** Parameter schema (code skills only) — describes callable arguments */
    parameters: jsonb("parameters"),

    category: text("category"), // e.g. 'action', 'context', 'crm', 'research'

    // ── Discoverability (from agent_skills merge) ─────────────────────────

    /** Searchable keywords — "animation", "react", "timeline", etc. */
    topics: text("topics").array().default([]),

    // ── Provenance (from agent_skills merge) ──────────────────────────────

    /** Source origin (e.g. "file://~/.claude/skills/gsap-react"). */
    source: text("source"),
    /** Original skill author or package name. */
    author: text("author"),
    /** Semver string. */
    version: text("version"),
    /** Free-form tags. */
    tags: text("tags").array().default([]),

    // ── Execution (code skills only) ─────────────────────────────────────

    executionMode: text("execution_mode", {
      enum: ["sync", "async"],
    })
      .notNull()
      .default("sync"),

    timeoutSeconds: integer("timeout_seconds").default(30),

    // ── Status ───────────────────────────────────────────────────────────

    status: text("status", {
      enum: ["active", "inactive", "error"],
    })
      .notNull()
      .default("active"),

    /**
     * Per-capability approval gate (orthogonal to `status` = lifecycle/health).
     * A skill is born NOT approved (DEFAULT false): a freshly-created or
     * AI-created `code` skill cannot execute and is not loaded as an agent tool
     * until an owner approves it. `instruction` skills (prompt-only, no side
     * effects) are seeded approved by the create path. Existing rows are
     * grandfathered to true by migration 0143. Mirrors `mcp_servers.approved`.
     */
    approved: boolean("approved").notNull().default(false),

    errorMessage: text("error_message"),

    // ── Metadata ─────────────────────────────────────────────────────────

    /**
     * Free-form metadata:
     * { executionCount, lastTestedAt, installedFromUrl, skillType (legacy) }
     */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    // ── Timestamps ───────────────────────────────────────────────────────

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    slugIdx: uniqueIndex("idx_skills_slug").on(table.slug),
    userIdIdx: index("skills_user_id_idx").on(table.userId),
    workspaceIdIdx: index("skills_workspace_id_idx").on(table.workspaceId),
    statusIdx: index("skills_status_idx").on(table.status),
    approvedIdx: index("idx_skills_approved").on(table.approved),
    kindIdx: index("skills_kind_idx").on(table.kind),
    nameIdx: index("skills_name_idx").on(table.name),
    topicsIdx: index("idx_skills_topics").on(table.topics),
  })
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;

export const insertSkillSchema = createInsertSchema(skills);
export const selectSkillSchema = createSelectSchema(skills);
