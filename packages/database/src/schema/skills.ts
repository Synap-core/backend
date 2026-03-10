/**
 * Skills Schema
 *
 * User-created extensions that augment AI capabilities.
 * Two kinds — stored in the same table, differentiated by `kind`:
 *
 *   instruction — text injected into the agent system prompt (always-on knowledge/methodology)
 *   code        — JS function executed in the Intelligence Hub sandbox (callable tool)
 *
 * Both kinds are stored in the backend and read by intelligence services via Hub Protocol.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
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
     * For kind='instruction': the instruction text injected into the system prompt.
     * For kind='code':        the JavaScript/TypeScript function body.
     */
    code: text("code").notNull(),

    /** Parameter schema (code skills only) — describes callable arguments */
    parameters: jsonb("parameters"),

    category: text("category"), // e.g. 'action', 'context', 'crm', 'research'

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

    errorMessage: text("error_message"),

    // ── Metadata ─────────────────────────────────────────────────────────

    /**
     * Free-form metadata:
     * { executionCount, lastTestedAt, installedFromUrl, source, version, skillType (legacy) }
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
    userIdIdx: index("skills_user_id_idx").on(table.userId),
    workspaceIdIdx: index("skills_workspace_id_idx").on(table.workspaceId),
    statusIdx: index("skills_status_idx").on(table.status),
    kindIdx: index("skills_kind_idx").on(table.kind),
    nameIdx: index("skills_name_idx").on(table.name),
  })
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;

export const insertSkillSchema = createInsertSchema(skills);
export const selectSkillSchema = createSelectSchema(skills);
