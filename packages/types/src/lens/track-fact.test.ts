/**
 * THE track header fact (0302): KPI first, else "Step N of M" while the
 * stages are the method's own, else nothing. Each row is chosen to rule a
 * rival rule out (see the comment on it).
 */
import { describe, expect, it } from "vitest";
import { lensKpiFact, lensScopeFactLabel, lensTrackFact } from "./index.js";

const pinned = [{ key: "a" }, { key: "b" }, { key: "c" }];

describe("lensTrackFact", () => {
  it("a KPI wins over the step (rival: step first)", () => {
    const fact = lensTrackFact({
      kpi: { label: "Qualified leads per month", target: 10, current: 6 },
      stages: pinned,
      currentStage: "b",
    });
    expect(fact?.kind).toBe("kpi");
    expect(lensScopeFactLabel(fact!)).toBe("Qualified leads per month 6 / 10");
  });

  it("no KPI, method's own stages ⇒ Step N of M", () => {
    expect(
      lensTrackFact({ kpi: null, stages: pinned, currentStage: "b" })
    ).toEqual({ kind: "step", index: 2, total: 3 });
  });

  it("an EMERGED stage drops the step (rival: count the stages anyway)", () => {
    expect(
      lensTrackFact({
        kpi: null,
        stages: [...pinned, { key: "d", addedAt: "2026-10-05T10:00:00Z" }],
        currentStage: "b",
      })
    ).toBeNull();
  });

  it("an emerged stage does NOT drop a KPI (rival: emergence blanks the fact)", () => {
    expect(
      lensTrackFact({
        kpi: { label: "Leads", target: 10 },
        stages: [{ key: "d", addedAt: "2026-10-05T10:00:00Z" }],
        currentStage: "d",
      })?.kind
    ).toBe("kpi");
  });

  it("a malformed KPI is no KPI — it falls through to the step", () => {
    expect(
      lensTrackFact({
        kpi: { label: "  ", target: 10 },
        stages: pinned,
        currentStage: "a",
      })
    ).toEqual({ kind: "step", index: 1, total: 3 });
  });

  it("standing on no pinned stage ⇒ nothing", () => {
    expect(
      lensTrackFact({ kpi: null, stages: pinned, currentStage: "zzz" })
    ).toBeNull();
  });
});

describe("lensKpiFact — current is STATED, never invented", () => {
  it("no current ⇒ no bar, no statedAt, and the label says only the target", () => {
    const f = lensKpiFact({ label: "Leads", unit: "/mo", target: 10 })!;
    expect(f.current).toBeNull();
    expect(f.progress).toBeNull();
    expect(f.statedAt).toBeNull();
    expect(f.reached).toBe(false);
    expect(lensScopeFactLabel(f)).toBe("Leads: target 10 /mo");
  });

  it("a stated current carries when it was stated; progress clamps to 1", () => {
    const f = lensKpiFact({
      label: "Leads",
      target: 10,
      current: 12,
      updatedAt: "2026-10-05T09:00:00Z",
    })!;
    expect(f.progress).toBe(1);
    expect(f.reached).toBe(true);
    expect(f.statedAt).toBe("2026-10-05T09:00:00Z");
  });

  it("a zero current is a real value (rival: falsy ⇒ absent)", () => {
    const f = lensKpiFact({ label: "Leads", target: 10, current: 0 })!;
    expect(f.current).toBe(0);
    expect(f.progress).toBe(0);
    expect(lensScopeFactLabel(f)).toBe("Leads 0 / 10");
  });
});
