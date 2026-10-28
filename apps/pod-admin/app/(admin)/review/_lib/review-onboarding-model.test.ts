/**
 * The onboarding step (founder B-4): who sees it, and the preview of the
 * person's own items under each preset.
 */
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_PRESETS,
  onboardingPreview,
  showReviewOnboarding,
} from "./review-onboarding-model";
import {
  reviewRows,
  type ProposalFacts,
  type ReviewSignal,
} from "./review-rows";

const AGENT = { kind: "agent" as const, id: "agent-1", label: "Claude Code" };

function cluster(id: string, session: string): ReviewSignal {
  return {
    id,
    kind: "proposal-cluster",
    title: id,
    count: 1,
    groupKey: `session:${session}`,
    sessionTitle: `Session ${session}`,
    ageBucket: "recent",
    repeatCount: 1,
    occurredAt: "2026-10-27T10:00:00.000Z",
    category: "governance",
    class: "objectWork",
    target: { kind: "proposal", id: `${id}-p` },
    proposalIds: [`${id}-p`],
    by: AGENT,
  };
}

const facts = new Map<string, ProposalFacts>(
  (
    [
      ["a", "update", "focus_session"],
      ["b", "update", "focus_session"],
      ["c", "assign_agent", "focus_session"],
    ] as const
  ).map(([id, proposalType, targetType]) => [
    `${id}-p`,
    { id: `${id}-p`, proposalType, targetType, viewerCanReview: true },
  ])
);
const rows = reviewRows(
  [cluster("a", "s1"), cluster("b", "s1"), cluster("c", "s2")],
  facts
);

describe("who sees the onboarding step", () => {
  const base = {
    prefsLoaded: true,
    prefsFailed: false,
    hasSavedChoice: false,
    waiting: 3,
    narrowed: false,
  };
  it("a person with items waiting who never chose", () => {
    expect(showReviewOnboarding(base)).toBe(true);
  });
  it("never once a choice is saved, with nothing waiting, or over a link", () => {
    expect(showReviewOnboarding({ ...base, hasSavedChoice: true })).toBe(false);
    expect(showReviewOnboarding({ ...base, waiting: 0 })).toBe(false);
    expect(showReviewOnboarding({ ...base, narrowed: true })).toBe(false);
  });
  it("never while the saved choice is unknown — loading or a failed read", () => {
    expect(showReviewOnboarding({ ...base, prefsLoaded: false })).toBe(false);
    expect(showReviewOnboarding({ ...base, prefsFailed: true })).toBe(false);
  });
});

describe("the live preview of the person's own items", () => {
  it("offers three presets, Package recommended first", () => {
    expect(ONBOARDING_PRESETS.map((p) => p.groupBy)).toEqual([
      "package",
      "work",
      "agent",
    ]);
  });
  it("by kind: the packages in order, counted", () => {
    expect(onboardingPreview(rows, "package")).toEqual([
      { key: "hand-offs", name: "Hand-offs", n: 1 },
      { key: "bookkeeping", name: "Bookkeeping", n: 2 },
    ]);
  });
  it("follow the work: each session, counted", () => {
    expect(onboardingPreview(rows, "work")).toEqual([
      { key: "s1", name: "Session s1", n: 2 },
      { key: "s2", name: "Session s2", n: 1 },
    ]);
  });
  it("follow the agents: one agent holds them all", () => {
    expect(onboardingPreview(rows, "agent")).toEqual([
      { key: "agent-1", name: "Claude Code", n: 3 },
    ]);
  });
});
