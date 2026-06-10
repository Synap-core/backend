/**
 * Agent Skills Schema
 *
 * Skills are structured knowledge packages that extend agent capabilities.
 * Stored as a real table (not entities) because they are platform infrastructure,
 * not user-authored content.
 *
 * A skill has:
 *   - Identity (slug, name, description)
 *   - Discoverability (topics — for semantic search)
 *   - Body (the skill content, typically Markdown)
 *   - Provenance (source, author, version)
 *
 * Skills are pod-scoped (shared across all workspaces and agents).
 * The shared "agent" workspace serves as the data context for skills,
 * memory, and observations that all agents can use.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const agentSkills = pgTable(
  "agent_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-readable unique identifier (e.g. "gsap-react", "synap-ui"). */
    slug: text("slug").notNull(),
    /** Display name (e.g. "GSAP React", "Synap UI Design"). */
    name: text("name").notNull(),
    /** One-line description of what this skill does. */
    description: text("description"),
    /** Searchable keywords — "animation", "react", "timeline", etc. */
    topics: text("topics").array().default([]),
    /** The skill file body (SKILL.md content), stored for agent injection. */
    body: text("body").notNull(),
    /** Source origin (e.g. "file://~/.claude/skills/gsap-react", "registry:skills.sh"). */
    source: text("source"),
    /** Original skill author or package name. */
    author: text("author"),
    /** Semver string. */
    version: text("version"),
    /** Free-form tags. */
    tags: text("tags").array().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    slugIdx: uniqueIndex("idx_agent_skills_slug").on(table.slug),
    topicsIdx: index("idx_agent_skills_topics").on(table.topics),
  })
);

export type AgentSkill = typeof agentSkills.$inferSelect;
export type NewAgentSkill = typeof agentSkills.$inferInsert;
export const insertAgentSkillSchema = createInsertSchema(agentSkills);
export const selectAgentSkillSchema = createSelectSchema(agentSkills);
