/**
 * Skill Triggers
 *
 * Defines when a skill auto-activates:
 *   entity_event — fires when an entity matching the filters is created/updated
 *   cron         — fires on a cron schedule
 *   manual       — only fires when explicitly called
 *
 * Each trigger has a backing automation (auto-created) that powers execution.
 * Deleting a trigger also deletes its backing automation.
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { skills } from "./skills.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const skillTriggers = pgTable(
  "skill_triggers",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),

    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    userId: text("user_id").notNull(),

    type: text("type", {
      enum: ["entity_event", "cron", "manual"],
    })
      .notNull()
      .$type<"entity_event" | "cron" | "manual">(),

    // For entity_event triggers
    eventPattern: text("event_pattern"), // e.g. "entities.create.completed"
    filters: jsonb("filters").$type<Record<string, unknown>>(), // { profileSlug: "book" }

    // For cron triggers
    cronExpression: text("cron_expression"), // e.g. "0 10 * * 0"

    // Execution behavior
    channelType: text("channel_type", {
      enum: ["personal", "new_thread"],
    })
      .notNull()
      .default("personal")
      .$type<"personal" | "new_thread">(),

    isActive: boolean("is_active").notNull().default(true),

    // Backing automation (auto-created on trigger creation)
    automationId: uuid("automation_id"),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    skillIdIdx: index("skill_triggers_skill_id_idx").on(table.skillId),
    workspaceIdIdx: index("skill_triggers_workspace_id_idx").on(
      table.workspaceId
    ),
    typeIdx: index("skill_triggers_type_idx").on(table.type),
  })
);

export type SkillTrigger = typeof skillTriggers.$inferSelect;
export type NewSkillTrigger = typeof skillTriggers.$inferInsert;

export const insertSkillTriggerSchema = createInsertSchema(skillTriggers);
export const selectSkillTriggerSchema = createSelectSchema(skillTriggers);
