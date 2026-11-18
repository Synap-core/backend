/**
 * Compute leases (0431) — one row per compute start (plan a640c5bb B3,
 * founder decisions of 18 Nov 2026).
 *
 * A `provision_compute` verb starts a machine at a provider for a time to
 * live and a spend maximum, both REQUIRED. The run door writes this row
 * before the provider is called (no row, no start), and fills
 * `resourceId` from the run's result. The TTL sweeper
 * (`compute-lease-sweeper`) runs `releaseVerb` in mode `destroy` on every
 * active lease past `expiresAt`: the start's approval covers that destroy,
 * so it runs with no second review, recorded here and on the start's
 * proposal (`data.computeRelease`).
 *
 * `maxSpendCents` is the DECLARED maximum, never a measured spend; the
 * `compute_spend_daily_cents` ceiling (0430) sums it per UTC day.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** The states a lease moves through (0431 `compute_leases_state_check`). */
export const COMPUTE_LEASE_STATES = [
  "starting",
  "active",
  "released",
  "not_started",
  "unknown",
] as const;
export type ComputeLeaseState = (typeof COMPUTE_LEASE_STATES)[number];

export const computeLeases = pgTable(
  "compute_leases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The identity the start ran as (the approver, on an approved proposal). */
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id"),
    /** The agent that asked, when one did. */
    agentUserId: text("agent_user_id"),
    /** The approved start proposal, when the start was proposed. */
    proposalId: uuid("proposal_id"),
    sessionId: uuid("session_id"),
    provisionSkillId: uuid("provision_skill_id"),
    provisionVerb: text("provision_verb").notNull(),
    /** The `release_compute` verb the provision verb declares. */
    releaseVerb: text("release_verb").notNull(),
    /** The connection the start used: the release uses the same one. */
    connectionSelector: jsonb("connection_selector"),
    /** The provider's id of the machine, from the start's result. */
    resourceId: text("resource_id"),
    ttlMinutes: integer("ttl_minutes").notNull(),
    maxSpendCents: integer("max_spend_cents").notNull(),
    state: text("state")
      .$type<ComputeLeaseState>()
      .notNull()
      .default("starting"),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    releaseAttempts: integer("release_attempts").notNull().default(0),
    lastReleaseError: text("last_release_error"),
    releaseResult: jsonb("release_result"),
    releasedAt: timestamp("released_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    dueIdx: index("compute_leases_due_idx")
      .on(table.expiresAt)
      .where(sql`${table.state} = 'active'`),
    createdIdx: index("compute_leases_created_idx").on(table.createdAt),
    resourceIdx: index("compute_leases_resource_idx")
      .on(table.userId, table.resourceId)
      .where(sql`${table.state} = 'active'`),
  })
);

export type ComputeLease = typeof computeLeases.$inferSelect;
export type NewComputeLease = typeof computeLeases.$inferInsert;
