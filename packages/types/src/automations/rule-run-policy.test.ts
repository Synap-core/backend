import { describe, expect, it } from "vitest";
import {
  AUTOMATION_SKIP_REASONS,
  readMaxRunsPerDay,
  readPlaybookRunMode,
  ruleActMode,
} from "./rule-run-policy.js";
import { humanizeToken } from "../vocabulary/index.js";

describe("readPlaybookRunMode — absent/unknown is `run`", () => {
  it("keeps the three real modes", () => {
    expect(readPlaybookRunMode("propose")).toBe("propose");
    expect(readPlaybookRunMode("appointment")).toBe("appointment");
    expect(readPlaybookRunMode("run")).toBe("run");
  });
  it("anything else runs, exactly as before the field existed", () => {
    for (const v of [undefined, null, "", "PROPOSE", 1, {}]) {
      expect(readPlaybookRunMode(v)).toBe("run");
    }
  });
});

describe("ruleActMode — a rule proposes when any playbook_run node proposes", () => {
  it("propose", () => {
    expect(
      ruleActMode({
        nodes: [
          { type: "trigger", data: {} },
          { type: "playbook_run", data: { mode: "propose" } },
        ],
      })
    ).toBe("propose");
  });
  it("auto for run/appointment nodes, other THENs, and junk", () => {
    expect(ruleActMode({ nodes: [{ type: "playbook_run", data: {} }] })).toBe(
      "auto"
    );
    expect(
      ruleActMode({
        nodes: [{ type: "playbook_run", data: { mode: "appointment" } }],
      })
    ).toBe("auto");
    // `mode` on a non-playbook node means nothing.
    expect(
      ruleActMode({ nodes: [{ type: "output", data: { mode: "propose" } }] })
    ).toBe("auto");
    expect(ruleActMode(null)).toBe("auto");
    expect(ruleActMode({ nodes: "x" })).toBe("auto");
  });
});

describe("readMaxRunsPerDay", () => {
  it("absent / null ⇒ no cap", () => {
    expect(readMaxRunsPerDay({})).toEqual({ ok: true, value: null });
    expect(readMaxRunsPerDay(null)).toEqual({ ok: true, value: null });
    expect(readMaxRunsPerDay({ maxRunsPerDay: null })).toEqual({
      ok: true,
      value: null,
    });
  });
  it("a positive whole number is the cap", () => {
    expect(readMaxRunsPerDay({ maxRunsPerDay: 10 })).toEqual({
      ok: true,
      value: 10,
    });
  });
  it("anything else is an error, never silently 'no cap'", () => {
    for (const v of [0, -1, 1.5, "10", 10_001, true]) {
      expect(readMaxRunsPerDay({ maxRunsPerDay: v }).ok, String(v)).toBe(false);
    }
  });
});

describe("skip reasons are tokens that humanize", () => {
  it("each reads as words", () => {
    expect(humanizeToken(AUTOMATION_SKIP_REASONS.dailyCapReached)).toBe(
      "Daily cap reached"
    );
    expect(humanizeToken(AUTOMATION_SKIP_REASONS.alreadyProposed)).toBe(
      "Already proposed"
    );
    expect(humanizeToken(AUTOMATION_SKIP_REASONS.conditionNotMet)).toBe(
      "Condition not met"
    );
  });
});
