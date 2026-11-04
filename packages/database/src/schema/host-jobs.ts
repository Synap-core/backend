/**
 * Host Jobs Schema (0399)
 *
 * ONE job for the host runner on a computer (`synap host serve`): install,
 * remove or update an installation, run a provider's computer-side op, or run
 * a hosted verb. The pod holds the queue, the lease and the evidence; the
 * computer pulls (`/host-jobs/lease`, key scope `host.runner`), heartbeats,
 * reports and finishes. The pod never opens a connection to the computer.
 *
 * The lease shape is `box_runs`' (0356), copied on purpose: `lease_id` is
 * minted at each lease and heartbeat/report/finish must present it, so a
 * runner whose lease expired (and was re-leased) is refused. A `running` job
 * whose lease expired is read as STALLED, never stored and never re-leased.
 *
 * `machine_user_id` is the computer that may lease the job: a computer leases
 * only jobs for installations on itself. `spec` is the job AS QUEUED (the
 * manifest snapshot, the op and its input): what the person approved runs.
 *
 * Read floor = the owner (`user_id`) within the workspace lens, as `box_runs`.
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
import { installations } from "./installations.js";
import { installationBindings } from "./installation-bindings.js";
import { skills } from "./skills.js";

/** What a host job does (plan 64072312 U4). */
export const HOST_JOB_KINDS = [
  "install",
  "remove",
  "update",
  "provider_op",
  "verb",
] as const;
export type HostJobKind = (typeof HOST_JOB_KINDS)[number];

/** Stored states, as `box_runs`. `stalled` is read, not stored. */
export const HOST_JOB_STATUSES = [
  "queued",
  "leased",
  "running",
  "done",
  "failed",
  "stopped",
] as const;
export type HostJobStatus = (typeof HOST_JOB_STATUSES)[number];

/** What the runner reported at finish, as stored. */
export interface HostJobEvidence {
  /** `timeout` and `infra` are stored as status `failed`. */
  verdict: "done" | "failed" | "stopped" | "timeout" | "infra";
  durationMs: number | null;
  infraReason?: string;
  /** Per step of the job (pull, start, health, …), in order. */
  steps: Array<{
    name: string;
    ok: boolean;
    detail?: string;
    durationMs?: number;
  }>;
  /** Logs, masked by the runner before sending. */
  log: {
    head: string;
    tail: string;
    totalBytes: number | null;
    truncated: boolean;
  };
  /** A provider op's contract output (`url`, `state`, `handle`, …). */
  output?: Record<string, unknown>;
  /** What the runner removed on a failure path ("leave nothing running"). */
  cleanedUp?: string[];
}

export const hostJobs = pgTable(
  "host_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind", { enum: HOST_JOB_KINDS }).notNull(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    /** The binding a `provider_op` job serves, when it serves one. */
    bindingId: uuid("binding_id").references(() => installationBindings.id, {
      onDelete: "set null",
    }),
    /** The hosted verb a `verb` / `provider_op` job runs, when there is one. */
    skillId: uuid("skill_id").references(() => skills.id, {
      onDelete: "set null",
    }),
    /** The owner: the person the job belongs to (read floor). */
    userId: text("user_id").notNull(),
    /** The computer that may lease it (`users.agent_type = 'machine'`). */
    machineUserId: text("machine_user_id").notNull(),
    /** The agent that asked for the job; null for the person's own. */
    agentUserId: text("agent_user_id"),
    sessionId: uuid("session_id"),
    workspaceId: uuid("workspace_id"),
    /** The approved proposal that queued it, when there was one. */
    proposalId: uuid("proposal_id"),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    parameters: jsonb("parameters")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status", { enum: HOST_JOB_STATUSES })
      .notNull()
      .default("queued"),
    attempt: integer("attempt").notNull().default(0),
    leasedBy: text("leased_by"),
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
    /** A person asked for this job's logs; the next heartbeat says so. */
    logsRequestedAt: timestamp("logs_requested_at", {
      mode: "date",
      withTimezone: true,
    }),
    /**
     * The last log the runner sent ON REQUEST (masked by the runner), while
     * the job runs or after; never pushed unasked.
     */
    log: jsonb("log").$type<HostJobEvidence["log"]>(),
    logReceivedAt: timestamp("log_received_at", {
      mode: "date",
      withTimezone: true,
    }),
    evidence: jsonb("evidence").$type<HostJobEvidence>(),
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
    queueIdx: index("idx_host_jobs_queue").on(
      table.machineUserId,
      table.queuedAt
    ),
    installationIdx: index("idx_host_jobs_installation").on(
      table.installationId,
      table.queuedAt
    ),
    userQueuedIdx: index("idx_host_jobs_user_queued").on(
      table.userId,
      table.queuedAt
    ),
  })
);

export type HostJobRow = typeof hostJobs.$inferSelect;
export type NewHostJobRow = typeof hostJobs.$inferInsert;
