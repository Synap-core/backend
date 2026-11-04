/**
 * Import Units Worker (store-first bulk import, background)
 *
 * One job stores a whole store-first import: N units (an entity each, plus an
 * optional source file already PUT to storage through a presigned URL). It
 * replaces N `POST /import/store-unit` requests, each paced against the hub
 * rate limit, with ONE `POST /import/enqueue-units` and one queue run.
 *
 * Each unit goes through the SAME door `/import/store-unit` uses
 * (`storeImportUnit`, @synap/api): the governed create, then the attach gate.
 * Governance stays per unit: a unit the ladder parks is `proposed`, never a
 * failure, and never written directly.
 *
 * Inversion of Control, like `import-corpus-worker.ts`: jobs must not import
 * @synap/api, so this module owns the queue, the payload and output contracts
 * and a handler slot; the api fills the slot at boot
 * (apps/api/src/process-role/background-starters.ts).
 *
 * Queue: "import-units". A long, non-idempotent walk: created with
 * retryLimit 0 and its own expiry (LONG_WALK_QUEUES in ./index.ts), so a run
 * still executing is never redelivered. Each unit also carries the create
 * door's idempotency key, so a unit submitted again lands on its first entity.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "import-units-worker" });

export const IMPORT_UNITS_QUEUE = "import-units";

/**
 * How long one run may hold the queue before pg-boss expires it (it is never
 * retried). Four hours covers thousands of units at the per-unit cost of a
 * governed create plus an attach.
 */
export const IMPORT_UNITS_EXPIRE_SECONDS = 4 * 60 * 60;

/** One unit of the manifest, as `POST /import/enqueue-units` validated it. */
export interface ImportUnitsJobUnit {
  /** The caller's stable id for the unit (unique in the manifest). */
  key: string;
  title: string;
  profileSlug: string;
  content?: string;
  description?: string;
  properties?: Record<string, unknown>;
  /** A token from `POST /import/unit-uploads` whose object holds the file. */
  uploadToken?: string;
}

export interface ImportUnitsPayload {
  userId: string;
  /** Explicit pin for every unit; null = each kind's own placement. */
  workspaceId: string | null;
  /** The hub write source the units are stamped with (`cli`, …). */
  source: string;
  units: ImportUnitsJobUnit[];
  /**
   * The submitting request's acting context, replayed for every unit so the
   * job is governed exactly as the request would have been: the key's scopes
   * and confinement, the acting agent, the verified session, the calling key
   * and the key's grant (the write gate reads it from the request scope, so a
   * job that dropped it would write with LESS restriction than its submitter).
   */
  scopes: string[];
  agentUserId?: string | null;
  sessionId?: string | null;
  keyType?: string | null;
  keyWorkspaceId?: string | null;
  apiKeyId?: string | null;
  grant?: unknown;
}

/** What happened to one unit. `proposed` is governance working, not a failure. */
export type ImportUnitOutcome =
  | {
      status: "stored";
      entityId: string;
      audio: boolean;
      audioSkippedReason: string | null;
    }
  | {
      status: "proposed";
      proposalId: string | null;
      audioSkippedReason: string | null;
    }
  | { status: "failed"; error: string };

/** The job `output`: per-unit outcome by unit key, and the counts. */
export interface ImportUnitsResult {
  total: number;
  stored: number;
  proposed: number;
  failed: number;
  results: Record<string, ImportUnitOutcome>;
}

type Handler = (p: ImportUnitsPayload) => Promise<ImportUnitsResult>;

let handler: Handler | null = null;

/** Filled by the api layer at boot — jobs never imports the unit door itself. */
export function registerImportUnitsHandler(fn: Handler): void {
  handler = fn;
}

/**
 * Runs the registered handler and RETURNS its result: pg-boss stores what the
 * work callback resolves to as the job `output`, which
 * `GET /import/units-job/:jobId` reads back.
 */
export async function handleImportUnits(
  job: PgBoss.Job<ImportUnitsPayload>
): Promise<ImportUnitsResult> {
  const startedAt = Date.now();
  const { userId, units } = job.data;
  if (!handler) {
    throw new Error("import-units handler not registered");
  }
  const result = await handler(job.data);
  logger.info(
    {
      userId,
      total: units?.length ?? 0,
      stored: result.stored,
      proposed: result.proposed,
      failed: result.failed,
      durationMs: Date.now() - startedAt,
    },
    "Import units run finished"
  );
  return result;
}
