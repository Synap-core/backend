/**
 * The Inbox's filter control and its routine batch — ONE rule for the
 * desktop Inbox and relay's `/blocked` (moved from browser
 * `needs-you-triage-model.ts`, lane F2). Each fixture names the wrong rule
 * it rules out.
 */
import { describe, expect, it } from "vitest";
import {
  NEEDS_YOU_FILTERS,
  ROUTINE_BATCH_MIN,
  effectiveNeedsYouFilter,
  needsYouFilterView,
  needsYouFilters,
  readNeedsYouFilter,
  type NeedsYouBucket,
} from "./index.js";

type Row = { key: string; bucket: NeedsYouBucket };
const row = (key: string, bucket: NeedsYouBucket): Row => ({ key, bucket });
const keys = (rows: readonly Row[]) => rows.map((r) => r.key);

// Filed + ordered upstream (`needsYouBuckets`): the view never re-orders.
const ROWS: Row[] = [
  row("d1", "decision"),
  row("q1", "question"),
  row("b1", "broken"),
  row("r1", "routine"),
  row("r2", "routine"),
];

describe("needsYouFilterView — the filters and the routine batch", () => {
  it("All folds two or more routine changes into ONE batch (a per-row rule leaves them as rows)", () => {
    const v = needsYouFilterView(ROWS, "all");
    expect(keys(v.rows)).toEqual(["d1", "q1", "b1"]);
    expect(keys(v.batch)).toEqual(["r1", "r2"]);
  });

  it("a single routine change stays a row in All (a 'batch of one' is a row with an extra tap)", () => {
    const one = ROWS.filter((r) => r.key !== "r2");
    const v = needsYouFilterView(one, "all");
    expect(keys(v.rows)).toEqual(["d1", "q1", "b1", "r1"]);
    expect(v.batch).toEqual([]);
    expect(ROUTINE_BATCH_MIN).toBe(2);
  });

  it("Routine shows the batch, even of one (the filter IS the batch)", () => {
    const one = ROWS.filter((r) => r.key !== "r2");
    expect(needsYouFilterView(one, "routine")).toEqual({
      rows: [],
      batch: [row("r1", "routine")],
    });
  });

  it("a bucket filter narrows and never batches", () => {
    expect(needsYouFilterView(ROWS, "question")).toEqual({
      rows: [row("q1", "question")],
      batch: [],
    });
    expect(keys(needsYouFilterView(ROWS, "broken").rows)).toEqual(["b1"]);
  });
});

describe("needsYouFilters — zero-count filters are omitted", () => {
  it("All, then each bucket with rows, in the control's order", () => {
    expect(
      needsYouFilters({ decision: 2, question: 0, routine: 1, broken: 0 })
    ).toEqual(["all", "decision", "routine"]);
    expect(
      needsYouFilters({ decision: 0, question: 0, routine: 0, broken: 0 })
    ).toEqual(["all"]);
    expect(NEEDS_YOU_FILTERS).toEqual([
      "all",
      "decision",
      "question",
      "routine",
      "broken",
    ]);
  });

  it("an address names a filter; anything else is All (never hides rows)", () => {
    expect(readNeedsYouFilter("broken")).toBe("broken");
    expect(readNeedsYouFilter("routine")).toBe("routine");
    expect(readNeedsYouFilter("nonsense")).toBe("all");
    expect(readNeedsYouFilter(undefined)).toBe("all");
    expect(readNeedsYouFilter(["decision"])).toBe("all");
  });

  it("a chosen filter that emptied falls back to All (a deep link to an empty bucket is not a blank page)", () => {
    const counts = { decision: 1, question: 0, routine: 0, broken: 0 };
    expect(effectiveNeedsYouFilter("decision", counts)).toBe("decision");
    expect(effectiveNeedsYouFilter("question", counts)).toBe("all");
    expect(effectiveNeedsYouFilter("all", counts)).toBe("all");
  });
});

describe("needsYouFilterView — Review later is never batched", () => {
  type RlRow = Row & { signal: { reviewLater?: boolean } };
  const rl = (key: string, bucket: NeedsYouBucket, reviewLater = false): RlRow => ({
    key,
    bucket,
    signal: reviewLater ? { reviewLater: true } : {},
  });
  // Rules out "every routine row batches": a 9-day-old routine change would
  // be approved inside "Approve N" while the badge leaves it out.
  const PAGE = [
    rl("d1", "decision"),
    rl("r1", "routine"),
    rl("r2", "routine"),
    rl("old", "routine", true),
  ];
  it("All batches only the headline's routine changes; the old one stays a row to fold", () => {
    const v = needsYouFilterView(PAGE, "all");
    expect(keys(v.batch)).toEqual(["r1", "r2"]);
    expect(keys(v.rows)).toEqual(["d1", "old"]);
  });
  it("Routine: the same batch, the old one a row", () => {
    const v = needsYouFilterView(PAGE, "routine");
    expect(keys(v.batch)).toEqual(["r1", "r2"]);
    expect(keys(v.rows)).toEqual(["old"]);
  });
});
