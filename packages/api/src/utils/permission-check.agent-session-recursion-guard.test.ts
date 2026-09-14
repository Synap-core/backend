/**
 * The pending-proposal door must not mint an agent package session for a
 * proposal whose SUBJECT is a session.
 *
 * MEASURED DEFECT (live, 2026-09-13): `createPendingProposalRow` guarded on
 * `input.proposalType.startsWith("focus_session")`, but that door receives the
 * bare action ("create"). Every agent `synap_start_session` proposal therefore
 * also minted a junk "Start session …" package session (6 live, no channel,
 * next move "ready to close").
 *
 * The discriminating pair is the same action ("create") on two subjects: the
 * old rule mints for BOTH, the fixed rule only for the non-session subject.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockResolveOrCreate, mockInsertPendingProposal } = vi.hoisted(() => ({
  mockResolveOrCreate: vi.fn(),
  mockInsertPendingProposal: vi.fn(),
}));

// PARTIAL mock (importOriginal + spread) — see database-mock-total-ratchet.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    resolveOrCreateAgentProposalSession: mockResolveOrCreate,
    deriveAgentProposalSessionGoal: vi.fn(() => "Agent create"),
    insertPendingProposal: mockInsertPendingProposal,
    findExistingPendingDuplicate: vi.fn().mockResolvedValue(null),
  };
});
// The door reads the agent's focus project when no project was given; keep the
// test DB-free (partial mock, same reason as above).
vi.mock("../services/agent-identity-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/agent-identity-service.js")>();
  return { ...actual, getAgentFocusProjectId: vi.fn().mockResolvedValue(null) };
});
vi.mock("@synap-core/core", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { createPendingProposal } from "./permission-check.js";

const base = {
  userId: "user-1",
  workspaceId: "ws-1",
  targetId: "00000000-0000-4000-8000-000000000001",
  proposalType: "create",
  data: { goal: "Define the offer" },
  agentUserId: "agent-1",
};

// A tx handle makes the door skip post-commit notifications.
const tx = {} as never;

describe("agent package-session mint skips session subjects", () => {
  beforeEach(() => {
    mockResolveOrCreate.mockReset().mockResolvedValue("pkg-session");
    mockInsertPendingProposal
      .mockReset()
      .mockResolvedValue({ proposal: { id: "p-1" }, deduped: false });
  });

  it("does NOT mint a package session for a focus_session proposal", async () => {
    await createPendingProposal({ ...base, targetType: "focus_session" }, tx);
    expect(mockResolveOrCreate).not.toHaveBeenCalled();
  });

  it("still mints one for a non-session subject with the same bare action", async () => {
    await createPendingProposal({ ...base, targetType: "entity" }, tx);
    expect(mockResolveOrCreate).toHaveBeenCalledTimes(1);
  });

  it("never mints when the caller already named a session", async () => {
    await createPendingProposal(
      { ...base, targetType: "entity", sessionId: "s-1" },
      tx
    );
    expect(mockResolveOrCreate).not.toHaveBeenCalled();
  });
});
