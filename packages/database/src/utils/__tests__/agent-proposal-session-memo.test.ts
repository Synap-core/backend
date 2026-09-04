/**
 * ONE MINT PER REQUEST — the memo that keeps the hoisted agent-session
 * resolution off the per-row hot path.
 *
 * The gate (`checkPermissionOrPropose`) runs once PER WRITE, and one capture can
 * auto-approve ~1600 `entity.create` rows. Hoisting the session mint above the
 * propose/execute split fixes provenance coverage but would put up to two
 * queries plus a possible INSERT on every one of those rows. These tests pin the
 * property that makes the hoist affordable: the burst resolves ONCE.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockResolve } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
}));

vi.mock("../resolve-or-create-agent-proposal-session.js", () => ({
  resolveOrCreateAgentProposalSession: mockResolve,
}));

const { resolveAgentProposalSessionOnce, __resetAgentProposalSessionMemo } =
  await import("../agent-proposal-session-memo.js");

const BASE = {
  userId: "user-1",
  agentUserId: "agent-1",
  workspaceId: "ws-1",
  projectId: null,
  goal: "Agent create · entity",
  stableCorrelation: false,
};

describe("resolveAgentProposalSessionOnce", () => {
  beforeEach(() => {
    __resetAgentProposalSessionMemo();
    mockResolve.mockReset();
    mockResolve.mockResolvedValue("session-1");
  });

  it("resolves ONCE for a burst of identical writes", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => resolveAgentProposalSessionOnce(BASE))
    );

    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(new Set(results)).toEqual(new Set(["session-1"]));
  });

  it("shares the IN-FLIGHT resolution — concurrent rows never race N mints", async () => {
    let release: (v: string) => void = () => {};
    mockResolve.mockImplementation(
      () =>
        new Promise<string>((res) => {
          release = res;
        })
    );

    const pending = Promise.all([
      resolveAgentProposalSessionOnce(BASE),
      resolveAgentProposalSessionOnce(BASE),
      resolveAgentProposalSessionOnce(BASE),
    ]);
    release("session-inflight");

    expect(await pending).toEqual([
      "session-inflight",
      "session-inflight",
      "session-inflight",
    ]);
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it("memoizes a NULL result too — a failed mint must not stampede", async () => {
    mockResolve.mockResolvedValue(null);

    await resolveAgentProposalSessionOnce(BASE);
    await resolveAgentProposalSessionOnce(BASE);
    await resolveAgentProposalSessionOnce(BASE);

    expect(mockResolve).toHaveBeenCalledTimes(1);
  });

  it("keys on the tuple the resolver's own reuse ladder keys on", async () => {
    await resolveAgentProposalSessionOnce(BASE);
    await resolveAgentProposalSessionOnce({ ...BASE, agentUserId: "agent-2" });
    await resolveAgentProposalSessionOnce({ ...BASE, workspaceId: "ws-2" });
    await resolveAgentProposalSessionOnce({ ...BASE, goal: "another goal" });
    await resolveAgentProposalSessionOnce({ ...BASE, userId: "user-2" });

    expect(mockResolve).toHaveBeenCalledTimes(5);
  });

  it("normalizes the goal the same way the resolver does, so whitespace is not a second key", async () => {
    await resolveAgentProposalSessionOnce(BASE);
    await resolveAgentProposalSessionOnce({
      ...BASE,
      goal: "  Agent create   ·  entity  ",
    });

    expect(mockResolve).toHaveBeenCalledTimes(1);
  });
});
