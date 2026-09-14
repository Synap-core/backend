/**
 * `capture.structure` progress scope.
 *
 * With a `captureRunId` in the input, the procedure runs inside an
 * AsyncLocalStorage reporter (`utils/structure-progress-bus.ts`) so the call
 * sites deep in the procedure can report real stages, and the call finishes
 * with a `done{outcome}` frame derived from the result SHAPE.
 *
 * It NEVER modifies the result and adds no exit: `next()`'s result is returned
 * as-is, and a thrown call re-throws after `done{degraded}`. Without a
 * `captureRunId` it is a pass-through (no reporter, so every call-site hunk is
 * a no-op and the IS request carries no progress header).
 *
 * Must sit AFTER `.input(...)`: it reads the parsed input.
 */
import type { StructureOutcome } from "@synap-core/types/capture";
import { t } from "../init-trpc.js";
import {
  attachStructureProgressReporter,
  runWithStructureProgress,
} from "../utils/structure-progress-bus.js";

/** The run's outcome, read from the response shape `capture.structure` returns. */
export function structureOutcomeOf(data: unknown): StructureOutcome {
  const r = (data ?? {}) as {
    degraded?: unknown;
    followUp?: unknown;
    proposals?: unknown;
  };
  if (r.degraded === true) return "degraded";
  if (r.followUp !== null && r.followUp !== undefined) return "follow_up";
  if (Array.isArray(r.proposals) && r.proposals.length > 0) return "plan";
  return "empty";
}

export const structureProgressMiddleware = t.middleware(async (opts) => {
  const { captureRunId, file } = (opts.input ?? {}) as {
    captureRunId?: unknown;
    file?: unknown;
  };
  const userId = opts.ctx.userId;
  if (typeof captureRunId !== "string" || typeof userId !== "string") {
    return opts.next();
  }

  const reporter = attachStructureProgressReporter(userId, captureRunId);
  // Text needs no read: the step is current from the first instant. A file's
  // read is the IS extraction, reported by the IS itself.
  if (!file) reporter.stage("reading");

  try {
    const result = await runWithStructureProgress(reporter, () => opts.next());
    reporter.done(result.ok ? structureOutcomeOf(result.data) : "degraded");
    return result;
  } catch (err) {
    reporter.done("degraded");
    throw err;
  }
});
