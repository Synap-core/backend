/**
 * Track participants (migration 0348) — WHO IS ON A GOAL (work model W3).
 *
 * One row per (goal, principal, role): the goal's OWNER (a person, exactly
 * one), its JUDGE (a person, at most one — none means the owner judges), its
 * DELEGATES (people or agents), each with a COMMITMENT and its state, and an
 * optional INTEGRATOR. A table, not `links` edges: one edge per pair cannot
 * hold a judge who is also a delegate, and a commitment has a state, a
 * counter-offer, a report and an acknowledgement.
 *
 * Roles, principal kinds and commitment states are declared once, in
 * `@synap-core/types/units` (`TRACK_PARTICIPANT_ROLES`, …), and re-exported
 * here under the pod's `*_KEYS` names; the 0348 CHECK constraints spell the
 * same sets.
 *
 * A participant row grants NO read (D5-A): an agent reads the goal only as the
 * person it acts for; a person reads it through the project's own floor.
 * Visibility of these rows is the track's (access `registry.ts`).
 *
 * `project_tracks` is not in the baseline (it references `projects`, 0151),
 * so neither is this table: `schema-coherence.ts` guards its columns and
 * indexes.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  TRACK_PARTICIPANT_ROLES as TRACK_PARTICIPANT_ROLE_KEYS,
  TRACK_PRINCIPAL_KINDS as TRACK_PRINCIPAL_KIND_KEYS,
  TRACK_COMMITMENT_STATES as TRACK_COMMITMENT_STATE_KEYS,
  type TrackParticipantRole as TrackParticipantRoleKey,
  type TrackPrincipalKind as TrackPrincipalKindKey,
  type TrackCommitmentState as TrackCommitmentStateKey,
} from "@synap-core/types/units";
import { projectTracks } from "./project-tracks.js";

export {
  TRACK_PARTICIPANT_ROLE_KEYS,
  TRACK_PRINCIPAL_KIND_KEYS,
  TRACK_COMMITMENT_STATE_KEYS,
  type TrackParticipantRoleKey,
  type TrackPrincipalKindKey,
  type TrackCommitmentStateKey,
};

export const trackParticipants = pgTable(
  "track_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => projectTracks.id, { onDelete: "cascade" }),
    principalKind: text("principal_kind", { enum: TRACK_PRINCIPAL_KIND_KEYS })
      .$type<TrackPrincipalKindKey>()
      .notNull(),
    /** A user id: the person's, or the agent's own user row (`agentUserId`). */
    principalId: text("principal_id").notNull(),
    role: text("role", { enum: TRACK_PARTICIPANT_ROLE_KEYS })
      .$type<TrackParticipantRoleKey>()
      .notNull(),
    /** What the delegate commits to. */
    commitment: text("commitment"),
    /** Set for a delegate, NULL for every other role (0348 CHECK). */
    commitmentState: text("commitment_state", {
      enum: TRACK_COMMITMENT_STATE_KEYS,
    }).$type<TrackCommitmentStateKey>(),
    counterText: text("counter_text"),
    reportedReason: text("reported_reason"),
    reportedAt: timestamp("reported_at", { mode: "date", withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", {
      mode: "date",
      withTimezone: true,
    }),
    /**
     * When the R10 job told the owner about an unacknowledged report — once
     * per report (a new report clears it). NULL = not escalated.
     */
    escalatedAt: timestamp("escalated_at", {
      mode: "date",
      withTimezone: true,
    }),
    /** Who made the last decision on this row (added it, or answered it). */
    decidedBy: text("decided_by").notNull(),
    decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    trackIdx: index("idx_track_participants_track_id").on(table.trackId),
    principalIdx: index("idx_track_participants_principal_id").on(
      table.principalId
    ),
    roleUniq: uniqueIndex("uniq_track_participants_role").on(
      table.trackId,
      table.principalId,
      table.role
    ),
    // ONE owner, at most ONE judge, per goal.
    ownerUniq: uniqueIndex("uniq_track_participants_owner")
      .on(table.trackId)
      .where(sql`${table.role} = 'owner'`),
    judgeUniq: uniqueIndex("uniq_track_participants_judge")
      .on(table.trackId)
      .where(sql`${table.role} = 'judge'`),
  })
);

export type TrackParticipantRow = typeof trackParticipants.$inferSelect;
export type NewTrackParticipantRow = typeof trackParticipants.$inferInsert;
