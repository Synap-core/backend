/**
 * `measure.check`'s READ: run one cell-bridge read op server-side, through the
 * SAME tRPC procedure each page host maps it to (pod-admin
 * `html-bridge-reads.ts`, the desktop's Hub REST twins), and compare the one
 * number it yields with the criterion's bar. Never a second query engine.
 *
 * WHO READS: `ctx.userId` in a person context (no agent, not the hub door),
 * exactly like `lens.page`. In an evaluation that is the session OWNER
 * (`evaluate.ts` passes the owner as the run's user), so a measure sees what
 * the owner sees and never more. THE SPACE is the run's (`ctx.workspaceId`:
 * the session's), stamped here; a measure's params never carry it
 * (`pickBridgeParams` drops it). A pod-wide run reads the owner's floor.
 *
 * Every refusal is a thrown error, so the evaluator records the criterion as
 * UNMEASURED with the reason, never as a failure (`capabilityVerdict`).
 */

import { db } from "@synap/database";
import { pickBridgeParams } from "@synap-core/types/cell-bridge";
import type { Context } from "../../context.js";
import type { BuiltinVerbContext } from "./builtin-verbs.js";
import {
  compareMeasure,
  measureCheckParams,
  measureValue,
  type MeasureDetail,
  type MeasureOp,
} from "./measure-check.js";

type Params = Record<string, string | number | boolean>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const bool = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;
function int(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}
function defined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined)
  ) as T;
}

/** The answer of one measure op, read as `userId` in `workspaceId`. */
async function readOp(
  op: MeasureOp,
  p: Params,
  lens: { userId: string; workspaceId: string | null }
): Promise<unknown> {
  const callerCtx = {
    db,
    authenticated: true,
    userId: lens.userId,
    workspaceId: null,
    agentUserId: null,
    isHubProtocol: false,
  } as unknown as Context;
  const ws = lens.workspaceId ?? undefined;
  switch (op) {
    case "entities.list": {
      const { entitiesRouter } = await import("../../routers/entities.js");
      const entities = entitiesRouter.createCaller(callerCtx);
      // `total` counts every match; one row is enough to get it.
      return entities.list(
        defined({
          profileSlug: str(p.profileSlug),
          facetSlug: str(p.facetSlug),
          includeDescendants: bool(p.includeDescendants),
          limit: 1,
          offset: 0,
          workspaceId: ws,
        })
      );
    }
    case "lifecycle.board": {
      const { lifecycleRouter } = await import("../../routers/lifecycle.js");
      const lifecycle = lifecycleRouter.createCaller(callerCtx);
      const days = int(p.windowDays, 1, 366);
      return lifecycle.board(
        defined({
          profileSlug: str(p.profileSlug)!,
          trackId: str(p.trackId),
          window: days ? { days } : undefined,
          // Counts only: no cards.
          firstN: 0,
          column: str(p.column),
          limit: str(p.column) ? 1 : undefined,
          workedBy: bool(p.workedBy),
          workspaceId: ws,
        })
      );
    }
    case "lifecycle.throughput": {
      const { lifecycleRouter } = await import("../../routers/lifecycle.js");
      const lifecycle = lifecycleRouter.createCaller(callerCtx);
      const bucket = str(p.bucket);
      const count = int(p.count, 1, 366);
      return lifecycle.throughput(
        defined({
          profileSlug: str(p.profileSlug)!,
          trackId: str(p.trackId),
          period:
            bucket || count
              ? {
                  // The procedure validates it (day | week | month).
                  bucket: (bucket ?? "week") as "day" | "week" | "month",
                  count: count ?? 12,
                }
              : undefined,
          workspaceId: ws,
        })
      );
    }
    case "attention.count": {
      const { signalsRouter } = await import("../../routers/signals.js");
      const signals = signalsRouter.createCaller(callerCtx);
      return signals.count(
        defined({
          profileSlug: str(p.profileSlug),
          trackId: str(p.trackId),
          workspaceId: ws,
        })
      );
    }
  }
}

/**
 * The verb: parse the measure, read the op, compare. Returns
 * `{ passed, detail: { value, threshold, comparator, op } }`.
 */
export async function runMeasureCheck(
  raw: Record<string, unknown>,
  ctx: Pick<BuiltinVerbContext, "userId" | "workspaceId">
): Promise<{ passed: boolean; detail: MeasureDetail }> {
  const spec = measureCheckParams.parse(raw);
  const comparator = spec.comparator ?? "gte";
  const params = pickBridgeParams(spec.op, spec.params ?? {});
  const answer = await readOp(spec.op, params, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const measured = measureValue(spec.op, answer, params);
  if ("reason" in measured) throw new Error(measured.reason);
  return {
    passed: compareMeasure(measured.value, comparator, spec.threshold),
    detail: {
      value: measured.value,
      threshold: spec.threshold,
      comparator,
      op: spec.op,
    },
  };
}
