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

import { randomUUID } from "node:crypto";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  db,
  deleteExpiredServerFaults,
  insertServerFault,
  SERVER_FAULT_RETENTION_DAYS,
} from "@synap/database";
import {
  describeFault,
  type DescribedError,
  type DescribedFault,
} from "./describe-fault.js";
import { redactSecrets } from "../../utils/redact-secrets.js";
import {
  CLASS_TRPC_CODE,
  type ProposalFailureMeta,
} from "../../routers/proposals/failure-classification.js";
import { toPodAdminOrigin } from "../../utils/pod-admin-origin.js";

const logger = createLogger({ module: "server-faults" });

export const FAULT_WRITES_PER_MINUTE = 60;
const PRUNE_EVERY_MS = 60 * 60_000;

export interface ServerFaultRecord {
  errorId: string;
  /**
   * Which door answered: `rest` (Hono), `trpc`, or `proposal` (an approval
   * that failed, {@link recordProposalFault}; `path` names the proposal).
   */
  door: "rest" | "trpc" | "proposal";
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
 * Keep the exact cause of a failed approval for the pod's owner (plan 8032a127
 * D5, finding 7ca4953f): the proposal stores a safe sentence and, for agents, a
 * redacted `detail`; the error itself and its stack were kept nowhere a person
 * could read without ssh. Called by every writer of `approval_failed` (the
 * approve door's two failure writes in `apply-approval.ts`, the receipt's in
 * `stamp-materialized.ts`), which then put ONLY the returned id on the row
 * (`data.failure.errorId`): reading what it names takes pod-admin rights
 * (`read.ts`).
 *
 * Redaction: `describeFault`'s (a query's bound values, a URL's credential
 * parameters, a bearer token), then `redactSecrets`, the scrubber every
 * stored approval error already goes through: an approval's error is often a
 * provider body echoing the credential that produced it (`sk-…`, a quoted
 * `"api_key"`), which a 5xx's rarely is. Whitespace and stack frames are kept.
 *
 * `status` is the HTTP status of the error the approval answered with
 * (`CLASS_TRPC_CODE` of its class), so the column keeps its meaning. Resolves
 * the errorId only when the row was written; `undefined` when the minute's
 * budget was spent or the write failed, so a proposal never points at a fault
 * that does not exist. Never rejects.
 */
export async function recordProposalFault(args: {
  proposalId: string;
  err: unknown;
  meta: Pick<ProposalFailureMeta, "errorClass">;
  /** The person on whose behalf it ran (the approver, or the receipt's owner). */
  userId?: string | null;
  agentUserId?: string | null;
}): Promise<string | undefined> {
  const errorId = randomUUID();
  const described = describeFault(args.err);
  const scrub = <E extends DescribedError>(e: E): E => ({
    ...e,
    message: redactSecrets(e.message),
    stack: e.stack === null ? null : redactSecrets(e.stack),
  });
  const written = await recordServerFault({
    errorId,
    door: "proposal",
    path: `/proposal/${args.proposalId}`,
    status: getHTTPStatusCodeFromError(
      new TRPCError({
        code: CLASS_TRPC_CODE[args.meta.errorClass ?? "unknown"],
      })
    ),
    userId: args.userId,
    agentUserId: args.agentUserId,
    fault: { ...scrub(described), causes: described.causes.map(scrub) },
  });
  return written ? errorId : undefined;
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
