/**
 * Persist a 5xx's exact cause (0392 `server_faults`), keyed by the errorId the
 * client was given, so a pod admin reads it without ssh (Hub
 * `GET /api/hub/errors/:errorId`, pod admin "Server errors").
 *
 * Called by the API's two error doors: the egress middleware
 * (`middleware/error-egress.ts`), which sees every REST 5xx, thrown or
 * returned, and tRPC's errorFormatter (`init-trpc.ts`), which owns tRPC's.
 * Both also put {@link faultCauseUrl} in the client body.
 *
 * Bounded on purpose, because it runs on the error path:
 *  - it never throws and never delays the answer (fire and forget; a failed
 *    write is logged, the cause stays in the log line beside it);
 *  - one process writes at most {@link FAULT_WRITES_PER_MINUTE} rows a minute:
 *    a fault storm (a broken route hit in a loop) still logs every fault, but
 *    fills no table;
 *  - rows older than {@link SERVER_FAULT_RETENTION_DAYS} days are pruned by the
 *    writer itself, at most once an hour per process.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  deleteExpiredServerFaults,
  insertServerFault,
  SERVER_FAULT_RETENTION_DAYS,
} from "@synap/database";
import type { DescribedFault } from "./describe-fault.js";
import { toPodAdminOrigin } from "../../utils/pod-admin-origin.js";

const logger = createLogger({ module: "server-faults" });

export const FAULT_WRITES_PER_MINUTE = 60;
const PRUNE_EVERY_MS = 60 * 60_000;

export interface ServerFaultRecord {
  errorId: string;
  door: "rest" | "trpc";
  method?: string | null;
  /** Already redacted (`redactSecretPath`). */
  path?: string | null;
  status: number;
  userId?: string | null;
  agentUserId?: string | null;
  fault: DescribedFault;
}

let windowStart = 0;
let writesInWindow = 0;
let lastPrune = 0;

/** For tests: forget the write budget and the prune clock. */
export function resetServerFaultBudget(): void {
  windowStart = 0;
  writesInWindow = 0;
  lastPrune = 0;
}

/**
 * Write the fault row. Resolves `true` when written, `false` when the minute's
 * budget was spent or the write failed; never rejects.
 */
export async function recordServerFault(
  rec: ServerFaultRecord,
  now: number = Date.now()
): Promise<boolean> {
  if (now - windowStart >= 60_000) {
    windowStart = now;
    writesInWindow = 0;
  }
  if (writesInWindow >= FAULT_WRITES_PER_MINUTE) return false;
  writesInWindow += 1;

  try {
    await insertServerFault(db, {
      errorId: rec.errorId,
      occurredAt: new Date(now),
      door: rec.door,
      method: rec.method ?? null,
      path: rec.path ?? null,
      status: rec.status,
      userId: rec.userId ?? null,
      agentUserId: rec.agentUserId ?? null,
      errorName: rec.fault.name,
      message: rec.fault.message,
      stack: rec.fault.stack,
      causes: rec.fault.causes,
    });
  } catch (err) {
    logger.warn(
      { err, errorId: rec.errorId },
      "Server fault not stored (its cause is in the log line beside it)"
    );
    return false;
  }

  if (now - lastPrune >= PRUNE_EVERY_MS) {
    lastPrune = now;
    void deleteExpiredServerFaults(
      db,
      SERVER_FAULT_RETENTION_DAYS,
      new Date(now)
    )
      .then((deleted) => {
        if (deleted > 0)
          logger.info({ deleted }, "Expired server faults deleted");
      })
      .catch((err) => logger.warn({ err }, "Server fault retention failed"));
  }
  return true;
}

/**
 * Where a pod admin reads the cause of `errorId` (a LINK, never the content,
 * which stays behind the pod-admin floor, `read.ts`): pod admin's page for it
 * when the console's origin can be derived (`toPodAdminOrigin`, the one rule
 * every approval link uses; pod admin's `serverErrorHref` builds the same
 * path), else the Hub read door on the pod's own origin, else the Hub path
 * alone. The pod's PUBLIC_URL first: behind a proxy the request URL is the
 * internal one.
 */
export function faultCauseUrl(errorId: string, requestUrl?: string): string {
  const id = encodeURIComponent(errorId);
  const hubPath = `/api/hub/errors/${id}`;
  let origin: string;
  try {
    const raw = process.env.PUBLIC_URL || requestUrl;
    if (!raw) return hubPath;
    origin = new URL(raw).origin;
  } catch {
    return hubPath;
  }
  const consoleOrigin = toPodAdminOrigin(origin);
  return consoleOrigin !== origin
    ? `${consoleOrigin}/errors/${id}`
    : `${origin}${hubPath}`;
}
