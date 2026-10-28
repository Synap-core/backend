import { describe, it, expect } from "vitest";
import {
  buildGetStartedPrompt,
  completedStartPrefix,
  deriveStartSteps,
  nextStartStep,
  resolveKindView,
  START_STEP_IDS,
  type StartFacts,
} from "./start.js";
import { UIPreferencesSchema } from "../preferences/schemas.js";

const T = "2026-10-28T10:00:00.000Z";
const LATER = "2026-10-28T11:00:00.000Z";

const base: StartFacts = {
  values: null,
  startViewCount: null,
  setupProposal: null,
  agentConnection: "none",
  externalAgentApprovalReviewedAt: null,
  journeyStatus: null,
};
const f = (o: Partial<StartFacts>): StartFacts => ({ ...base, ...o });
const done = (facts: StartFacts) =>
  deriveStartSteps(facts)
    .filter((s) => s.done)
    .map((s) => s.id);

const setupVals = {
  v: 1 as const,
  intent: { slug: "sales", source: "here" as const, at: T },
  view: { profile: "deal", view: "deal-pipeline", type: "kanban", at: T },
  path: { kind: "quick" as const, at: T },
  setup: { proposalId: "p1", at: T },
};

describe("deriveStartSteps (§2.2 table)", () => {
  it("1. empty facts: nothing done, next is intent", () => {
    const s = deriveStartSteps(base);
    expect(s.map((x) => x.id)).toEqual([...START_STEP_IDS]);
    expect(done(base)).toEqual([]);
    expect(nextStartStep(s)).toBe("start:intent");
  });

  it("2. intent set marks intent only", () => {
    expect(done(f({ values: { v: 1, intent: setupVals.intent } }))).toEqual([
      "start:intent",
    ]);
  });

  it("3. views is done when the start declares fewer than 2 views", () => {
    expect(done(f({ startViewCount: 1 }))).toEqual(["start:views"]);
    expect(done(f({ startViewCount: 3 }))).toEqual([]);
  });

  it("4. path set marks path", () => {
    expect(done(f({ values: { v: 1, path: setupVals.path } }))).toEqual([
      "start:path",
    ]);
  });

  it("5. setup: a stored proposalId alone is NOT done (values are not trusted)", () => {
    const facts = f({
      values: setupVals,
      setupProposal: {
        status: "pending",
        activeSpaceCount: 0,
        approvedAt: null,
      },
    });
    expect(done(facts)).not.toContain("start:setup");
    expect(done(f({ values: setupVals, setupProposal: null }))).not.toContain(
      "start:setup"
    );
  });

  it("6. setup: approved but every created space archived is NOT done", () => {
    const facts = f({
      values: setupVals,
      setupProposal: { status: "approved", activeSpaceCount: 0, approvedAt: T },
    });
    expect(done(facts)).not.toContain("start:setup");
  });

  it("7. setup: approved with a live space is done; agent follows the roster", () => {
    const facts = f({
      values: setupVals,
      setupProposal: { status: "approved", activeSpaceCount: 2, approvedAt: T },
      agentConnection: "seen",
    });
    expect(done(facts)).toEqual([
      "start:intent",
      "start:views",
      "start:path",
      "start:setup",
      "start:agent",
    ]);
    expect(nextStartStep(deriveStartSteps(facts))).toBe("start:first-work");
    expect(done(f({ agentConnection: "pending" }))).not.toContain(
      "start:agent"
    );
  });

  it("8. first-work needs a review AFTER setup approval; done follows the journey", () => {
    const setupProposal = {
      status: "approved",
      activeSpaceCount: 1,
      approvedAt: LATER,
    };
    expect(
      done(f({ setupProposal, externalAgentApprovalReviewedAt: T }))
    ).not.toContain("start:first-work");
    const all = f({
      values: setupVals,
      setupProposal,
      agentConnection: "seen",
      externalAgentApprovalReviewedAt: "2026-10-28T12:00:00.000Z",
      journeyStatus: "completed",
    });
    expect(done(all)).toEqual([...START_STEP_IDS]);
    expect(nextStartStep(deriveStartSteps(all))).toBeNull();
  });

  it("completedStartPrefix stops at the first gap", () => {
    const steps = deriveStartSteps(
      f({ values: { v: 1, intent: setupVals.intent, path: setupVals.path } })
    );
    expect(completedStartPrefix(steps)).toEqual(["start:intent"]);
  });
});

describe("resolveKindView (pref, then space default, then template first)", () => {
  const templateViews = [
    { slug: "deal-pipeline", type: "kanban" },
    { slug: "deals-table", type: "table" },
  ];
  const pref = {
    view: "deals-table",
    type: "table",
    at: T,
    source: "settings" as const,
  };

  it("pref wins", () => {
    expect(
      resolveKindView({ pref, templateViews, spaceDefault: "deal-pipeline" })
    ).toEqual({ view: "deals-table", type: "table", from: "pref" });
  });
  it("space default beats template first", () => {
    expect(
      resolveKindView({
        pref: null,
        templateViews,
        spaceDefault: "deals-table",
      })
    ).toMatchObject({ view: "deals-table", from: "space-default" });
  });
  it("template first is the last resort", () => {
    expect(
      resolveKindView({ pref: undefined, templateViews, spaceDefault: null })
    ).toMatchObject({ view: "deal-pipeline", from: "template-first" });
  });
  it("a stale pref falls through; no views gives null", () => {
    expect(
      resolveKindView({
        pref: { ...pref, view: "gone" },
        templateViews,
        spaceDefault: null,
      })
    ).toMatchObject({ from: "template-first" });
    expect(
      resolveKindView({ pref: null, templateViews: [], spaceDefault: null })
    ).toBeNull();
  });
});

describe("buildGetStartedPrompt", () => {
  it("returns the exact spec string", () => {
    expect(
      buildGetStartedPrompt({
        sessionTitle: "Your live deals",
        sessionId: "a1b2c3d4-0000-4000-8000-000000000000",
      })
    ).toBe(
      'Use Synap. Get started with Synap: open my session "Your live deals" (a1b2c3d4) and do its first step. Ask me before you keep anything.'
    );
  });
});

describe("UIPreferencesSchema", () => {
  it("keeps kindViews (a zod object strips unknown keys)", () => {
    const kindViews = {
      deal: {
        view: "deal-pipeline",
        type: "kanban",
        at: T,
        source: "onboarding",
      },
    };
    expect(UIPreferencesSchema.parse({ kindViews })?.kindViews).toEqual(
      kindViews
    );
  });
});
