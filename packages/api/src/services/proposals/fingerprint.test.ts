import { describe, it, expect } from "vitest";
import {
  computeProposalFingerprint,
  collapseProposalsToClusters,
  extractProposalName,
  normalizeSignatureToken,
  type ClusterInputRow,
} from "./fingerprint.js";

/**
 * Pure-function contract test for the proposal fingerprint + cluster collapse
 * behind `proposals.groups`. No DB — the fingerprint is a pure function of a
 * proposal's shape, and the collapse folds already-resolved rows.
 */

describe("computeProposalFingerprint", () => {
  it("identical-shape update proposals on the SAME target share a fingerprint", () => {
    const a = computeProposalFingerprint({
      proposalType: "update",
      targetType: "entity",
      targetId: "ent-1",
      data: { properties: { industry: "SaaS" } },
    });
    const b = computeProposalFingerprint({
      proposalType: "update",
      targetType: "entity",
      targetId: "ent-1",
      // A different payload value but the SAME (type × target) — v1 groups
      // structurally, so these still cluster.
      data: { properties: { industry: "Fintech" } },
    });
    expect(a).toBe(b);
  });

  it("differs when the TARGET entity differs", () => {
    const a = computeProposalFingerprint({
      proposalType: "update",
      targetType: "entity",
      targetId: "ent-1",
      data: {},
    });
    const b = computeProposalFingerprint({
      proposalType: "update",
      targetType: "entity",
      targetId: "ent-2",
      data: {},
    });
    expect(a).not.toBe(b);
  });

  it("differs when the proposalType differs (update vs delete of same target)", () => {
    const update = computeProposalFingerprint({
      proposalType: "update",
      targetType: "entity",
      targetId: "ent-1",
      data: {},
    });
    const del = computeProposalFingerprint({
      proposalType: "delete",
      targetType: "entity",
      targetId: "ent-1",
      data: {},
    });
    expect(update).not.toBe(del);
  });

  it("differs when the targetType differs", () => {
    const entity = computeProposalFingerprint({
      proposalType: "update",
      targetType: "entity",
      targetId: "x",
      data: {},
    });
    const doc = computeProposalFingerprint({
      proposalType: "update",
      targetType: "document",
      targetId: "x",
      data: {},
    });
    expect(entity).not.toBe(doc);
  });

  describe("create clustering by normalized title/name", () => {
    it("repeated 'create company X' attempts cluster despite distinct placeholder ids", () => {
      const first = computeProposalFingerprint({
        proposalType: "create",
        targetType: "entity",
        targetId: "placeholder-uuid-1",
        data: { data: { name: "Acme Corp" } },
      });
      const second = computeProposalFingerprint({
        proposalType: "create",
        targetType: "entity",
        // Different fresh placeholder id — id-grouping would NOT cluster these.
        targetId: "placeholder-uuid-2",
        // Different casing / spacing — normalization folds them together.
        data: { data: { name: "  acme   corp " } },
      });
      expect(first).toBe(second);
    });

    it("different create names do NOT cluster", () => {
      const acme = computeProposalFingerprint({
        proposalType: "create",
        targetType: "entity",
        targetId: "p1",
        data: { data: { name: "Acme Corp" } },
      });
      const globex = computeProposalFingerprint({
        proposalType: "create",
        targetType: "entity",
        targetId: "p2",
        data: { data: { name: "Globex" } },
      });
      expect(acme).not.toBe(globex);
    });

    it("reads a name from the top-level envelope targetName and from a flat payload", () => {
      const fromEnvelope = computeProposalFingerprint({
        proposalType: "create",
        targetType: "entity",
        targetId: "p1",
        data: { targetName: "Acme Corp" },
      });
      const fromFlatTitle = computeProposalFingerprint({
        proposalType: "create",
        targetType: "entity",
        targetId: "p2",
        data: { title: "Acme Corp" },
      });
      expect(fromEnvelope).toBe(fromFlatTitle);
    });
  });

  it("extractProposalName priority: targetName > title > name > displayName > label", () => {
    expect(extractProposalName({ targetName: "T", data: { title: "X" } })).toBe(
      "T"
    );
    expect(extractProposalName({ data: { title: "X", name: "Y" } })).toBe("X");
    expect(extractProposalName({ name: "Y", displayName: "Z" })).toBe("Y");
    expect(extractProposalName({ displayName: "Z", label: "L" })).toBe("Z");
    expect(extractProposalName({ label: "L" })).toBe("L");
    expect(extractProposalName({ foo: "bar" })).toBeUndefined();
    expect(extractProposalName(null)).toBeUndefined();
  });

  it("normalizeSignatureToken lowercases, trims, and collapses whitespace", () => {
    expect(normalizeSignatureToken("  Acme   Corp ")).toBe("acme corp");
  });
});

describe("collapseProposalsToClusters", () => {
  const at = (iso: string) => new Date(iso);

  function row(over: Partial<ClusterInputRow>): ClusterInputRow {
    return {
      id: "id",
      proposalType: "update",
      targetType: "entity",
      targetId: "ent-1",
      data: {},
      createdAt: at("2026-01-01T00:00:00Z"),
      workspaceId: null,
      ...over,
    };
  }

  it("folds identical-shape rows into one cluster and counts them", () => {
    const clusters = collapseProposalsToClusters([
      row({ id: "p1", targetId: "ent-1", createdAt: at("2026-01-01T00:00:00Z") }),
      row({ id: "p2", targetId: "ent-1", createdAt: at("2026-01-02T00:00:00Z") }),
      row({ id: "p3", targetId: "ent-2", createdAt: at("2026-01-03T00:00:00Z") }),
    ]);
    expect(clusters).toHaveLength(2);
    const ent1 = clusters.find((c) => c.sampleProposalIds.includes("p1"))!;
    expect(ent1.count).toBe(2);
    expect(ent1.sampleProposalIds).toEqual(["p1", "p2"]);
    // latestAt is the MAX createdAt across the cluster's members.
    expect(ent1.latestAt.toISOString()).toBe(at("2026-01-02T00:00:00Z").toISOString());
  });

  it("orders clusters newest-active first", () => {
    const clusters = collapseProposalsToClusters([
      row({ id: "old", targetId: "ent-1", createdAt: at("2026-01-01T00:00:00Z") }),
      row({ id: "new", targetId: "ent-2", createdAt: at("2026-06-01T00:00:00Z") }),
    ]);
    expect(clusters[0]!.sampleProposalIds).toEqual(["new"]);
    expect(clusters[1]!.sampleProposalIds).toEqual(["old"]);
  });

  it("dedupes sources across the cluster and only counts present dimensions", () => {
    const clusters = collapseProposalsToClusters([
      row({ id: "p1", sessionId: "s1", agentLabel: "CTO" }),
      row({ id: "p2", sessionId: "s1", agentLabel: "CTO" }), // same origin → 1 source
      row({ id: "p3", sessionId: "s2", automationId: "auto-9" }),
      row({ id: "p4" }), // no provenance → contributes no source
    ]);
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    expect(c.count).toBe(4);
    expect(c.sources).toHaveLength(2);
    expect(c.sources).toContainEqual({ agentLabel: "CTO", sessionId: "s1" });
    expect(c.sources).toContainEqual({ sessionId: "s2", automationId: "auto-9" });
  });

  it("collects distinct workspaceIds and respects the sample cap", () => {
    const rows: ClusterInputRow[] = Array.from({ length: 5 }, (_, i) =>
      row({
        id: `p${i}`,
        workspaceId: i % 2 === 0 ? "ws-a" : "ws-b",
      })
    );
    const [c] = collapseProposalsToClusters(rows, { sampleCap: 3 });
    expect(c!.count).toBe(5);
    expect(c!.sampleProposalIds).toHaveLength(3);
    expect([...c!.workspaceIds].sort()).toEqual(["ws-a", "ws-b"]);
  });
});
