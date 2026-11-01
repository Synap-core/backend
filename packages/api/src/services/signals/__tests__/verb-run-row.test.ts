/**
 * A pending ship verb's needs-you row (decision 4d6d7922, D2 A): the row
 * Relay, the browser, pod admin's Review list and MCP `synap_needs_you` draw
 * reads the verb's one heading ("Merge app-bases#12 into main at a524c103"),
 * never "Run Tool", and two merges of one verb stay two rows.
 */
import { describe, expect, it } from "vitest";
import { describeVerbRunProposal } from "@synap-core/types/proposals/capability-run";
import {
  collapseProposalsToClusters,
  type ClusterInputRow,
} from "../../proposals/fingerprint.js";
import { signalFromCluster } from "../needs-you-union.js";

const SKILL = "5e1f0000-0000-4000-8000-000000000000";

// The shape `executeCapability` files: target = the verb's skill, the payload
// carries the verb and its arguments, plus the summary it stamps.
const mergeRow = (
  id: string,
  parameters: Record<string, unknown>
): ClusterInputRow => {
  const p = {
    repo: "Synap-core/app-bases",
    pr: 12,
    expectedHeadSha: "a524c103d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
    base: "main",
    method: "squash",
    ...parameters,
  };
  return {
    id,
    proposalType: "capability.run",
    targetType: "capability",
    targetId: SKILL,
    createdAt: new Date("2026-11-01T10:00:00Z"),
    workspaceId: null,
    data: {
      verbId: "github_merge_pr",
      skillId: SKILL,
      parameters: p,
      summary: "Run github merge pr",
    },
  };
};

describe("a ship verb's needs-you row", () => {
  it("is titled with the verb's heading, not 'Run Tool' or the stored summary", () => {
    const [cluster] = collapseProposalsToClusters([mergeRow("p1", {})]);
    const signal = signalFromCluster(cluster!);
    expect(signal.title).toBe("Merge app-bases#12 into main at a524c103");
    expect(signal.title).toBe(
      describeVerbRunProposal({
        proposalType: "capability.run",
        data: mergeRow("p1", {}).data,
      })!.title
    );
    expect(signal.title).not.toMatch(/Run|Tool/);
  });

  it("two merges of one verb (two PRs, or one PR at a new head) stay two rows", () => {
    const clusters = collapseProposalsToClusters([
      mergeRow("p1", {}),
      mergeRow("p2", { pr: 13 }),
      mergeRow("p3", {
        expectedHeadSha: "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
      }),
    ]);
    expect(clusters).toHaveLength(3);
    expect(clusters.map((c) => signalFromCluster(c).title).sort()).toEqual([
      "Merge app-bases#12 into main at a524c103",
      "Merge app-bases#12 into main at b1c2d3e4",
      "Merge app-bases#13 into main at a524c103",
    ]);
  });

  it("the same merge filed twice is still one row", () => {
    const clusters = collapseProposalsToClusters([
      mergeRow("p1", {}),
      mergeRow("p2", {}),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(2);
  });

  it("a run whose arguments do not name the act keeps the generic row", () => {
    const [cluster] = collapseProposalsToClusters([
      mergeRow("p1", { expectedHeadSha: undefined }),
    ]);
    expect(cluster!.labelIsHeading).toBeUndefined();
    expect(signalFromCluster(cluster!).title).not.toMatch(/^Merge /);
  });
});
