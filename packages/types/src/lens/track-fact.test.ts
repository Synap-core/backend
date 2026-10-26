/**
 * THE track header fact (0302): KPI first, else "Step N of M" while the
 * stages are the method's own, else nothing. Each row is chosen to rule a
 * rival rule out (see the comment on it).
 */
import { describe, expect, it } from "vitest";
import {
  LENS_KPI_STATED_OLD_AFTER_MS,
  formatKpiFraction,
  goalCriteriaCount,
  lensKpiFact,
  lensKpiStatedIsOld,
  lensScopeFactLabel,
  lensTrackFact,
} from "./index.js";

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

describe("formatKpiFraction — one spelling for the header and the nudge", () => {
  it("prints the unit after the fraction", () => {
    expect(formatKpiFraction(6, 10, "leads")).toBe("6 / 10 leads");
  });
  it.each([undefined, null, "", "  "])(
    "a unitless KPI (%j) leaves no dangling space",
    (unit) => {
      expect(formatKpiFraction(6, 10, unit)).toBe("6 / 10");
    }
  );
  it("rounds a fraction to two places", () => {
    expect(formatKpiFraction(2.345, 10)).toBe("2.35 / 10");
  });
});

// W5 (2026-10-23): the KPI age rule moved here from relay so the web header
// tones the same "stated …" fact by the same rule.
describe("lensKpiStatedIsOld — one rule for both headers", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("a value stated within the week is current; past it, old", () => {
    expect(
      lensKpiStatedIsOld(ago(LENS_KPI_STATED_OLD_AFTER_MS - 1000), now)
    ).toBe(false);
    expect(
      lensKpiStatedIsOld(ago(LENS_KPI_STATED_OLD_AFTER_MS + 1000), now)
    ).toBe(true);
  });

  it("the boundary is a week (rival: a day, a month)", () => {
    expect(LENS_KPI_STATED_OLD_AFTER_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(lensKpiStatedIsOld(ago(2 * 24 * 60 * 60 * 1000), now)).toBe(false);
    expect(
      lensKpiStatedIsOld(ago(8 * 24 * 60 * 60 * 1000), new Date(now))
    ).toBe(true);
  });

  it("never stated, or an unreadable date, is not old (nothing to tone)", () => {
    expect(lensKpiStatedIsOld(null, now)).toBe(false);
    expect(lensKpiStatedIsOld(undefined, now)).toBe(false);
    expect(lensKpiStatedIsOld("not a date", now)).toBe(false);
  });
});

describe("goalCriteriaCount — the goal's 'N of M met'", () => {
  it("counts met over every criterion (claimed is not met)", () => {
    const fact = goalCriteriaCount([
      { mark: "met" },
      { mark: "claimed" },
      { mark: "under_way" },
      { mark: "met" },
    ]);
    expect(fact).toEqual({ kind: "criteria", met: 2, total: 4 });
    expect(lensScopeFactLabel(fact!)).toBe("2 of 4 met");
  });

  it("an UNREAD mark is not a 'not met': the count is unknown (null)", () => {
    expect(goalCriteriaCount([{ mark: "met" }, { mark: null }])).toBeNull();
  });

  it("a lasting goal counts 0 of 0, which the label omits", () => {
    const fact = goalCriteriaCount([]);
    expect(fact).toEqual({ kind: "criteria", met: 0, total: 0 });
    expect(lensScopeFactLabel(fact!)).toBeNull();
  });
});
