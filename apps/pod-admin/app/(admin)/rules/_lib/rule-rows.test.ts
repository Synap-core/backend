import { describe, expect, it } from "vitest";
import {
  neverRanCallout,
  ruleCounts,
  ruleFilterOf,
  ruleIsFailing,
  ruleMatches,
  ruleNeverRan,
  rulePill,
  ruleRowAction,
  runResultMessage,
  runsPhrase,
  type RuleFacts,
  type RuleHealth,
} from "./rule-rows";

function rule(over: Partial<RuleFacts> = {}): RuleFacts {
  return {
    id: "r1",
    name: "Inbox to tasks",
    status: "active",
    triggerType: "event",
    lastRunAt: "2026-10-12T10:00:00.000Z",
    runCount: 10,
    failureCount: 0,
    ...over,
  };
}

const ok: RuleHealth = { latestStatus: "completed", recentFailedCount: 0 };
const failedLast: RuleHealth = { latestStatus: "failed", recentFailedCount: 2 };
const failedEarlier: RuleHealth = {
  latestStatus: "completed",
  recentFailedCount: 1,
};

describe("ruleFilterOf", () => {
  it("reads every receiver key, including never-ran", () => {
    expect(ruleFilterOf("never-ran")).toBe("never-ran");
    expect(ruleFilterOf("failing")).toBe("failing");
    expect(ruleFilterOf("drafts")).toBe("drafts");
  });
  it("defaults anything else to active", () => {
    expect(ruleFilterOf(null)).toBe("active");
    expect(ruleFilterOf("bogus")).toBe("active");
  });
});

describe("ruleNeverRan — diagnose's predicate", () => {
  it("is an active or draft rule with no run and no last run", () => {
    const idle = { runCount: 0, lastRunAt: null };
    expect(ruleNeverRan(rule(idle))).toBe(true);
    expect(ruleNeverRan(rule({ ...idle, status: "draft" }))).toBe(true);
    expect(ruleNeverRan(rule({ ...idle, status: "paused" }))).toBe(false);
    expect(ruleNeverRan(rule())).toBe(false);
  });
});

describe("ruleIsFailing — reads this week, not the lifetime counter", () => {
  it("is failing when stopped on an error", () => {
    expect(ruleIsFailing(rule({ status: "error" }), undefined)).toBe(true);
  });
  it("is failing when a live rule failed this week", () => {
    expect(ruleIsFailing(rule(), failedEarlier)).toBe(true);
  });
  it("is not failing on old failures alone", () => {
    expect(ruleIsFailing(rule({ failureCount: 271 }), ok)).toBe(false);
  });
  it("is not failing while paused", () => {
    expect(ruleIsFailing(rule({ status: "paused" }), failedLast)).toBe(false);
  });
});

describe("ruleCounts / ruleMatches", () => {
  it("counts overlapping filters (a failing rule is also active)", () => {
    const rules = [
      rule({ id: "a" }),
      rule({ id: "b" }),
      rule({ id: "c", status: "paused" }),
      rule({ id: "d", status: "draft", runCount: 0, lastRunAt: null }),
    ];
    const health = new Map([["b", failedLast]]);
    expect(ruleCounts(rules, (id) => health.get(id))).toEqual({
      active: 2,
      failing: 1,
      "never-ran": 1,
      paused: 1,
      drafts: 1,
    });
    expect(ruleMatches("failing", rules[1]!, failedLast)).toBe(true);
  });
});

describe("rulePill", () => {
  it("says what state the rule is in", () => {
    expect(rulePill(rule({ status: "error" }), undefined)).toEqual({
      kind: "down",
      label: "Stopped on error",
    });
    expect(rulePill(rule(), failedLast)).toEqual({
      kind: "down",
      label: "Failed last run",
    });
    expect(rulePill(rule(), failedEarlier)).toEqual({
      kind: "stale",
      label: "1 failure",
    });
    expect(rulePill(rule(), ok)).toEqual({ kind: "healthy", label: "Working" });
    expect(rulePill(rule({ runCount: 0, lastRunAt: null }), undefined)).toEqual(
      { kind: "unknown", label: "Never ran" }
    );
  });
});

describe("ruleRowAction — one act per row", () => {
  it("offers Run now on a failing rule the pod would run", () => {
    expect(ruleRowAction(rule(), failedLast)).toBe("run");
  });
  it("offers no run on a rule stopped on an error unless it is manual", () => {
    expect(ruleRowAction(rule({ status: "error" }), undefined)).toBeNull();
    expect(
      ruleRowAction(rule({ status: "error", triggerType: "manual" }), undefined)
    ).toBe("run");
  });
  it("offers Pause on a working live rule, nothing on a paused one", () => {
    expect(ruleRowAction(rule(), ok)).toBe("pause");
    expect(ruleRowAction(rule({ status: "paused" }), ok)).toBeNull();
  });
});

describe("phrases", () => {
  it("says the lifetime counters once", () => {
    expect(runsPhrase(rule({ runCount: 4332, failureCount: 0 }))).toBe(
      "4,332 runs"
    );
    expect(runsPhrase(rule({ runCount: 6, failureCount: 1 }))).toBe(
      "6 runs · 1 failed"
    );
    expect(runsPhrase(rule({ runCount: 0 }))).toBe("No runs yet");
  });

  it("names the most repeated idle rules in the callout", () => {
    const idle = { runCount: 0, lastRunAt: null };
    const text = neverRanCallout([
      rule({ ...idle, id: "1", name: "Generate report" }),
      rule({ ...idle, id: "2", name: "Generate report" }),
      rule({ ...idle, id: "3", name: "Win and hand off" }),
      rule({ id: "4", name: "Busy rule" }),
    ]);
    expect(text).toMatch(/^3 rules have never run\./);
    expect(text).toContain("“Generate report” ×2, “Win and hand off”");
    expect(text).not.toContain("Busy rule");
    expect(neverRanCallout([rule()])).toBeNull();
  });

  it("labels a proposed run as proposed, never as started", () => {
    expect(runResultMessage("Digest", { status: "proposed" })).toMatch(
      /proposed for review/
    );
    expect(runResultMessage("Digest", { status: "triggered" })).toBe(
      "“Digest” started a run."
    );
  });
});
