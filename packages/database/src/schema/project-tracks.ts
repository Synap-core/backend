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

/**
 * The stored option keys of a track's SYSTEM LIFECYCLE (0344). Categories,
 * words and who may enter each live in `@synap-core/types/units`
 * (`TRACK_STATUS_DECLARATION`); this package cannot import that one, so the
 * tracks service pins the two lists equal at compile time. `completed` (done,
 * "Closed") and `archived` (lost, "Dropped") are contract keys — never renamed.
 */
export const PROJECT_TRACK_STATUSES = [
  "proposed",
  "agreed",
  "ready",
  "active",
  "paused",
  "completed",
  "archived",
] as const;
export type ProjectTrackStatus = (typeof PROJECT_TRACK_STATUSES)[number];
/**
 * The statuses under which a track is LIVE and holds its name on its project
 * — the open, active and paused categories (`uniq_project_tracks_live_name`,
 * 0317/0344 — whose predicate spells the same set).
 */
export const LIVE_PROJECT_TRACK_STATUSES = [
  "proposed",
  "agreed",
  "ready",
  "active",
  "paused",
] as const satisfies readonly ProjectTrackStatus[];

/**
 * How a closed or dropped track ended (0344, R1) — mirror of `TRACK_VERDICTS`
 * (`@synap-core/types/units`), pinned equal by the tracks service; the
 * `project_tracks_verdict_check` constraint spells the same set.
 */
export const PROJECT_TRACK_VERDICTS = [
  "met",
  "partly_met",
  "not_met",
  "retired",
  "no_longer_needed",
  "impossible",
  "replaced",
  "mistake",
] as const;
export type ProjectTrackVerdict = (typeof PROJECT_TRACK_VERDICTS)[number];

/**
 * The kind of work a goal is (0345, decision 4) — mirror of
 * `TRACK_WORK_KINDS` (`@synap-core/types/units`), pinned equal by the tracks
 * service; `project_tracks_work_kind_check` spells the same set.
 */
export const PROJECT_TRACK_WORK_KINDS = [
  "project",
  "flow",
  "operation",
  "investigation",
  "incident",
  "commission",
  "pathway",
] as const;
export type ProjectTrackWorkKind = (typeof PROJECT_TRACK_WORK_KINDS)[number];

/**
 * How well the way is known (0345, decision 4) — mirror of
 * `TRACK_UNCERTAINTY_LEVELS`, pinned the same way;
 * `project_tracks_uncertainty_check` spells the same set.
 */
export const PROJECT_TRACK_UNCERTAINTY_LEVELS = [
  "clear",
  "complicated",
  "complex",
  "chaotic",
  "unknown",
] as const;
export type ProjectTrackUncertainty =
  (typeof PROJECT_TRACK_UNCERTAINTY_LEVELS)[number];

/**
 * What a track pinned from its method at start. Every key optional: a track
 * backfilled from a project's legacy `settings.stages` (0272) carries only
 * `stages`.
 *
 * NOT pinned: the method's TOP-LEVEL `expectedOutputs` / `criteria`. They were
 * written here until 2026-10-05 and never read — a track yields nothing of its
 * own; its stages' sessions do, and each stage pins its own outputs and
 * criteria inside `stages`. Rows started before then still carry the two keys
 * in the jsonb; nothing reads them.
 */
export interface ProjectTrackDefinitionSnapshot {
  stages?: unknown;
  goalTemplate?: string;
  /** The method's declared params (0274) — what `project_tracks.params` answers. */
  params?: unknown;
  version?: number;
}

/**
 * One stage the track ENTERED (0274), oldest first. Appended by the track's
 * single stage writer (`TrackRepository.advanceStage`) in the same UPDATE as
 * `current_stage`, and seeded at birth. A re-entered stage is a NEW entry.
 */
export interface ProjectTrackStageHistoryEntry {
  stageKey: string;
  /** The stage it came from — `null` for the birth seed. */
  fromStage: string | null;
  /** ISO-8601. */
  enteredAt: string;
  /** Who moved it: the agent's user id when an agent drove it, else the human. */
  actor: string;
  /**
   * The verdict of the entered stage's `check` ENTRY gate (measuring the
   * stage LEFT), stamped after the gate ran (`TrackRepository.stampStageCheck`).
   * Absent = no check gate ran on this move.
   */
  check?: { passed: boolean; failing: string[]; reason?: string };
}

/**
 * The optional number a track steers by (0302). `current` is STATED — by a
 * person or an agent — never measured: nothing in the pod derives "qualified
 * leads per month", so the value always travels with when it was stated
 * (`updatedAt`) and by whom (`updatedBy`). Mirrored as `TrackKpi` in
 * `@synap-core/types/units` (this package cannot import types); the tracks
 * service pins the two equal at compile time.
 */
export interface ProjectTrackKpi {
  label: string;
  unit?: string;
  target: number;
  current?: number;
  /** ISO-8601 — when `current` was last stated. */
  updatedAt?: string;
  /** The user (or agent) id that stated `current`. */
  updatedBy?: string;
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
    /**
     * The answers to the method's declared params (0274) — the track's
     * onboarding. Passed as the answers to every stage session
     * (`startStageSession`), so a REQUIRED param still missing there becomes a
     * human-owned deliverable on that session.
     */
    params: jsonb("params")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Every stage the track entered, oldest first (0274). */
    stageHistory: jsonb("stage_history")
      .$type<ProjectTrackStageHistoryEntry[]>()
      .notNull()
      .default([]),
    /**
     * Where the track is heading, in one line (0302). May be non-verifiable
     * — the verifiable part lives in its sessions' outcomes. NULL = not said.
     */
    direction: text("direction"),
    /** The optional number the track steers by (0302). NULL = none. */
    kpi: jsonb("kpi").$type<ProjectTrackKpi>(),
    /**
     * How the track ENDED (0344, R1) — set by the status door on the move into
     * done (met · partly_met · not_met) or lost (no_longer_needed · impossible
     * · replaced · mistake); NULL while it is live, and on a track dropped
     * before verdicts existed. Final: a closed track never reopens in place.
     */
    verdict: text("verdict", {
      enum: PROJECT_TRACK_VERDICTS,
    }).$type<ProjectTrackVerdict>(),
    /** Why, in words — required for `impossible` and `replaced`. */
    verdictReason: text("verdict_reason"),
    /** The person who closed it (the approver, when an agent proposed it). */
    verdictBy: text("verdict_by"),
    verdictAt: timestamp("verdict_at", { mode: "date", withTimezone: true }),
    /** What "done" looks like, in words (0345). NULL = unsaid. */
    endState: text("end_state"),
    /**
     * The goal's criteria (0345, decision 1): 0 or 2–5, the session
     * criterion shape (`readCriteria`, @synap/playbooks), each entry with the
     * judge's `acceptance` once decided (R2 — written only by the acceptance
     * door). NULL or [] = a lasting goal. Marks are DERIVED, never stored.
     */
    criteria: jsonb("criteria").$type<unknown[]>(),
    /** When to stop (0345): a list of lines. NULL = none said. */
    dropConditions: jsonb("drop_conditions").$type<string[]>(),
    /** The kind of work (0345, decision 4) — proposed by AI, confirmed by a person. */
    workKind: text("work_kind", {
      enum: PROJECT_TRACK_WORK_KINDS,
    }).$type<ProjectTrackWorkKind>(),
    /** How well the way is known (0345, decision 4). */
    uncertainty: text("uncertainty", {
      enum: PROJECT_TRACK_UNCERTAINTY_LEVELS,
    }).$type<ProjectTrackUncertainty>(),
    /**
     * The person who confirmed kind + uncertainty, and when — NULL while they
     * are only the AI's proposal. A person writing them counts as confirmed.
     */
    kindConfirmedBy: text("kind_confirmed_by"),
    kindConfirmedAt: timestamp("kind_confirmed_at", {
      mode: "date",
      withTimezone: true,
    }),
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
    // A LIVE track's identity on its project is its NAME (0317, live set
    // widened by 0344): the same method may run twice under two names. Closed
    // and dropped tracks hold nothing. Required at boot by `findMissingIndexes`
    // (by name — the predicate is this one, keep it LIVE_PROJECT_TRACK_STATUSES).
    liveNameUniq: uniqueIndex("uniq_project_tracks_live_name")
      .on(table.projectId, sql`lower(btrim(${table.name}))`)
      .where(
        sql`${table.status} IN ('proposed', 'agreed', 'ready', 'active', 'paused')`
      ),
  })
);

export type ProjectTrack = typeof projectTracks.$inferSelect;
export type NewProjectTrack = typeof projectTracks.$inferInsert;
