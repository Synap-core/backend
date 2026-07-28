import { describe, it, expect } from "vitest";
import { buildImportQualityReport } from "../quality-report.js";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";

describe("buildImportQualityReport", () => {
  it("scores empty graph as blocker", () => {
    const q = buildImportQualityReport({ operations: [] });
    expect(q.score).toBeLessThan(20);
    expect(q.findings.some((f) => f.id === "empty-graph")).toBe(true);
  });

  it("rewards containers + hierarchy + content", () => {
    const ops: CompositeProposalOperation[] = [
      {
        op: "create_entity",
        ref: "c0",
        profileSlug: "note",
        title: "Projects",
        properties: { isContainer: true, corpusIntent: "area" },
      },
      {
        op: "create_entity",
        ref: "c1",
        profileSlug: "note",
        title: "WineSafe",
        properties: { isContainer: true, corpusIntent: "project" },
      },
      {
        op: "create_relation",
        type: "parent_of",
        sourceRef: "c0",
        targetRef: "c1",
      },
      {
        op: "create_entity",
        ref: "e0",
        profileSlug: "task",
        title: "Ship MVP",
      },
      {
        op: "create_entity",
        ref: "e1",
        profileSlug: "note",
        title: "Notes",
      },
    ];
    const q = buildImportQualityReport({
      operations: ops,
      homes: {
        byWorkspace: { "ws-1": 2 },
        podWide: 1,
        byProject: {},
        multiHome: true,
      },
      itemCount: 5,
    });
    expect(q.counts.containers).toBe(2);
    expect(q.hierarchy.parentOfEdges).toBe(1);
    expect(q.score).toBeGreaterThanOrEqual(70);
    expect(q.nextUpgrades.length).toBeGreaterThan(0);
  });
});
