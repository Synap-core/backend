/**
 * The host-job wire: what a computer's host runner (`synap worker`) and
 * the pod say to each other over Hub REST (`/api/hub/host-jobs/*`). ONE
 * definition read by both sides: the pod's routes parse every body with these
 * schemas, and the runner (synap-cli, plan 64072312 U11) builds and checks its
 * calls with them.
 *
 *   POST /host-jobs/lease          LeaseBody      → { job: LeasedHostJob | null }
 *   POST /host-jobs/:id/heartbeat  HeartbeatBody  → HeartbeatAnswer
 *   POST /host-jobs/:id/report     ReportBody     → ReportAnswer
 *   POST /host-jobs/:id/finish     FinishBody     → FinishAnswer
 *   GET  /host-jobs/:id/logs                      → LogsAnswer (the owner)
 *
 * The lease protocol is the box runner's (`/box-runs/*`): a lease id minted
 * at each lease that every later call presents; a `phase: "running"`
 * heartbeat answered 200 is the moment the job starts and can never be
 * re-leased; a 409 means the lease went elsewhere, so the runner stops and
 * cleans up without finishing.
 *
 * ONE wire for both installation kinds (installer reconciliation f75fbb48
 * §3.2): a `service` reports its services' health, a `tool` its verify result
 * and the version, OS and arch it observed. The pod derives health and drift
 * from them; the runner never says "healthy" or "drifted".
 *
 * Logs never leave the computer unasked: the heartbeat answers
 * `logsRequested`, and the runner sends the masked log in its next report.
 *
 * Pure (zod only): no database, no Node API.
 */

import { z } from "zod";

/** What a host job does. Mirrors `host_jobs.kind` (0409). */
export const HOST_JOB_WIRE_KINDS = [
  "install",
  "remove",
  "update",
  "verify",
  "provider_op",
  "verb",
] as const;

/** Each log end, in UTF-8 bytes, as the box runner's. */
export const HOST_LOG_CAP = 64 * 1024;

/** A body is refused past this size (413). */
export const HOST_BODY_MAX_BYTES = 2 * 1024 * 1024;

const LeaseId = z.string().uuid();
const LogEnd = z.string().max(4 * HOST_LOG_CAP);

export const HostLogSchema = z.object({
  head: LogEnd.optional(),
  tail: LogEnd.optional(),
  totalBytes: z.number().int().nonnegative().nullable().optional(),
  truncated: z.boolean().optional(),
});

/**
 * The lease: the runner says what it can take and, on every lease, what the
 * computer is (`process.platform`, `process.arch`); the pod keeps them on the
 * computer so the placement check can read its processor before an install.
 */
export const HostJobLeaseBodySchema = z
  .object({
    os: z.string().min(1).max(32).optional(),
    arch: z.string().min(1).max(32).optional(),
    capacity: z
      .object({
        cpus: z.number().nonnegative().optional(),
        memoryMb: z.number().nonnegative().optional(),
        diskGb: z.number().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const HostJobHeartbeatBodySchema = z.object({
  leaseId: LeaseId,
  phase: z.enum(["setup", "running"]),
});

/** Mirrors `installations.kind` (0409). */
export const INSTALLATION_WIRE_KINDS = ["service", "tool"] as const;
export type InstallationWireKind = (typeof INSTALLATION_WIRE_KINDS)[number];

/** A verify excerpt is capped at this many characters (secrets masked). */
export const HOST_VERIFY_EXCERPT_MAX = 2000;

const VerifyExcerpt = z.string().max(HOST_VERIFY_EXCERPT_MAX);

/**
 * A tool's verify, as the runner ran it: the check's exit code, what it
 * printed (excerpt, masked), the output's hash, and the optional smoke run.
 * `ok` is the runner's reading of the manifest's `expect`. `exitCode` is
 * null when the check's program never started (the tool is not installed:
 * the most common failed check) or was stopped on its timeout.
 */
export const HostVerifySchema = z.object({
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  excerpt: VerifyExcerpt.optional(),
  outputSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  smoke: z
    .object({
      ok: z.boolean(),
      exitCode: z.number().int().nullable().optional(),
      excerpt: VerifyExcerpt.optional(),
    })
    .optional(),
});
export type HostVerify = z.output<typeof HostVerifySchema>;

/** What the runner observed on the computer (a tool; a service may send it). */
const ObservedFields = {
  observedVersion: z.string().max(128).nullable().optional(),
  os: z.string().min(1).max(32).optional(),
  arch: z.string().min(1).max(32).optional(),
  verify: HostVerifySchema.optional(),
};

/** One service's health as the runner checked it (127.0.0.1 only). */
const ServiceHealth = z.object({
  healthy: z.boolean(),
  detail: z.string().max(500).optional(),
  checkedAt: z.string().max(64).optional(),
});

export const HostJobReportBodySchema = z
  .object({
    leaseId: LeaseId,
    health: z
      .object({
        services: z.record(z.string().min(1).max(64), ServiceHealth),
        versions: z
          .record(
            z.string().min(1).max(64),
            z.object({
              digest: z.string().max(128).optional(),
              version: z.string().max(64).optional(),
            })
          )
          .optional(),
        ports: z
          .array(
            z.object({
              service: z.string().min(1).max(64),
              port: z.number().int().min(1).max(65535),
              host: z.literal("127.0.0.1"),
            })
          )
          .max(50)
          .optional(),
        disk: z
          .object({
            usedMb: z.number().nonnegative().optional(),
            freeMb: z.number().nonnegative().optional(),
          })
          .optional(),
      })
      .optional(),
    /** Sent only after a heartbeat answered `logsRequested`; masked. */
    log: HostLogSchema.optional(),
    ...ObservedFields,
  })
  .refine(
    (b) =>
      b.health !== undefined || b.log !== undefined || b.verify !== undefined,
    {
      message: "a report carries health, a verify result, a log, or several",
      path: ["health"],
    }
  );

export const HostJobFinishBodySchema = z
  .object({
    leaseId: LeaseId,
    status: z.enum(["done", "failed", "stopped", "timeout", "infra"]),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    infraReason: z.string().max(1000).optional(),
    steps: z
      .array(
        z.object({
          name: z.string().min(1).max(100),
          ok: z.boolean(),
          detail: z.string().max(1000).optional(),
          durationMs: z.number().int().nonnegative().optional(),
        })
      )
      .max(100)
      .optional(),
    log: HostLogSchema.optional(),
    /** A provider op's contract output (url, state, handle, …). */
    output: z.record(z.string(), z.unknown()).optional(),
    /** What the runner removed on a failure path. */
    cleanedUp: z.array(z.string().max(300)).max(100).optional(),
    /** A tool's install, update or verify: what the check saw. */
    ...ObservedFields,
  })
  .refine((b) => b.status !== "infra" || !!b.infraReason?.trim(), {
    message: "infraReason is required when status is infra",
    path: ["infraReason"],
  });

export type HostJobLeaseBody = z.input<typeof HostJobLeaseBodySchema>;
export type HostJobHeartbeatBody = z.input<typeof HostJobHeartbeatBodySchema>;
export type HostJobReportBody = z.input<typeof HostJobReportBodySchema>;
export type HostJobFinishBody = z.input<typeof HostJobFinishBodySchema>;
export type HostLog = z.output<typeof HostLogSchema>;

/** A leased job, as the lease route answers it. */
export interface LeasedHostJob {
  id: string;
  kind: (typeof HOST_JOB_WIRE_KINDS)[number];
  leaseId: string;
  leaseExpiresAt: string;
  heartbeatIntervalSeconds: number;
  attempt: number;
  queuedAt: string;
  installation: {
    id: string;
    /** `service` (compose services) or `tool` (per-OS install steps). */
    kind: InstallationWireKind;
    capabilityKey: string;
    capabilityVersion: string | null;
    upstreamVersion: string | null;
    /** The approved version: a repair installs this one again. */
    desiredVersion: string | null;
    /**
     * The manifest AS APPROVED: a service's compose comes from it only; a
     * tool's install/verify/uninstall steps are read from it only.
     */
    manifest: Record<string, unknown>;
    /** Service id → image digest. */
    digests: Record<string, string>;
  };
  bindingId: string | null;
  skillId: string | null;
  /** The job as queued (the op, its input). */
  spec: Record<string, unknown>;
  parameters: Record<string, unknown>;
}

export interface HostJobHeartbeatAnswer {
  leaseExpiresAt: string;
  stopRequested: boolean;
  /** A person asked for this job's logs: send them in the next report. */
  logsRequested: boolean;
}

export interface HostJobReportAnswer {
  installationId: string;
  /** The installation's stored status after the report. */
  status: string;
}

export interface HostJobFinishAnswer {
  id: string;
  status: "done" | "failed" | "stopped";
  installationStatus: string;
}

export interface HostJobLogsAnswer {
  id: string;
  status: string;
  log: HostLog | null;
  logReceivedAt: string | null;
  logsRequestedAt: string | null;
}
