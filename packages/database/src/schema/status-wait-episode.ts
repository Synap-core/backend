/**
 * WAIT EPISODES (0386, status-first PR-H): one row per stretch of time a thing
 * waited on one thing. The status watcher opens it when THE waiting-on
 * collector first finds the wait and closes it on the first tick that no
 * longer does (`services/lifecycle/wait-episodes.ts`). One OPEN episode per
 * (subject, facet, wait kind, ref key): the partial unique index.
 */
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const statusWaitEpisode = pgTable(
  "status_wait_episode",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `entity` | `track` | `focus_session` (`TransitionSubjectType`). */
    subjectType: text("subject_type").notNull(),
    /** The entity, goal or session that waits (never its facet). */
    subjectId: text("subject_id").notNull(),
    /** The role's facet when the wait is on a role's lifecycle, else null. */
    facetId: text("facet_id"),
    /** `WaitKind` (`@synap-core/types/units`). */
    waitKind: text("wait_kind").notNull(),
    /** A hold's `on` (`HOLD_ON`) when the wait is a pause. */
    on: text("on"),
    /** The coarse waiting-on reason (`WAITING_ON_REASONS`). */
    reason: text("reason"),
    /** What is waited on (`WaitingOnRef`), as the thing's holder reads it. */
    ref: jsonb("ref").$type<Record<string, unknown>>(),
    /** The ref's identity (`waitEpisodeRefKey`); '' when unnamed. */
    refKey: text("ref_key").notNull().default(""),
    openedAt: timestamp("opened_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    closedAt: timestamp("closed_at", { mode: "date", withTimezone: true }),
  },
  (t) => ({
    // NULLS NOT DISTINCT in the migration: a kind's own wait (no facet) is
    // one key too.
    openUniq: uniqueIndex("uq_status_wait_episode_open")
      .on(t.subjectType, t.subjectId, t.facetId, t.waitKind, t.refKey)
      .where(sql`${t.closedAt} IS NULL`),
    subjectIdx: index("idx_status_wait_episode_subject").on(
      t.subjectType,
      t.subjectId,
      t.openedAt
    ),
  })
);

export type StatusWaitEpisodeRow = typeof statusWaitEpisode.$inferSelect;
