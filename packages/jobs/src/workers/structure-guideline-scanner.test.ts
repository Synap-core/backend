import { describe, it, expect } from "vitest";
import type { StructureGuidelineProposalData } from "@synap/database";
// The DB tier is never reached: every DB access is injected via
// `StructureGuidelineScanDeps` (same no-mock import as the blocked-slot test).
import {
  correctionsFromProposal,
  entityKindForItem,
  qualifies,
  runStructureGuidelineScan,
  draftStructureGuidelineAddition,
  draftStructureGuidelineText,
  type ExtractionProposalRow,
  type StructureGuidelineScanDeps,
} from "./structure-guideline-scanner.js";

/**
 * FIXTURE DISCIPLINE — each row rules a candidate rule out:
 *   - three rejects inside ONE proposal (count met, proposal floor not);
 *   - an excluded routing reason at volume (the filter is by reason, not count);
 *   - a positional `$opN` ref next to a named `ref` (both resolve);
 *   - a second scan with the first proposal still PENDING (dedup), and after it
 *     was rejected with no new evidence (no re-ask).
 */

const NOW = new Date("2026-09-13T04:00:00Z");
const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const personGraph = {
  operations: [
    { op: "create_entity", profileSlug: "note", ref: "n1" },
    { op: "create_entity", profileSlug: "person", ref: "p1" },
  ],
};

function itemReject(
  id: string,
  over: Partial<ExtractionProposalRow> = {},
  itemRef = "p1",
  reasonCode = "bad_data",
  reason = "the phone number was invented"
): ExtractionProposalRow {
  return {
    id,
    proposalType: "capture.graph",
    status: "approved",
    userId: "u1",
    workspaceId: "ws1",
    reasonCode: null,
    rejectionReason: null,
    data: {
      ...personGraph,
      dispositions: { [itemRef]: { status: "reject", reasonCode, reason } },
    },
    decidedAt: day(2),
    ...over,
  };
}

describe("correctionsFromProposal — scope assignment", () => {
  it("an item reject on a create_entity op scopes to its entityKind (named ref AND positional $opN)", () => {
    expect(entityKindForItem(personGraph, "p1")).toBe("person");
    expect(entityKindForItem(personGraph, "$op1")).toBe("person");
    expect(entityKindForItem(personGraph, "$rel0")).toBeUndefined();
    const [c] = correctionsFromProposal(itemReject("a"));
    expect(c).toMatchObject({
      scopeKind: "entityKind",
      scopeRef: "person",
      bucket: "bad_data",
    });
  });

  it("a whole import.graph reject scopes to sourceKind import:<source>; a capture.graph reject to default", () => {
    const imp = correctionsFromProposal({
      ...itemReject("b"),
      proposalType: "import.graph",
      status: "rejected",
      reasonCode: "not_relevant",
      data: { ...personGraph, source: "csv" },
    });
    expect(imp[0]).toMatchObject({
      scopeKind: "sourceKind",
      scopeRef: "import:csv",
    });
    const cap = correctionsFromProposal({
      ...itemReject("c"),
      status: "rejected",
      reasonCode: "not_relevant",
      data: personGraph,
    });
    expect(cap[0]).toMatchObject({ scopeKind: "default", scopeRef: null });
  });

  it("DISCRIMINATING: wrong_workspace (routing) and duplicate (mechanical) are not structure corrections; an unreasoned reject is not evidence", () => {
    expect(
      correctionsFromProposal(itemReject("d", {}, "p1", "wrong_workspace", ""))
    ).toEqual([]);
    expect(
      correctionsFromProposal(itemReject("e", {}, "p1", "duplicate", ""))
    ).toEqual([]);
    expect(
      correctionsFromProposal({
        ...itemReject("f"),
        data: { ...personGraph, dispositions: { p1: { status: "reject" } } },
      })
    ).toEqual([]);
  });
});

describe("qualifies", () => {
  it("DISCRIMINATING: 3 corrections inside ONE proposal do not qualify", () => {
    const one = correctionsFromProposal(itemReject("x"))[0]!;
    expect(qualifies([one, one, one])).toBe(false);
    expect(qualifies([one, one, { ...one, proposalId: "y" }])).toBe(true);
  });
});

/** In-memory deps: the filed proposals are what the dedup lookup reads back. */
function memoryDeps(rows: ExtractionProposalRow[]) {
  const filed: Array<{
    id: string;
    status: string;
    createdAt: Date;
    data: StructureGuidelineProposalData;
  }> = [];
  const deps: StructureGuidelineScanDeps = {
    now: () => NOW,
    loadDecidedExtractionProposals: async () => rows,
    latestProposalForCluster: async (key) =>
      [...filed].reverse().find((p) => p.data.clusterKey === key) ?? null,
    findCoveringGuideline: async () => null,
    fileProposal: async (data) => {
      const id = `prop-${filed.length + 1}`;
      filed.push({ id, status: "pending", createdAt: NOW, data });
      return id;
    },
  };
  return { deps, filed };
}

const cluster = [
  itemReject("a1", { decidedAt: day(3) }),
  itemReject("a2", { decidedAt: day(2) }, "$op1", "bad_data", "made-up email"),
  itemReject("a3", { decidedAt: day(1) }, "p1", "wrong_entity", ""),
  // noise: an excluded reason at volume in another cluster
  itemReject("r1", {}, "n1", "wrong_workspace", ""),
  itemReject("r2", {}, "n1", "wrong_workspace", ""),
  itemReject("r3", {}, "n1", "wrong_workspace", ""),
];

describe("runStructureGuidelineScan — files exactly ONE, then dedups", () => {
  it("a qualifying reason-coded cluster files ONE proposal; a second scan files NONE", async () => {
    const m = memoryDeps(cluster);
    const first = await runStructureGuidelineScan(m.deps);
    expect(first).toEqual(["prop-1"]);
    const data = m.filed[0]!.data;
    expect(data).toMatchObject({
      userId: "u1",
      // D1: the subject under the ownership key the approve door reads
      sourceId: "u1",
      scopeKind: "entityKind",
      scopeRef: "person",
      workspaceId: "ws1",
      supersedesGuidelineId: null,
    });
    expect(data.evidence.corrections).toBe(3);
    expect(data.evidence.proposals).toBe(3);
    expect(data.evidence.reasonHistogram).toEqual({
      bad_data: 2,
      wrong_entity: 1,
    });
    expect(data.text).toContain("Copy field values for a person literally");
    expect(data.text).toContain('"the phone number was invented"');
    expect(data.addition).toBe(data.text);

    const second = await runStructureGuidelineScan(m.deps);
    expect(second).toEqual([]);
    expect(m.filed).toHaveLength(1);
  });

  it("after the proposal was decided, the SAME evidence never re-files — only new corrections do", async () => {
    const m = memoryDeps(cluster);
    await runStructureGuidelineScan(m.deps);
    m.filed[0]!.status = "rejected";
    expect(await runStructureGuidelineScan(m.deps)).toEqual([]);
  });

  it("a covering guideline makes the draft a SUPERSEDE: text = current + addition, addition stored apart", async () => {
    const m = memoryDeps(cluster);
    m.deps.findCoveringGuideline = async () => ({
      id: "g1",
      text: "People need a source link.",
      createdAt: day(10),
    });
    await runStructureGuidelineScan(m.deps);
    const data = m.filed[0]!.data;
    expect(data.supersedesGuidelineId).toBe("g1");
    expect(data.currentText).toBe("People need a source link.");
    expect(data.text).toBe(`People need a source link.\n\n${data.addition}`);
    expect(data.addition).not.toContain("People need a source link.");

    const m2 = memoryDeps(cluster);
    m2.deps.findCoveringGuideline = async () => ({
      id: "g2",
      text: "x",
      createdAt: day(1.5),
    });
    expect(await runStructureGuidelineScan(m2.deps)).toEqual([]);
  });
});

describe("draft text", () => {
  it("is deterministic and stays inside the guideline cap", () => {
    const cs = correctionsFromProposal(itemReject("z"));
    const addition = draftStructureGuidelineAddition(
      { scopeKind: "entityKind", scopeRef: "person" },
      cs
    );
    expect(
      draftStructureGuidelineText(addition, "y".repeat(1990)).length
    ).toBeLessThanOrEqual(2000);
    expect(
      draftStructureGuidelineAddition(
        { scopeKind: "entityKind", scopeRef: "person" },
        cs
      )
    ).toBe(addition);
  });
});
