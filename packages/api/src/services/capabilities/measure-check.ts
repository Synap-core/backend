/**
 * `measure.check` — a criterion's KPI MEASURED by the pod, never typed by hand
 * (pathways plan P8, option a). A capability criterion names the verb and its
 * arguments on `check.params`:
 *
 *   check: { kind: "capability", capability: "measure.check",
 *            params: { op: "entities.list", params: { profileSlug: "meeting" },
 *                      threshold: 10, comparator: "gte" } }
 *
 * The verb runs ONE existing read op of the cell bridge
 * (`CELL_BRIDGE_READ_OPS`, `@synap-core/types/cell-bridge`: the table every
 * page host reads through), never a second query engine: the op's params are
 * that table's own list, and the read is the same tRPC procedure the hosts
 * call (`measure-check-read.ts`). It reads as the person the run is for (in
 * an evaluation, the session OWNER), in the run's space, under their floor.
 *
 * This file is the PURE half (the argument schema, the number each op
 * yields, the comparison, the sentence), so the criteria write door can
 * refuse a misspelled measure without loading a router.
 */

import { z } from "zod";
import {
  CELL_BRIDGE_READ_OPS,
  type CellBridgeReadOp,
} from "@synap-core/types/cell-bridge";

export const MEASURE_CHECK_VERB = "measure.check";

/**
 * The read ops a measure may run: the ones whose answer holds a count. Each
 * yields ONE number ({@link measureValue}):
 *   entities.list        — `total`: the things of that kind you can see;
 *   lifecycle.board      — with `column`, that status's count; else `live`;
 *   lifecycle.throughput — the things that reached done, summed over the period;
 *   attention.count      — `needsYou`: what waits on the person.
 */
export const MEASURE_OPS = [
  "entities.list",
  "lifecycle.board",
  "lifecycle.throughput",
  "attention.count",
] as const satisfies readonly CellBridgeReadOp[];
export type MeasureOp = (typeof MEASURE_OPS)[number];

export const MEASURE_COMPARATORS = ["gte", "lte", "eq", "gt", "lt"] as const;
export type MeasureComparator = (typeof MEASURE_COMPARATORS)[number];

/** The ops whose read needs a kind (`profileSlug`), as every host asks it. */
const NEEDS_PROFILE: ReadonlySet<MeasureOp> = new Set<MeasureOp>([
  "lifecycle.board",
  "lifecycle.throughput",
  "attention.count",
]);

const measureShape = {
  /** The read op (`MEASURE_OPS`). */
  op: z.enum(MEASURE_OPS),
  /** The op's own params (`CELL_BRIDGE_READ_OPS[op]`), never the space. */
  params: z
    .record(
      z.string(),
      z.union([z.string().min(1).max(200), z.number(), z.boolean()])
    )
    .optional(),
  /** The bar the measured number is compared with. */
  threshold: z.number(),
  /** How it is compared; default `gte` (at least). */
  comparator: z.enum(MEASURE_COMPARATORS).optional(),
};

type MeasureSpecShape = z.infer<z.ZodObject<typeof measureShape>>;

function refineMeasure(m: MeasureSpecShape, ctx: z.RefinementCtx): void {
  const allowed = CELL_BRIDGE_READ_OPS[m.op] as readonly string[];
  for (const name of Object.keys(m.params ?? {})) {
    // A misspelled param would measure something else, silently: refuse it.
    if (!allowed.includes(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["params", name],
        message: `"${m.op}" takes ${allowed.join(", ") || "no params"}; "${name}" is not one of them`,
      });
    }
  }
  if (NEEDS_PROFILE.has(m.op) && typeof m.params?.profileSlug !== "string") {
    ctx.addIssue({
      code: "custom",
      path: ["params", "profileSlug"],
      message: `"${m.op}" measures one kind: give params.profileSlug`,
    });
  }
}

/**
 * The arguments as a criterion stores them (`check.params`): strict, so a
 * misspelled `comparator` is refused at the write door rather than read as
 * the default.
 */
export const measureSpecSchema = z
  .strictObject(measureShape)
  .superRefine(refineMeasure);

/**
 * The verb's own parse: the same fields, other keys stripped (the evaluator
 * also passes `sessionId`, `criterionKey` and `outcome` to every check verb).
 */
export const measureCheckParams = z
  .object(measureShape)
  .superRefine(refineMeasure);

export type MeasureSpec = z.infer<typeof measureSpecSchema>;

/** What a measure reports beside `passed`: recorded as the grade's evidence. */
export interface MeasureDetail {
  value: number;
  threshold: number;
  comparator: MeasureComparator;
  op: MeasureOp;
}

export function compareMeasure(
  value: number,
  comparator: MeasureComparator,
  threshold: number
): boolean {
  switch (comparator) {
    case "gte":
      return value >= threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
    case "gt":
      return value > threshold;
    case "lt":
      return value < threshold;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The ONE number an op's answer yields, or why it yields none. Pure: the
 * answer is what the procedure returned.
 */
export function measureValue(
  op: MeasureOp,
  answer: unknown,
  params: Readonly<Record<string, unknown>>
): { value: number } | { reason: string } {
  if (!isRecord(answer)) return { reason: `"${op}" answered nothing` };
  let value: number | null = null;
  switch (op) {
    case "entities.list":
      value = num(answer.total);
      break;
    case "lifecycle.board": {
      const column = params.column;
      if (typeof column === "string") {
        const columns = Array.isArray(answer.columns) ? answer.columns : [];
        const hit = columns.find((c) => isRecord(c) && c.key === column) as
          | Record<string, unknown>
          | undefined;
        if (!hit) return { reason: `the board has no column "${column}"` };
        value = num(hit.count);
      } else {
        value = num(answer.live);
      }
      break;
    }
    case "lifecycle.throughput": {
      const buckets = Array.isArray(answer.buckets) ? answer.buckets : null;
      if (!buckets) break;
      value = 0;
      for (const b of buckets) {
        const done = isRecord(b) ? num(b.done) : null;
        if (done === null) {
          value = null;
          break;
        }
        value += done;
      }
      break;
    }
    case "attention.count":
      value = num(answer.needsYou);
      break;
  }
  return value === null
    ? { reason: `"${op}" answered without a count` }
    : { value };
}

const COMPARATOR_WORDS: Record<MeasureComparator, string> = {
  gte: "at least",
  lte: "at most",
  eq: "exactly",
  gt: "more than",
  lt: "less than",
};

/** The grade's one line: "entities.list counted 12; the bar is at least 10." */
export function describeMeasure(d: MeasureDetail): string {
  return `${d.op} counted ${d.value}; the bar is ${COMPARATOR_WORDS[d.comparator]} ${d.threshold}.`;
}

/** A `detail` a measure returned (the evaluator reads a verb's result). */
export function isMeasureDetail(v: unknown): v is MeasureDetail {
  return (
    isRecord(v) &&
    num(v.value) !== null &&
    num(v.threshold) !== null &&
    (MEASURE_COMPARATORS as readonly unknown[]).includes(v.comparator) &&
    (MEASURE_OPS as readonly unknown[]).includes(v.op)
  );
}
