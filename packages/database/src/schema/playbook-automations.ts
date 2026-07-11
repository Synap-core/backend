/**
 * Playbook Automations Schema — playbook → automations composition (CONFIG)
 *
 * A playbook composes N automations. Historically this was expressed ONLY as
 * read-only `links` edges (`automation --member_of--> playbook`). This table
 * promotes that composition to a first-class, editable, ordered, role-tagged
 * set so a playbook can own its automations directly.
 *
 * Soft-link convention (mirrors focus_sessions.playbook_id / subject_entity_id):
 * no hard FK to `playbooks` or `automations` — both ids are enforced at the
 * application layer.
 *
 * Added by 0179_playbook_automations.sql.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const playbookAutomations = pgTable(
  "playbook_automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The playbook this automation belongs to. FK at the app layer (soft link). */
    playbookId: uuid("playbook_id").notNull(),
    /** The composed automation. FK at the app layer (soft link). */
    automationId: uuid("automation_id").notNull(),
    /** Optional role tag for the automation within the playbook (e.g. "driver"). */
    role: text("role"),
    /** Optional explicit ordering within the playbook. */
    sortOrder: integer("sort_order"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    uniqueEdge: uniqueIndex("idx_playbook_automations_unique").on(
      table.playbookId,
      table.automationId
    ),
    playbookIdIdx: index("idx_playbook_automations_playbook_id").on(
      table.playbookId
    ),
  })
);

export type PlaybookAutomation = typeof playbookAutomations.$inferSelect;
export type NewPlaybookAutomation = typeof playbookAutomations.$inferInsert;
export const insertPlaybookAutomationSchema =
  createInsertSchema(playbookAutomations);
export const selectPlaybookAutomationSchema =
  createSelectSchema(playbookAutomations);
