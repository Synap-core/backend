/**
 * Installations Schema (0399)
 *
 * ONE capability installed on ONE of the person's computers: what runs (the
 * manifest as approved, its image digests), where (the computer), whose it is,
 * the key it holds, and where it stands. Stage 1 of "capabilities that install
 * on your computers" (design ccd509f8 §2, addendum 000e75ff §6, plan 64072312
 * U4).
 *
 * `manifest` is the declaration AS APPROVED: the host runner writes its
 * compose file from this snapshot only, whatever happens to the capability
 * row afterwards (as `box_runs.spec` snapshots a box skill).
 *
 * Status is the parent design's one list (planned → installing → healthy …
 * → removed). `stalled` and "degraded by a missed heartbeat" are READ
 * verdicts (the heartbeat window over `last_report_at`), never stored. The
 * row is never deleted: a removed installation stays as history.
 *
 * Read floor = the owner (`user_id`) within the workspace lens
 * (`workspaceOwned`, access/registry.ts), as `box_runs`. The computer reads
 * its own installations only through the host-job routes.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { capabilities } from "./capabilities.js";
import { apiKeys } from "./api-keys.js";

/** Stored states (design ccd509f8 §2). Read verdicts are never stored. */
export const INSTALLATION_STATUSES = [
  "planned",
  "installing",
  "healthy",
  "degraded",
  "updating",
  "failed",
  "removing",
  "removed",
] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

/** What the host runner last reported (`/host-jobs/:id/report`). */
export interface InstallationHealth {
  /** Per service id: its health check verdict, in plain words. */
  services: Record<
    string,
    { healthy: boolean; detail?: string; checkedAt?: string }
  >;
  /** Per service id: the running image digest and upstream version. */
  versions?: Record<string, { digest?: string; version?: string }>;
  /** Ports bound on the computer (always 127.0.0.1). */
  ports?: Array<{ service: string; port: number; host: string }>;
  /** Disk the installation uses on the computer, and what is free. */
  disk?: { usedMb?: number; freeMb?: number };
}

export const installations = pgTable(
  "installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The owner: the person the installation belongs to (read floor). */
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id"),
    /** The installed capability; null once that capability row is deleted. */
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    /** The capability's key as installed, kept when the row is gone. */
    capabilityKey: text("capability_key").notNull(),
    /** The capability's own version (its manifest changes). */
    capabilityVersion: text("capability_version"),
    /** The upstream software's version (HyperFrames 0.9.12). */
    upstreamVersion: text("upstream_version"),
    /** The computer: a `users.agent_type = 'machine'` user id. */
    machineUserId: text("machine_user_id").notNull(),
    /** The installation's own agent user, minted at approval (U6). */
    agentUserId: text("agent_user_id"),
    /** The installation's own key, holding only the consented grants (U6). */
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    /** The approved `installation.create` proposal, when there was one. */
    proposalId: uuid("proposal_id"),
    /** The manifest AS APPROVED; the runner writes compose from it only. */
    manifest: jsonb("manifest")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Service id → image digest (`sha256:…`), pinned at approval. */
    digests: jsonb("digests")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    status: text("status", { enum: INSTALLATION_STATUSES })
      .notNull()
      .default("planned"),
    /** A short sentence for a failed or degraded installation. */
    statusDetail: text("status_detail"),
    health: jsonb("health").$type<InstallationHealth>(),
    /** The runner's last report; the heartbeat window reads it. */
    lastReportAt: timestamp("last_report_at", {
      mode: "date",
      withTimezone: true,
    }),
    installedAt: timestamp("installed_at", {
      mode: "date",
      withTimezone: true,
    }),
    removedAt: timestamp("removed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index("idx_installations_user").on(table.userId, table.createdAt),
    machineIdx: index("idx_installations_machine").on(table.machineUserId),
    capabilityIdx: index("idx_installations_capability").on(table.capabilityId),
  })
);

export type InstallationRow = typeof installations.$inferSelect;
export type NewInstallationRow = typeof installations.$inferInsert;
