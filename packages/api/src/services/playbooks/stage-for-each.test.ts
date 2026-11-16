/**
 * The pure half of a `forEach` step (`stage-for-each.ts`): which items, cut
 * how, and how many batches may start. The doors are driven on PGlite in
 * `routers/stage-for-each-run.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  PLAYBOOK_FOR_EACH_MAX_ITEMS,
  PLAYBOOK_FOR_EACH_PARALLEL,
} from "@synap/playbooks";
import {
  FAN_OUT_ORPHAN_MINUTES,
  batchParamValue,
  batchTitle,
  batchesToStart,
  failOrphanedBatches,
  forEachList,
  planFanOut,
} from "./stage-for-each.js";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `f${i + 1}`);
const plan = (forEach: Parameters<typeof planFanOut>[0], params = {}) => {
  const out = planFanOut(forEach, params, { shots: ["a", "b"] });
  if ("error" in out) throw new Error(out.error);
  return out.fanOut;
};

describe("planFanOut", () => {
  it("cuts 65 ids in batches of 30: 30, 30 and 5", () => {
    const f = plan({ over: "ids", batch: 30 }, { ids: ids(65) });
    expect(f.children.map((c) => c.items.length)).toEqual([30, 30, 5]);
    expect(f.children.every((c) => c.status === "queued")).toBe(true);
    expect(f).toMatchObject({ as: "item", batch: 30, total: 65 });
  });

  it("holds max and the pod-wide cap whatever the input says", () => {
    expect(
      plan({ over: "ids", max: 12, batch: 5 }, { ids: ids(70) }).children.map(
        (c) => c.items.length
      )
    ).toEqual([5, 5, 2]);
    const capped = plan({ over: "ids", batch: 50 }, { ids: ids(500) });
    expect(capped.total).toBe(500);
    expect(capped.children.flatMap((c) => c.items)).toHaveLength(
      PLAYBOOK_FOR_EACH_MAX_ITEMS
    );
  });

  it("reads the subject, and a text holding a JSON list", () => {
    expect(plan({ over: "subject.shots" }).children).toHaveLength(2);
    expect(
      plan({ over: "areas" }, { areas: '["x","y","z"]' }).children
    ).toHaveLength(3);
  });

  it("refuses what is not a list, saying which", () => {
    expect(planFanOut({ over: "ids" }, { ids: "f1, f2" }, null)).toEqual({
      error: '"ids" is not a list.',
    });
    expect(planFanOut({ over: "missing" }, {}, null)).toEqual({
      error: '"missing" names nothing on this run.',
    });
    expect(forEachList("{}")).toBeNull();
  });
});

describe("batchesToStart", () => {
  it("never lets more than three run", () => {
    const f = plan({ over: "ids" }, { ids: ids(7) });
    expect(PLAYBOOK_FOR_EACH_PARALLEL).toBe(3);
    expect(batchesToStart(f)).toEqual([0, 1, 2]);
    const twoRunning = {
      ...f,
      children: f.children.map((c, i) =>
        i < 2 ? { ...c, status: "running" as const } : c
      ),
    };
    expect(batchesToStart(twoRunning)).toEqual([2]);
    const ended = {
      ...twoRunning,
      children: twoRunning.children.map((c, i) =>
        i === 0 ? { ...c, status: "failed" as const } : c
      ),
    };
    expect(batchesToStart(ended)).toEqual([2, 3]);
  });
});

describe("batchParamValue", () => {
  it("passes one plain item as itself, a batch as JSON text", () => {
    expect(batchParamValue(["billing"], 1)).toBe("billing");
    expect(batchParamValue([{ id: "a" }], 1)).toBe('{"id":"a"}');
    expect(batchParamValue(["a", "b"], 30)).toBe('["a","b"]');
  });
});

describe("batchTitle", () => {
  it("names the step, the part and the items", () => {
    expect(
      batchTitle({ stageName: "Review", part: 2, parts: 3, items: ["f31"] })
    ).toBe("Review, part 2 of 3: f31");
    expect(
      batchTitle({
        stageName: "Review",
        part: 1,
        parts: 3,
        items: [{ id: "x", title: "Billing" }, { title: "Auth" }],
      })
    ).toBe("Review, part 1 of 3: Billing and 1 more");
    expect(
      batchTitle({ stageName: "Review", part: 1, parts: 1, items: [] })
    ).toBe("Review, part 1 of 1");
  });
});

describe("failOrphanedBatches", () => {
  const now = new Date("2026-11-10T12:00:00.000Z");
  const ago = (min: number) =>
    new Date(now.getTime() - min * 60_000).toISOString();
  const fanOut = (
    children: Parameters<typeof batchesToStart>[0]["children"]
  ) => ({
    over: "ids",
    as: "item",
    batch: 1,
    total: children.length,
    children,
  });

  it("fails a running batch with no run past the window; spares a fresh claim and a started one", () => {
    const f = fanOut([
      {
        items: ["a"],
        status: "running",
        claimedAt: ago(FAN_OUT_ORPHAN_MINUTES + 1),
      },
      { items: ["b"], status: "running", claimedAt: ago(1) },
      {
        items: ["c"],
        status: "running",
        sessionId: "s",
        claimedAt: ago(60),
      },
      { items: ["d"], status: "queued" },
    ]);
    const out = failOrphanedBatches(f, now);
    expect(out.children.map((c) => c.status)).toEqual([
      "failed",
      "running",
      "running",
      "queued",
    ]);
    expect(out.children[0]!.error).toMatch(/never started/);
  });

  it("returns the same fan-out when nothing is orphaned", () => {
    const f = fanOut([{ items: ["b"], status: "running", claimedAt: ago(1) }]);
    expect(failOrphanedBatches(f, now)).toBe(f);
  });
});
