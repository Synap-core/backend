/**
 * A pending deploy approval's needs-you row — the row Relay, the browser,
 * pod admin's Review list and MCP `synap_needs_you` all draw — reads the
 * approval's one heading, never "Approve deploy Session …", and two asks
 * of one session stay two rows.
 */
import { describe, expect, it } from "vitest";
import { describeDevDeployProposal } from "@synap-core/types/proposals/dev-deploy";
import {
  collapseProposalsToClusters,
  type ClusterInputRow,
} from "../../proposals/fingerprint.js";
import { signalFromCluster } from "../needs-you-union.js";

const SESSION = "63bc4338-0000-4000-8000-000000000000";

// The shape `createDevApprovalProposal` stores: the payload, flat, plus the
// summary and changeType it stamps.
const deployRow = (
  id: string,
  data: Record<string, unknown>
): ClusterInputRow => ({
  id,
  proposalType: "dev.deploy_approval",
  targetType: "focus_session",
  targetId: SESSION,
  sessionId: SESSION,
  createdAt: new Date("2026-10-31T10:00:00Z"),
  workspaceId: null,
  data: {
    sessionId: SESSION,
    repo: "Synap-core/control-plane-api",
    branch: "main",
    commitSha: "a524c103d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
    gateReport: { passed: true },
    targetHost: "control-plane-api main",
    deployCommand: "git push origin a524c103:main",
    step: "push",
    changeType: "deploy_approval",
    summary: "Push a524c103 to main in Synap-core/control-plane-api",
    ...data,
  },
});

describe("a deploy approval's needs-you row", () => {
  it("is titled with the approval's heading, not the session", () => {
    const [cluster] = collapseProposalsToClusters([deployRow("p1", {})]);
    const signal = signalFromCluster(cluster!);
    expect(signal.title).toBe(
      "Push a524c103 to main in Synap-core/control-plane-api"
    );
    expect(signal.title).toBe(
      describeDevDeployProposal({
        proposalType: "dev.deploy_approval",
        data: deployRow("p1", {}).data,
      })!.title
    );
    expect(signal.title).not.toMatch(/Session|Approve deploy/);
  });

  it("two asks of one session (a push, then a deploy of another commit) stay two rows, each with its own heading", () => {
    const clusters = collapseProposalsToClusters([
      deployRow("p1", {}),
      deployRow("p2", {
        step: "deploy",
        commitSha: "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
        targetHost: "https://cp.synap.live",
        deployCommand: "vercel deploy --prod",
        summary:
          "Deploy b1c2d3e4 from Synap-core/control-plane-api to cp.synap.live",
      }),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => signalFromCluster(c).title).sort()).toEqual([
      "Deploy b1c2d3e4 from Synap-core/control-plane-api to cp.synap.live",
      "Push a524c103 to main in Synap-core/control-plane-api",
    ]);
  });

  it("the same ask filed twice is still one row", () => {
    const clusters = collapseProposalsToClusters([
      deployRow("p1", {}),
      deployRow("p2", {}),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(2);
  });
});
