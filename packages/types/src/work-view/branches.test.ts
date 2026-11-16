/**
 * jobBranches on a REAL-SHAPED work graph (`GET /focus-sessions/graph`: nodes,
 * flat edges of every kind, PRs grouped with their sessions, per-section read
 * status), content invented.
 */
import { describe, expect, it } from "vitest";

import { jobBranches, parentOfGraph, type BranchGraph } from "./branches.js";

const graph: BranchGraph = {
  nodes: [
    { id: "wave", title: "Wave", status: "active" },
    { id: "lane-a", title: "Lane A", status: "active" },
    { id: "lane-b", title: "Lane B", status: "closed" },
    { id: "fix", title: "Fix under lane A", status: "active" },
    { id: "other", title: "Unrelated", status: "paused" },
  ],
  edges: [
    { kind: "spawned_from", from: "lane-a", to: "wave" },
    { kind: "spawned_from", from: "lane-b", to: "wave" },
    { kind: "spawned_from", from: "fix", to: "lane-a" },
    { kind: "blocked_by", from: "lane-b", to: "lane-a" },
    { kind: "updated", from: "other", to: "wave" },
    { kind: "triggered", from: "wave", to: "other" },
  ],
  pullRequests: [
    {
      id: "o/backend#1",
      url: "https://github.com/o/backend/pull/1",
      label: "backend#1 feat",
      sessions: [{ sessionId: "lane-a", state: "open" }],
    },
  ],
  sections: { blockedBy: { status: "ok" }, pullRequests: { status: "ok" } },
};

describe("jobBranches", () => {
  it("draws child jobs as branches and nothing else", () => {
    const { roots } = jobBranches(graph);
    expect(roots.map((r) => r.id)).toEqual(["wave", "other"]);
    const wave = roots[0]!;
    expect(wave.branches.map((b) => b.id)).toEqual(["lane-a", "lane-b"]);
    expect(wave.branches[0]!.branches.map((b) => b.id)).toEqual(["fix"]);
    expect(wave.descendants).toBe(3);
    // `updated` / `triggered` never make a branch.
    expect(roots[1]!.branches).toEqual([]);
  });

  it("puts PRs and blockers on the line as marks", () => {
    const wave = jobBranches(graph, ["wave"]).roots[0]!;
    const [laneA, laneB] = wave.branches;
    expect(laneA!.marks).toEqual([
      expect.objectContaining({
        kind: "pull_request",
        id: "o/backend#1",
        state: "open",
      }),
    ]);
    expect(laneB!.marks).toEqual([
      {
        kind: "blocked_by",
        jobId: "lane-a",
        title: "Lane A",
        status: "active",
      },
    ]);
  });

  it("says a section could not be read instead of drawing it empty", () => {
    const out = jobBranches({
      ...graph,
      pullRequests: [],
      sections: {
        pullRequests: { status: "unavailable", reason: "github down" },
      },
    });
    expect(out.unavailable).toEqual(["pullRequests"]);
  });

  it("gives requestsOf the parent of a job", () => {
    const parentOf = parentOfGraph(graph);
    expect(parentOf("fix")).toBe("lane-a");
    expect(parentOf("wave")).toBeNull();
  });
});
