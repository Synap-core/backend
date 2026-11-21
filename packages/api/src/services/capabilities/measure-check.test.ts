/**
 * `measure.check` (pathways P8): a criterion's KPI read by the pod. The pure
 * half (the arguments, the number each op yields, the comparison, the
 * sentence) and the read (which procedure, as whom, in which space), with the
 * routers stubbed: the procedures themselves are their own tests'.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<{
    router: string;
    proc: string;
    ctx: Record<string, unknown>;
    input: Record<string, unknown>;
  }>,
  answers: {} as Record<string, unknown>,
}));

function stubRouter(router: string) {
  return {
    createCaller: (ctx: Record<string, unknown>) =>
      new Proxy(
        {},
        {
          get: (_t, proc: string) => async (input: Record<string, unknown>) => {
            h.calls.push({ router, proc, ctx, input });
            return h.answers[`${router}.${proc}`];
          },
        }
      ),
  };
}

vi.mock("@synap/database", () => ({ db: { stub: true } }));
vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: stubRouter("entities"),
}));
vi.mock("../../routers/lifecycle.js", () => ({
  lifecycleRouter: stubRouter("lifecycle"),
}));
vi.mock("../../routers/signals.js", () => ({
  signalsRouter: stubRouter("signals"),
}));

import {
  compareMeasure,
  describeMeasure,
  isMeasureDetail,
  measureValue,
} from "./measure-check.js";
import { runMeasureCheck } from "./measure-check-read.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const SPACE = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  h.calls.length = 0;
  h.answers = {};
});

describe("measure.check — pure half", () => {
  it("compares with each comparator", () => {
    expect(compareMeasure(10, "gte", 10)).toBe(true);
    expect(compareMeasure(9, "gte", 10)).toBe(false);
    expect(compareMeasure(10, "gt", 10)).toBe(false);
    expect(compareMeasure(3, "lte", 3)).toBe(true);
    expect(compareMeasure(3, "lt", 3)).toBe(false);
    expect(compareMeasure(3, "eq", 3)).toBe(true);
  });

  it("each op yields its one number, or says why it has none", () => {
    expect(measureValue("entities.list", { total: 12 }, {})).toEqual({
      value: 12,
    });
    const board = {
      live: 5,
      columns: [
        { key: "open", count: 4 },
        { key: "won", count: 2 },
      ],
    };
    expect(measureValue("lifecycle.board", board, {})).toEqual({ value: 5 });
    expect(measureValue("lifecycle.board", board, { column: "won" })).toEqual({
      value: 2,
    });
    expect(
      measureValue("lifecycle.board", board, { column: "lost" })
    ).toHaveProperty("reason");
    expect(
      measureValue(
        "lifecycle.throughput",
        { buckets: [{ done: 1 }, { done: 0 }, { done: 3 }] },
        {}
      )
    ).toEqual({ value: 4 });
    expect(measureValue("attention.count", { needsYou: 6 }, {})).toEqual({
      value: 6,
    });
    // An answer with no count is never read as zero.
    expect(measureValue("entities.list", { items: [] }, {})).toHaveProperty(
      "reason"
    );
    expect(measureValue("attention.count", null, {})).toHaveProperty("reason");
  });

  it("says the grade in one sentence and knows a measure detail", () => {
    const d = {
      value: 7,
      threshold: 10,
      comparator: "gte" as const,
      op: "entities.list" as const,
    };
    expect(describeMeasure(d)).toBe(
      "entities.list counted 7; the bar is at least 10."
    );
    expect(isMeasureDetail(d)).toBe(true);
    expect(isMeasureDetail({ ...d, op: "entities.get" })).toBe(false);
    expect(isMeasureDetail("7 of 10")).toBe(false);
  });
});

describe("measure.check — the read", () => {
  it("reads as the caller, in the run's space, through the op's own procedure; the space is never a param", async () => {
    h.answers["entities.list"] = { total: 12, items: [] };
    const out = await runMeasureCheck(
      {
        op: "entities.list",
        params: { profileSlug: "meeting" },
        threshold: 10,
        // What the evaluator adds to every check verb: stripped here.
        sessionId: "s",
        criterionKey: "ten-meetings",
      },
      { userId: OWNER, workspaceId: SPACE }
    );
    expect(out).toEqual({
      passed: true,
      detail: {
        value: 12,
        threshold: 10,
        comparator: "gte",
        op: "entities.list",
      },
    });
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call!.router).toBe("entities");
    expect(call!.proc).toBe("list");
    // A person context: the owner's floor, no agent, not the hub door.
    expect(call!.ctx).toMatchObject({
      userId: OWNER,
      agentUserId: null,
      isHubProtocol: false,
    });
    expect(call!.input).toMatchObject({
      profileSlug: "meeting",
      workspaceId: SPACE,
      limit: 1,
    });
  });

  it("a board column, a throughput sum and a needs-you count each go to their procedure", async () => {
    h.answers["lifecycle.board"] = {
      live: 9,
      columns: [{ key: "won", count: 3 }],
    };
    h.answers["lifecycle.throughput"] = { buckets: [{ done: 2 }, { done: 2 }] };
    h.answers["signals.count"] = { needsYou: 4 };
    const board = await runMeasureCheck(
      {
        op: "lifecycle.board",
        params: { profileSlug: "deal", column: "won" },
        threshold: 3,
        comparator: "gte",
      },
      { userId: OWNER, workspaceId: null }
    );
    expect(board.passed).toBe(true);
    const thru = await runMeasureCheck(
      {
        op: "lifecycle.throughput",
        params: { profileSlug: "deal", bucket: "month", count: 3 },
        threshold: 5,
      },
      { userId: OWNER, workspaceId: SPACE }
    );
    expect(thru.detail.value).toBe(4);
    expect(thru.passed).toBe(false);
    const needs = await runMeasureCheck(
      {
        op: "attention.count",
        params: { profileSlug: "deal" },
        threshold: 5,
        comparator: "lt",
      },
      { userId: OWNER, workspaceId: SPACE }
    );
    expect(needs.passed).toBe(true);
    expect(h.calls.map((c) => `${c.router}.${c.proc}`)).toEqual([
      "lifecycle.board",
      "lifecycle.throughput",
      "signals.count",
    ]);
    expect(h.calls[0]!.input).toMatchObject({ column: "won", firstN: 0 });
    // A pod-wide run reads the owner's floor: no space stamped.
    expect(h.calls[0]!.input).not.toHaveProperty("workspaceId");
    expect(h.calls[1]!.input).toMatchObject({
      period: { bucket: "month", count: 3 },
    });
  });

  it("refuses a measure it cannot read, before any read", async () => {
    await expect(
      runMeasureCheck(
        { op: "entities.list", params: { workspaceId: SPACE }, threshold: 1 },
        { userId: OWNER, workspaceId: null }
      )
    ).rejects.toThrow();
    await expect(
      runMeasureCheck(
        { op: "sessions.list", threshold: 1 },
        { userId: OWNER, workspaceId: null }
      )
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
    // An answer without a count is an error (unmeasured), never a zero.
    h.answers["signals.count"] = {};
    await expect(
      runMeasureCheck(
        {
          op: "attention.count",
          params: { profileSlug: "deal" },
          threshold: 0,
        },
        { userId: OWNER, workspaceId: null }
      )
    ).rejects.toThrow(/without a count/);
  });
});
