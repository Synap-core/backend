/**
 * Seam test — `synap_governance` reports the CALLING agent's own budget.
 *
 * THE DEFECT: the tool answered "will my write propose?" (workspace policy +
 * a pod-wide pending count) and nothing else. It never named the per-agent
 * pending-proposal cap, never said how much of it the caller was using, and
 * never said whether the caller was BLOCKED — so an agent refused by the F2
 * cap had no read anywhere that would even name the limit it had hit, and
 * reported it as an unconfigurable runtime constant.
 *
 * These pin the VALUES arriving in the payload (not "a key is declared"), and
 * that the tool stays READ-ONLY: it may show a cap-raise request that is
 * already open, and must never file one.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const {
  mockVerifyWorkspaceAccess,
  mockGetEffectiveGovernance,
  mockCountPendingProposals,
  mockCountPendingAgentProposals,
  mockAgentProposalCap,
  mockFindOpenRaise,
  mockRequestRaiseProposalCap,
} = vi.hoisted(() => ({
  mockVerifyWorkspaceAccess: vi.fn().mockResolvedValue(true),
  mockGetEffectiveGovernance: vi
    .fn()
    .mockResolvedValue({ writesRequireProposal: true }),
  mockCountPendingProposals: vi.fn().mockResolvedValue(4),
  mockCountPendingAgentProposals: vi.fn(),
  mockAgentProposalCap: vi.fn(),
  mockFindOpenRaise: vi.fn().mockResolvedValue(null),
  mockRequestRaiseProposalCap: vi.fn(),
}));

vi.mock("../../hub-protocol/rest/_shared.js", () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
}));

vi.mock("../../../utils/permission-check.js", () => ({
  getEffectiveGovernance: mockGetEffectiveGovernance,
  countPendingAgentProposals: mockCountPendingAgentProposals,
  agentProposalCap: mockAgentProposalCap,
}));

vi.mock("../../../services/proposals/proposals-service.js", () => ({
  countPendingProposals: mockCountPendingProposals,
}));

vi.mock("../../../services/proposals/recommend-raise-proposal-cap.js", () => ({
  findOpenRaiseProposalCapRequest: mockFindOpenRaise,
  // Exported so a call to the FILER from this read-only tool would be visible
  // rather than throwing — the "never files" assertions below need that.
  requestRaiseProposalCap: mockRequestRaiseProposalCap,
}));

const { capabilityHandlers } = await import("./capability.js");

function ctx(extra: Record<string, unknown> = {}) {
  return {
    toolName: "synap_governance",
    args: { workspaceId: WS },
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    agentUserId: "agent-1",
    ...extra,
  } as never;
}

async function callGovernance(
  extra: Record<string, unknown> = {}
): Promise<Record<string, any>> {
  const res = (await capabilityHandlers.synap_governance!(ctx(extra))) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0]!.text);
}

describe("synap_governance — the calling agent's proposal budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetEffectiveGovernance.mockResolvedValue({
      writesRequireProposal: true,
    });
    mockCountPendingProposals.mockResolvedValue(4);
    mockFindOpenRaise.mockResolvedValue(null);
    process.env.PUBLIC_URL = "https://pod.test";
  });

  it("reports cap, pending count and blocked=false while under the cap", async () => {
    mockCountPendingAgentProposals.mockResolvedValue(3);
    mockAgentProposalCap.mockResolvedValue(10);

    const payload = await callGovernance();

    expect(payload.agentBudget).toMatchObject({
      agentUserId: "agent-1",
      pendingProposalCap: 10,
      pendingProposals: 3,
      blocked: false,
    });
    expect(payload.agentBudget.remedy).toContain("3 of 10");
    // The pre-existing fields are untouched.
    expect(payload.writesRequireProposal).toBe(true);
    expect(payload.pendingProposals).toBe(4);
  });

  it("reports blocked=true at the cap, and says the next write is refused", async () => {
    mockCountPendingAgentProposals.mockResolvedValue(10);
    mockAgentProposalCap.mockResolvedValue(10);

    const payload = await callGovernance();

    expect(payload.agentBudget.blocked).toBe(true);
    expect(payload.agentBudget.remedy).toContain("refused");
    expect(payload.agentBudget.remedy).toContain("frees a slot");
  });

  it("links the cap-raise request already waiting for the owner", async () => {
    mockCountPendingAgentProposals.mockResolvedValue(10);
    mockAgentProposalCap.mockResolvedValue(10);
    mockFindOpenRaise.mockResolvedValue("prop-open-raise");

    const payload = await callGovernance();

    expect(payload.agentBudget.pendingCapRaise).toEqual({
      proposalId: "prop-open-raise",
      reviewUrl: "https://pod.test/open/prop-open-raise",
    });
    expect(payload.agentBudget.remedy).toContain(
      "https://pod.test/open/prop-open-raise"
    );
    // READ-ONLY: it may show an open request, never file one.
    expect(mockRequestRaiseProposalCap).not.toHaveBeenCalled();
  });

  it("resolves the cap through the SAME helpers the refusal enforces with", async () => {
    // Not a re-derivation: if this tool computed the cap itself, the posture it
    // reports and the cap that actually refuses writes could disagree — which
    // is worse than not reporting it at all.
    mockCountPendingAgentProposals.mockResolvedValue(10);
    mockAgentProposalCap.mockResolvedValue(30);

    const payload = await callGovernance();

    expect(mockAgentProposalCap).toHaveBeenCalledWith("agent-1");
    expect(mockCountPendingAgentProposals).toHaveBeenCalledWith("agent-1");
    expect(payload.agentBudget.pendingProposalCap).toBe(30);
    expect(payload.agentBudget.blocked).toBe(false); // 10 < 30
  });

  it("omits agentBudget for a HUMAN key — the cap is per-agent and never applies", async () => {
    const payload = await callGovernance({ agentUserId: undefined });

    expect(payload.agentBudget).toBeUndefined();
    expect(mockAgentProposalCap).not.toHaveBeenCalled();
    // The policy read still works, so this is an omission, not a failure.
    expect(payload.writesRequireProposal).toBe(true);
  });

  it("a failed raise-link lookup degrades to 'no link known', never to 'no cap'", async () => {
    // An EMPTY result and a FAILED read are different facts: a lookup error
    // must not blank the cap numbers and let a blocked agent read as healthy.
    mockCountPendingAgentProposals.mockResolvedValue(10);
    mockAgentProposalCap.mockResolvedValue(10);
    mockFindOpenRaise.mockRejectedValue(new Error("db down"));

    const payload = await callGovernance();

    expect(payload.agentBudget.blocked).toBe(true);
    expect(payload.agentBudget.pendingProposalCap).toBe(10);
    expect(payload.agentBudget.pendingCapRaise).toBeUndefined();
  });

  it("keeps the workspace membership floor — no budget leaks on a forbidden read", async () => {
    mockVerifyWorkspaceAccess.mockResolvedValue(false);

    const payload = await callGovernance();

    expect(payload.error).toContain("Forbidden");
    expect(payload.agentBudget).toBeUndefined();
    expect(mockAgentProposalCap).not.toHaveBeenCalled();
  });
});
