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
  batchParamValue,
  batchesToStart,
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
