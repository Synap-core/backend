import { describe, it, expect } from "vitest";
import {
  selectLapsedIds,
  type LapseCandidate,
} from "./expire-lapsed-proposals.js";

/**
 * This decides what gets RETIRED WITHOUT A HUMAN. Every test is about the
 * failure direction: it must fail toward keeping a decision, never toward
 * losing one.
 */
describe("selectLapsedIds", () => {
  const NOW = new Date("2026-09-02T12:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

  const row = (
    id: string,
    proposalType: string,
    targetType: string,
    ageHours: number
  ): LapseCandidate => ({
    id,
    proposalType,
    targetType,
    createdAt: hoursAgo(ageHours),
  });

  it("expires an ephemeral run past its 24h backstop", () => {
    // The real shape: 441 capability runs, median age 11.7 days.
    const out = selectLapsedIds([row("a", "run", "capability", 24 * 12)], NOW);
    expect(out).toEqual(["a"]);
  });

  it("keeps an ephemeral run that is still within its window", () => {
    // Proposed at 6pm, reviewed next morning — must survive.
    expect(selectLapsedIds([row("a", "run", "capability", 15)], NOW)).toEqual(
      []
    );
  });

  it("a run exactly AT the limit is still answerable", () => {
    // Strictly greater-than. A boundary that expires is a decision lost to
    // rounding.
    expect(selectLapsedIds([row("a", "run", "capability", 24)], NOW)).toEqual(
      []
    );
    expect(
      selectLapsedIds([row("a", "run", "capability", 24.001)], NOW)
    ).toEqual(["a"]);
  });

  it("NEVER expires the classes with no lifetime, however old", () => {
    // A merge candidate or a proposed entity is exactly as reviewable after a
    // year as on day one. These are the 219 real decisions in the queue.
    const ancient = 24 * 365;
    const out = selectLapsedIds(
      [
        row("merge", "merge", "entity", ancient),
        row("create", "create", "entity", ancient),
        row("import", "import.graph", "entity", ancient),
        row("edit", "ai_edit", "document", ancient),
        row("gov", "governance.tighten_lane", "governance", ancient),
      ],
      NOW
    );
    expect(
      out,
      "expiring a curatorial or object-work proposal would destroy a decision " +
        "a human still owed"
    ).toEqual([]);
  });

  it("FAILS CLOSED on a proposal type it has never seen", () => {
    // The safety property. A future proposalType must not inherit a fuse.
    expect(
      selectLapsedIds([row("x", "some_future_type", "whatever", 24 * 999)], NOW)
    ).toEqual([]);
  });

  it("a run against a NON-capability target is not ephemeral", () => {
    expect(
      selectLapsedIds([row("x", "run", "playbook", 24 * 999)], NOW)
    ).toEqual([]);
  });

  it("selects only the lapsed rows out of a mixed queue", () => {
    const out = selectLapsedIds(
      [
        row("old-run", "run", "capability", 240),
        row("new-run", "run", "capability", 2),
        row("merge", "merge", "entity", 240),
        row("create", "create", "entity", 240),
      ],
      NOW
    );
    expect(out).toEqual(["old-run"]);
  });

  it("an empty queue is not an error", () => {
    expect(selectLapsedIds([], NOW)).toEqual([]);
  });
});
