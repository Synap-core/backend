/**
 * The receipt session an ambient agent write is packaged into must carry the
 * agent's DECLARED focus project — not `null`.
 *
 * MEASURED DEFECT (live, 2026-09-21). The project ladder's rung 3.5
 * (`getAgentFocusProjectId`, set through `synap_set_project_focus`) was read
 * BELOW the session mint in `createPendingProposalRow`. So the PROPOSAL row got
 * `focusProjectId` and the receipt SESSION minted a few lines earlier got
 * `projectId: input.projectId` — null on every ambient write. An evening of
 * lead sourcing for a project therefore landed in a FLOATING session, and the
 * project's page showed one unrelated session. Nothing was missing from the
 * ladder; only the call ORDER was wrong.
 *
 * THE DISCRIMINATING PAIR is explicit-vs-focus. A test that only asserts "the
 * session gets a project" passes on the old code whenever `input.projectId` was
 * supplied — which is the case the bug never touched. The input that separates
 * the two rules is: NO explicit projectId, but a focus project IS declared.
 *
 * WHAT THIS DOES NOT COVER, measured: it asserts what the door PASSES to
 * `resolveOrCreateAgentProposalSession` (which is mocked here, keeping this
 * DB-free). It does not prove `openRunSession` persists the column — that is
 * the session door's own contract, and `focus_sessions.projectId` is asserted
 * by the session-lens PGlite tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockResolveOrCreate, mockInsertPendingProposal, mockGetFocusProject } =
  vi.hoisted(() => ({
    mockResolveOrCreate: vi.fn(),
    mockInsertPendingProposal: vi.fn(),
    mockGetFocusProject: vi.fn(),
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
vi.mock("../services/agent-identity-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/agent-identity-service.js")
    >();
  return { ...actual, getAgentFocusProjectId: mockGetFocusProject };
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

const FOCUS_PROJECT = "11111111-1111-4111-8111-111111111111";
const EXPLICIT_PROJECT = "22222222-2222-4222-8222-222222222222";

const base = {
  userId: "user-1",
  workspaceId: "ws-1",
  targetId: "00000000-0000-4000-8000-000000000001",
  targetType: "entity",
  proposalType: "create",
  data: { title: "A sourced lead" },
  agentUserId: "agent-1",
};

const tx = {} as never;

/** What the door handed the session-mint door. */
const mintedWith = (): { projectId?: string | null } =>
  (mockResolveOrCreate.mock.calls[0]?.[0] ?? {}) as {
    projectId?: string | null;
  };

describe("the receipt session carries the agent's focus project", () => {
  beforeEach(() => {
    mockResolveOrCreate.mockReset().mockResolvedValue("pkg-session");
    mockInsertPendingProposal
      .mockReset()
      .mockResolvedValue({ proposal: { id: "p-1" }, deduped: false });
    mockGetFocusProject.mockReset().mockResolvedValue(null);
  });

  it("NON-VACUITY: the mint door is reached and receives an argument at all", async () => {
    // If the mint stops being called, every assertion below reads `undefined`
    // and would pass a `toBeNull()` by accident.
    await createPendingProposal({ ...base }, tx);
    expect(mockResolveOrCreate).toHaveBeenCalledTimes(1);
    expect(mockResolveOrCreate.mock.calls[0]?.[0]).toBeTypeOf("object");
  });

  it("THE DISCRIMINATING CASE: no explicit project + a declared focus → the session gets the FOCUS project", async () => {
    mockGetFocusProject.mockResolvedValue(FOCUS_PROJECT);
    await createPendingProposal({ ...base }, tx);
    expect(
      mintedWith().projectId,
      "the receipt session was minted with a null project while the agent had a " +
        "declared focus — this is the floating-session defect"
    ).toBe(FOCUS_PROJECT);
  });

  it("the focus lookup happens BEFORE the mint, not after", async () => {
    // Ordering is the actual fix. Assert it directly via invocation order so a
    // future edit that moves the read back below the mint goes red even if the
    // value assertion above were satisfied some other way.
    mockGetFocusProject.mockResolvedValue(FOCUS_PROJECT);
    await createPendingProposal({ ...base }, tx);
    expect(mockGetFocusProject).toHaveBeenCalled();
    expect(mockResolveOrCreate).toHaveBeenCalled();
    expect(mockGetFocusProject.mock.invocationCallOrder[0]).toBeLessThan(
      mockResolveOrCreate.mock.invocationCallOrder[0]
    );
  });

  it("an EXPLICIT project still wins over the focus (ladder order preserved)", async () => {
    mockGetFocusProject.mockResolvedValue(FOCUS_PROJECT);
    await createPendingProposal(
      { ...base, projectId: EXPLICIT_PROJECT } as never,
      tx
    );
    expect(mintedWith().projectId).toBe(EXPLICIT_PROJECT);
    // And the lookup must not even run — it is the lazy rung.
    expect(
      mockGetFocusProject,
      "rung 3.5 ran although a more specific rung already pinned the project"
    ).not.toHaveBeenCalled();
  });

  it("no explicit project and NO focus is still null — nothing is invented", async () => {
    await createPendingProposal({ ...base }, tx);
    expect(mintedWith().projectId ?? null).toBeNull();
  });
});
