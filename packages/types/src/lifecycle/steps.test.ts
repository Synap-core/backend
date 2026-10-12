import { describe, it, expect } from "vitest";
import {
  currentStep,
  offPathChoices,
  stepsFromLifecycle,
  stepsFromTrackStages,
  type LifecycleDeclaration,
} from "./index.js";

// A deal-shaped lifecycle: the rows are chosen where candidate rules DISAGREE —
// a lost current (passed-as-success would paint green before the red mark), a
// paused option declared mid-path (declared order vs category grouping), and a
// key outside the declaration (an invented position).
const DEAL: LifecycleDeclaration = {
  propertySlug: "commercialStage",
  options: [
    { key: "lead", category: "open" },
    { key: "qualified", category: "active", label: "Qualified" },
    { key: "on_hold", category: "paused" },
    { key: "proposal", category: "active", humanOnly: true },
    { key: "won", category: "done" },
    { key: "lost", category: "lost" },
  ],
};

const shape = (decl: LifecycleDeclaration, current: string | null) =>
  stepsFromLifecycle(decl, current).map(
    (s) => `${s.key}:${s.position}:${s.tone}`
  );

describe("stepsFromLifecycle", () => {
  it("main path in declared order: passed · current · ahead; off-path hidden", () => {
    expect(shape(DEAL, "proposal")).toEqual([
      "lead:passed:textSecondary",
      "qualified:passed:textSecondary",
      "proposal:current:primary",
      "won:ahead:textMuted",
    ]);
  });

  it("passed is never success: a won deal shows neutral history, a green current", () => {
    expect(shape(DEAL, "won")).toEqual([
      "lead:passed:textSecondary",
      "qualified:passed:textSecondary",
      "proposal:passed:textSecondary",
      "won:current:success",
    ]);
  });

  it("an off-path current is drawn as off, in its own tone, main path all ahead", () => {
    expect(shape(DEAL, "lost")).toEqual([
      "lead:ahead:textMuted",
      "qualified:ahead:textMuted",
      "proposal:ahead:textMuted",
      "won:ahead:textMuted",
      "lost:off:error",
    ]);
    // a paused option keeps its DECLARED slot when it is the one shown
    expect(shape(DEAL, "on_hold").map((s) => s.split(":")[0])).toEqual([
      "lead",
      "qualified",
      "on_hold",
      "proposal",
      "won",
    ]);
  });

  it("a status outside the declaration marks nothing current", () => {
    const steps = stepsFromLifecycle(DEAL, "negotiating_legacy");
    expect(steps.every((s) => s.position === "ahead")).toBe(true);
    expect(currentStep(steps)).toBeNull();
    expect(stepsFromLifecycle(DEAL, null).length).toBe(4);
    expect(stepsFromLifecycle(null, "lead")).toEqual([]);
  });

  it("carries labels (vocabulary fallback), humanOnly, category and counts", () => {
    const steps = stepsFromLifecycle(DEAL, "lead", { lead: 3, won: 0 });
    const by = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(by.qualified!.label).toBe("Qualified");
    expect(by.lead!.label).not.toBe("lead");
    expect(by.proposal!.humanOnly).toBe(true);
    expect(by.lead!.humanOnly).toBeUndefined();
    expect(by.won!.category).toBe("done");
    expect(by.lead!.count).toBe(3);
    expect(by.won!.count).toBe(0);
    expect(by.qualified!.count).toBeUndefined();
    expect(currentStep(steps)!.key).toBe("lead");
  });
});

describe("stepsFromTrackStages", () => {
  it("done → passed, active → current (accent), not_started → ahead", () => {
    const steps = stepsFromTrackStages([
      {
        key: "a",
        name: "Scope",
        category: null,
        position: "done",
        sessionCount: 2,
      },
      { key: "b", name: "Build", category: null, position: "active" },
      { key: "c", name: "Ship", category: null, position: "not_started" },
    ]);
    expect(
      steps.map((s) => `${s.key}:${s.label}:${s.position}:${s.tone}`)
    ).toEqual([
      "a:Scope:passed:textSecondary",
      "b:Build:current:primary",
      "c:Ship:ahead:textMuted",
    ]);
    expect(steps[0]!.count).toBe(2);
    expect(steps[1]!.count).toBeUndefined();
  });
});

describe("offPathChoices — the 'Other status…' picker (D2)", () => {
  it("lists the paused and lost options the strip does not draw, with their own marks", () => {
    const lost = {
      ...DEAL,
      options: DEAL.options.map((o) => (o.key === "lost" ? { ...o, humanOnly: true } : o)),
    };
    expect(offPathChoices(lost, "lead").map((c) => [c.key, c.tone, c.humanOnly ?? false])).toEqual([
      ["on_hold", "warning", false],
      ["lost", "error", true],
    ]);
  });
  it("never lists the current status, nor a main-path one", () => {
    expect(offPathChoices(DEAL, "on_hold").map((c) => c.key)).not.toContain("on_hold");
    expect(offPathChoices(DEAL, "lead").map((c) => c.category)).not.toContain("open");
    expect(offPathChoices(null, "lead")).toEqual([]);
  });
});
