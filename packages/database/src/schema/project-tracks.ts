/**
 * Project Tracks Schema (migration 0272)
 *
 * A PROJECT is long-lived intent. A TRACK is a METHOD running inside ONE
 * project — "Business model", "Content", "Build" inside "Launch The Architech".
 * A project has N tracks.
 *
 * The METHOD is a playbook with `scope: "project"`, reusable by any number of
 * projects. A track PINS the definition it was started from
 * (`definitionSnapshot` + `methodVersion`) — the same rule
 * `playbook_runs.definitionSnapshot` follows — so editing the method never
 * silently rewrites the vocabulary a live track sits in.
 *
 * A track is NOT a playbook run (a run is one execution, reaped after 24h
 * quiet) and NOT a focus session (every session reader assumes sessions end).
 * Sessions are born INSIDE a track: `focus_sessions.track_id`.
 *
 * Visibility: a track is exactly as visible as its parent project
 * (api `access/registry.ts`). Writes gate on the LOADED project's workspace.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.js";
import { playbooks } from "./playbooks.js";

export const PROJECT_TRACK_STATUSES = [
  "active",
  "paused",
  "completed",
  "archived",
] as const;
export type ProjectTrackStatus = (typeof PROJECT_TRACK_STATUSES)[number];

/**
 * What a track pinned from its method at start. Every key optional: a track
 * backfilled from a project's legacy `settings.stages` (0272) carries only
 * `stages`.
 */
export interface ProjectTrackDefinitionSnapshot {
  stages?: unknown;
  goalTemplate?: string;
  expectedOutputs?: unknown;
  criteria?: unknown;
  version?: number;
}

export const projectTracks = pgTable(
  "project_tracks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Who started the track (attribution, NOT the visibility floor). */
    userId: text("user_id").notNull(),
    /** The METHOD. Nullable so deleting a method keeps the track's history. */
    playbookId: uuid("playbook_id").references(() => playbooks.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    definitionSnapshot: jsonb("definition_snapshot")
      .$type<ProjectTrackDefinitionSnapshot>()
      .notNull()
      .default({}),
    methodVersion: text("method_version").notNull().default("1"),
    /** A key of `definitionSnapshot.stages`, or NULL for a stageless method. */
    currentStage: text("current_stage"),
    status: text("status", { enum: PROJECT_TRACK_STATUSES })
      .$type<ProjectTrackStatus>()
      .notNull()
      .default("active"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    projectIdIdx: index("idx_project_tracks_project_id").on(table.projectId),
    playbookIdIdx: index("idx_project_tracks_playbook_id").on(table.playbookId),
    liveMethodUniq: uniqueIndex("uniq_project_tracks_live_method")
      .on(table.projectId, table.playbookId)
      .where(
        sql`${table.status} <> 'archived' AND ${table.playbookId} IS NOT NULL`
      ),
  })
);

export type ProjectTrack = typeof projectTracks.$inferSelect;
export type NewProjectTrack = typeof projectTracks.$inferInsert;
