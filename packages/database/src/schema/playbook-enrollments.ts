/**
 * Playbook Enrollments Schema — entity ↔ playbook enrollment (RUNTIME)
 *
 * Many entities can be enrolled in a single playbook. Historically a playbook
 * could act on only ONE entity, faked as `focus_sessions.subject_entity_id`.
 * This table makes enrollment first-class: each (playbook, entity) pair carries
 * its own lifecycle status and per-entity step position.
 *
 * Soft-link convention (mirrors focus_sessions.subject_entity_id): no hard FK on
 * `entity_id` (or `playbook_id`).
 *
 * SECURITY (later wave): the enrollment WRITE path MUST enforce
 * workspace-visibility on `entity_id` in the application layer — there is no FK,
 * so a crafted `entity_id` is an IDOR risk. Mirror the write-side guard at
 * packages/jobs/src/workers/automation-executor.ts:1632-1648.
 *
 * `status` is plain text with no CHECK, matching the focus_sessions.status
 * convention (values: active/paused/completed/cancelled).
 *
 * Added by 0180_playbook_enrollments.sql.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const playbookEnrollments = pgTable(
  "playbook_enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The playbook the entity is enrolled in. FK at the app layer (soft link). */
    playbookId: uuid("playbook_id").notNull(),
    /**
     * The enrolled entity. FK at the app layer (soft link) — the WRITE path MUST
     * enforce workspace-visibility here (IDOR guard; no DB FK).
     */
    entityId: uuid("entity_id").notNull(),
    /** Enrollment lifecycle: active/paused/completed/cancelled (plain text, no CHECK). */
    status: text("status").notNull().default("active"),
    /** Per-entity step position within the playbook. */
    stepState: jsonb("step_state").notNull().default({}),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    uniqueEnrollment: uniqueIndex("idx_playbook_enrollments_unique").on(
      table.playbookId,
      table.entityId
    ),
    playbookIdIdx: index("idx_playbook_enrollments_playbook_id").on(
      table.playbookId
    ),
    entityIdIdx: index("idx_playbook_enrollments_entity_id").on(table.entityId),
  })
);

export type PlaybookEnrollment = typeof playbookEnrollments.$inferSelect;
export type NewPlaybookEnrollment = typeof playbookEnrollments.$inferInsert;
export const insertPlaybookEnrollmentSchema =
  createInsertSchema(playbookEnrollments);
export const selectPlaybookEnrollmentSchema =
  createSelectSchema(playbookEnrollments);
