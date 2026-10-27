/**
 * Box Runs Schema (0356)
 *
 * ONE RUN of a box skill (`skills.execution_mode = 'box'`): a script with
 * packages that runs on the person's own computer, never in the pod. Running
 * the skill writes a `queued` row; a computer (`users.agent_type = 'machine'`,
 * key scope `box.runner`) leases it over Hub REST (`/box-runs/lease`),
 * heartbeats, and finishes it with its evidence. The pod holds the queue, the
 * lease and the evidence; the box holds no pod credential.
 *
 * `spec` is the script AS QUEUED: what the person approved runs, whatever
 * happens to the skill row afterwards.
 *
 * Read floor = the requester (`user_id`) within the workspace lens
 * (`workspaceOwned`, access/registry.ts). `stalled` is a READ verdict
 * (a `running` row whose lease expired), never stored.
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
import { skills } from "./skills.js";

/** Stored states. `stalled` is read, not stored (see file header). */
export const BOX_RUN_STATUSES = [
  "queued",
  "leased",
  "running",
  "done",
  "failed",
  "stopped",
] as const;
export type BoxRunStatus = (typeof BOX_RUN_STATUSES)[number];

/** The script a run executes, snapshotted at queue time. */
export interface BoxRunSpec {
  name: string;
  language: "python" | "node";
  entrypoint: string;
  code: string;
  packages: Array<{ name: string; version: string }>;
  hosts: string[];
  limits: {
    wallSeconds: number;
    cpus: number;
    memoryMb: number;
    diskMb: number;
    outMb: number;
  };
}

/** What the provisioner reported at finish, as stored (wire: BOX-CONTRACT). */
export interface BoxRunEvidence {
  /**
   * The provisioner's verdict. `timeout` and `infra` are stored as status
   * `failed`; the verdict keeps INFRA (the box did not answer) apart from a
   * script that failed.
   */
  verdict: "done" | "failed" | "stopped" | "timeout" | "infra";
  exitCode: number | null;
  durationMs: number | null;
  infraReason?: string;
  log: {
    head: string;
    tail: string;
    totalBytes: number | null;
    truncated: boolean;
  };
  blockedEgress: Array<{
    host: string;
    port?: number;
    phase?: "setup" | "run";
    reason?: string;
    at?: string;
  }>;
  installedPackages: Array<{ name: string; version: string; manager?: string }>;
  /** Every file the run returned and what the file door made of it. */
  files: Array<{
    path: string;
    size?: number;
    sha256?: string;
    title?: string;
    status: "created" | "proposed" | "refused" | "not_stored";
    fileEntityId?: string;
    documentId?: string;
    proposalId?: string;
    error?: string;
  }>;
}

export const boxRuns = pgTable(
  "box_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    skillId: uuid("skill_id").references(() => skills.id, {
      onDelete: "set null",
    }),
    /** The requester: the person the run belongs to (read floor, lease floor). */
    userId: text("user_id").notNull(),
    /** The agent that asked for the run; null for the person's own run. */
    agentUserId: text("agent_user_id"),
    sessionId: uuid("session_id"),
    workspaceId: uuid("workspace_id"),
    /** The approved `capability.run` proposal that queued it, when there was one. */
    proposalId: uuid("proposal_id"),
    spec: jsonb("spec").$type<BoxRunSpec>().notNull(),
    parameters: jsonb("parameters")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status", { enum: BOX_RUN_STATUSES })
      .notNull()
      .default("queued"),
    /** Leases taken so far (a leased run whose lease expired is re-leased). */
    attempt: integer("attempt").notNull().default(0),
    /** The computer (machine agent user id) holding the lease. */
    leasedBy: text("leased_by"),
    /** Minted at each lease; heartbeat and finish must present it. */
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", {
      mode: "date",
      withTimezone: true,
    }),
    stopRequestedAt: timestamp("stop_requested_at", {
      mode: "date",
      withTimezone: true,
    }),
    evidence: jsonb("evidence").$type<BoxRunEvidence>(),
    /** A short sentence for a failed run (the evidence carries the detail). */
    error: text("error"),
    queuedAt: timestamp("queued_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    leasedAt: timestamp("leased_at", { mode: "date", withTimezone: true }),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    finishedAt: timestamp("finished_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    queueIdx: index("idx_box_runs_queue").on(table.userId, table.queuedAt),
    userQueuedIdx: index("idx_box_runs_user_queued").on(
      table.userId,
      table.queuedAt
    ),
    sessionIdx: index("idx_box_runs_session").on(table.sessionId),
    skillIdx: index("idx_box_runs_skill").on(table.skillId),
  })
);

export type BoxRunRow = typeof boxRuns.$inferSelect;
export type NewBoxRunRow = typeof boxRuns.$inferInsert;
