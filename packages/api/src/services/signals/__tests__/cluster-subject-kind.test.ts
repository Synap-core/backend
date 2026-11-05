/**
 * A pending proposal's needs-you row names the KIND of object it acts on
 * (`subjectKind`, the cluster's `targetType`), so the Inbox draws that kind's
 * own icon instead of one decision mark on every approval. Driven from the
 * real fingerprint collapse (`collapseProposalsToClusters`) through the real
 * producer (`signalFromCluster`), nothing hand-built between them.
 */
import { describe, expect, it } from "vitest";
import {
  collapseProposalsToClusters,
  type ClusterInputRow,
} from "../../proposals/fingerprint.js";
import { signalFromCluster } from "../needs-you-union.js";

const row = (id: string, targetType: string): ClusterInputRow => ({
  id,
  proposalType: "entity.create",
  targetType,
  targetId: null,
  createdAt: new Date("2026-11-01T10:00:00Z"),
  workspaceId: null,
  data: { title: `Thing ${id}` },
});

describe("a proposal row's subject kind", () => {
  it("is the cluster's target type, as a token", () => {
    const [cluster] = collapseProposalsToClusters([row("p1", "tool")]);
    expect(signalFromCluster(cluster!).subjectKind).toBe("tool");
  });

  it("two kinds are two rows with two subject kinds", () => {
    const clusters = collapseProposalsToClusters([
      row("p1", "tool"),
      row("p2", "skill"),
    ]);
    const kinds = clusters.map((c) => signalFromCluster(c).subjectKind).sort();
    expect(kinds).toEqual(["skill", "tool"]);
  });

  it("a blank target type says nothing (never an empty kind)", () => {
    const [cluster] = collapseProposalsToClusters([row("p1", "  ")]);
    expect("subjectKind" in signalFromCluster(cluster!)).toBe(false);
  });
});
