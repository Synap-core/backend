/**
 * Skills Schema
 *
 * User-created skills/tools that extend the AI's capabilities.
 * Skills are stored in the backend, executed in the Intelligence Service.
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

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Ownership
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),

    // Skill Definition
    name: text("name").notNull(),
    description: text("description"),
    code: text("code").notNull(), // TypeScript/JavaScript code for the skill
    parameters: jsonb("parameters"), // Zod schema for parameters
    category: text("category"), // 'action', 'context', 'investigation', etc.

    // Execution
    executionMode: text("execution_mode", {
      enum: ["sync", "async"],
    })
      .notNull()
      .default("sync"),
    timeoutSeconds: integer("timeout_seconds").default(30),

    // Status
    status: text("status", {
      enum: ["active", "inactive", "error"],
    })
      .notNull()
      .default("active"),
    errorMessage: text("error_message"), // Last error if status is 'error'

    // Metadata
    metadata: jsonb("metadata").default("{}").notNull(),
    // {
    //   version: 1,
    //   lastTestedAt: '2025-01-XX',
    //   executionCount: 10,
    //   averageExecutionTime: 150,
    //   tags: ['calendar', 'automation']
    // }

    // Timestamps
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
    nameIdx: index("skills_name_idx").on(table.name),
  })
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;

// Zod Schemas
export const insertSkillSchema = createInsertSchema(skills);
export const selectSkillSchema = createSelectSchema(skills);
