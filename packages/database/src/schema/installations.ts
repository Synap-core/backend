/**
 * Installations Schema (0409)
 *
 * ONE capability installed on ONE of the person's computers: what runs (the
 * manifest as approved, its image digests), where (the computer), whose it is,
 * the key it holds, and where it stands. Stage 1 of "capabilities that install
 * on your computers" (design ccd509f8 §2, addendum 000e75ff §6, plan 64072312
 * U4), widened to ONE model with two kinds by the installer reconciliation
 * (f75fbb48 §3.1, founder 2026-11-07): `service` runs Docker compose services,
 * `tool` is a CLI binary installed by per-OS steps.
 *
 * What was ASKED (`desired_state`, `desired_version`, `approved_at`) is kept
 * apart from what was OBSERVED (`observed_version`, `observed_os`,
 * `observed_arch`, `verified_at`, `health`): the pod's reconciler turns the
 * difference into at most one open host job. ONE live row per (computer,
 * capability); a reinstall writes a new row once the old one is removed.
 *
 * `manifest` is the declaration AS APPROVED: the host runner writes its
 * compose file from this snapshot only, whatever happens to the capability
 * row afterwards (as `box_runs.spec` snapshots a box skill).
 *
 * Status is the LIFECYCLE only (planned → installing → installed … →
 * removed). Health (ok, degraded, drifted, stale, unknown, failed) is a READ
 * verdict over `health`, `verified_at` and `last_report_at`, never stored.
 * The row is never deleted: a removed installation stays as history.
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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { capabilities } from "./capabilities.js";
import { apiKeys } from "./api-keys.js";

/** Stored lifecycle (reconciliation f75fbb48 §3.1). Health is read, never stored. */
export const INSTALLATION_STATUSES = [
  "planned",
  "installing",
  "installed",
  "updating",
  "removing",
  "removed",
  "failed",
] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

/** `service` = Docker compose services; `tool` = a CLI binary from per-OS steps. */
export const INSTALLATION_KINDS = ["service", "tool"] as const;
export type InstallationKind = (typeof INSTALLATION_KINDS)[number];

/** What the person asked for this installation. */
export const INSTALLATION_DESIRED_STATES = ["installed", "removed"] as const;
export type InstallationDesiredState =
  (typeof INSTALLATION_DESIRED_STATES)[number];

/**
 * What the host runner last reported (`/host-jobs/:id/report`): the services'
 * health for a `service`, the verify result for a `tool`.
 */
export interface InstallationHealth {
  /** Per service id: its health check verdict, in plain words. */
  services?: Record<
    string,
    { healthy: boolean; detail?: string; checkedAt?: string }
  >;
  /** Per service id: the running image digest and upstream version. */
  versions?: Record<string, { digest?: string; version?: string }>;
  /** Ports bound on the computer (always 127.0.0.1). */
  ports?: Array<{ service: string; port: number; host: string }>;
  /** Disk the installation uses on the computer, and what is free. */
  disk?: { usedMb?: number; freeMb?: number };
  /** A tool's last verify: the check's exit code, an output excerpt, its hash. */
  verify?: {
    exitCode: number;
    excerpt?: string;
    outputSha256?: string;
    smoke?: { ok: boolean; detail?: string };
  };
}

export const installations = pgTable(
  "installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The owner: the person the installation belongs to (read floor). */
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id"),
    kind: text("kind", { enum: INSTALLATION_KINDS }).notNull(),
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
    /** ASKED: what the person wants on the computer. */
    desiredState: text("desired_state", { enum: INSTALLATION_DESIRED_STATES })
      .notNull()
      .default("installed"),
    /** ASKED: the approved version; a repair installs this one again. */
    desiredVersion: text("desired_version"),
    approvedAt: timestamp("approved_at", { mode: "date", withTimezone: true }),
    /** The person who approved (a user id). */
    approvedBy: text("approved_by"),
    status: text("status", { enum: INSTALLATION_STATUSES })
      .notNull()
      .default("planned"),
    /** A short sentence for a failed installation. */
    statusDetail: text("status_detail"),
    /** OBSERVED on the computer by the last report. */
    observedVersion: text("observed_version"),
    observedOs: text("observed_os"),
    observedArch: text("observed_arch"),
    health: jsonb("health").$type<InstallationHealth>(),
    /** OBSERVED: the last verify (a tool's check, a service's health). */
    verifiedAt: timestamp("verified_at", { mode: "date", withTimezone: true }),
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
    /** ONE live installation per (computer, capability). */
    livePerMachine: uniqueIndex("uq_installations_live_per_machine")
      .on(table.machineUserId, table.capabilityKey)
      .where(sql`${table.status} <> 'removed'`),
    capabilityIdx: index("idx_installations_capability").on(table.capabilityId),
  })
);

export type InstallationRow = typeof installations.$inferSelect;
export type NewInstallationRow = typeof installations.$inferInsert;
