/**
 * Proposal Cluster Mutes Schema (0233)
 *
 * Durable, per-pod mute of a rejection SHAPE-cluster. The calibration inbox's
 * "Mark expected" was session-only; this persists it so a muted rejection
 * cluster stops surfacing in the rejected-clusters read across sessions.
 *
 * KEYED BY FINGERPRINT: `fingerprint` is the SAME `computeProposalFingerprint`
 * value the rejected-clusters read (`proposals.groups({ status: 'rejected' })`)
 * produces, so a mute matches a cluster exactly.
 *
 * POD-SCOPED: no workspace column — a rejection shape is pod-wide, like the
 * duplicate-cluster recommender it mirrors. `created_by` records who muted it.
 *
 * SOFT UNMUTE: `revoked_at` NULL = active. Unmute stamps it (never deletes), so
 * the audit trail survives. The partial unique index
 * (`fingerprint WHERE revoked_at IS NULL`) guarantees at most one ACTIVE mute
 * per fingerprint while allowing a re-mute after a revoke.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const proposalClusterMutes = pgTable(
  "proposal_cluster_mutes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The rejection cluster's canonical fingerprint (computeProposalFingerprint). */
    fingerprint: text("fingerprint").notNull(),
    /** The user (or agent user) that muted the cluster. */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Soft unmute: NULL = active mute; set = revoked (cluster resurfaces). */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    // At most ONE active mute per fingerprint (pod-wide). A revoke frees the
    // fingerprint to be muted again later.
    activeFingerprintUnique: uniqueIndex("proposal_cluster_mutes_active_uq")
      .on(table.fingerprint)
      .where(sql`${table.revokedAt} IS NULL`),
  })
);

export type ProposalClusterMute = typeof proposalClusterMutes.$inferSelect;
export type NewProposalClusterMute = typeof proposalClusterMutes.$inferInsert;
