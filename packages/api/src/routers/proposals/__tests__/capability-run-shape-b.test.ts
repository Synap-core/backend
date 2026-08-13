import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Workstream 1, Part B (Shape B) — regression lock for the "approved
 * capability/run silently does nothing" bug the read-only dossier root-caused:
 * for `capabilityKind: "skill" | "command"` the executor flipped the proposal
 * to APPROVED with NO execution ("wired by Wave 3b" never landed — see the
 * comment it replaces). This proves the `capability/run` executor now calls
 * `runResolvedSkill` (the SAME post-gate runner the door + `capability.run`
 * executor use) for a skill/command proposal, and that its result is
 * materialized into `proposals.data.runResult` — while the `tool` branch
 * (execute-provider-verb path) is untouched (no shared code path, no
 * double-execute risk).
 *
 * DB + `runResolvedSkill` are mocked (no live Postgres here — mirrors
 * dispatch-external-once.test.ts / batch-approve-registry.test.ts's
 * documented no-DB style for this suite).
 */

const { mockDb, mockRunResolvedSkill } = vi.hoisted(() => ({
  mockDb: { select: vi.fn(), update: vi.fn() },
  mockRunResolvedSkill: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    eq: vi.fn((column: unknown, value: unknown) => ({ eq: [column, value] })),
    and: vi.fn((...conditions: unknown[]) => ({
      and: conditions.filter((c) => c !== undefined),
    })),
  };
});

vi.mock("../../../services/capabilities/execute-capability.js", () => ({
  runResolvedSkill: mockRunResolvedSkill,
  // Also imported by executors/capability.ts, executors/messaging.ts, and
  // executors/provider.ts (all loaded transitively via
  // registerApproveExecutors()). Stub as "target resolves" (null = no
  // failure) so the pre-existing skill/command flow under test is unaffected.
  assertApprovalTargetResolves: vi.fn(async () => null),
}));

import { proposalExecRegistry } from "../execution-registry.js";
import { registerApproveExecutors } from "../approve-executors.js";
import type { ProposalExecutorArgs } from "../execution-registry.js";

/** A `SELECT ... .from(...).where(...).limit(1)` chain resolving to `rows`. */
function selectLimitChain(rows: unknown[]) {
  const chain = { from: vi.fn(), where: vi.fn(), limit: vi.fn() };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue(rows);
  return chain;
}

/**
 * A `SELECT ... .from(...).where(...)` chain with NO `.limit()` — resolves
 * directly on `.where()` (the "already APPROVED?" idempotency-guard query's
 * shape, which the executor destructures without a `.limit(1)`).
 */
function selectWhereOnlyChain(rows: unknown[]) {
  const chain = { from: vi.fn(), where: vi.fn() };
  chain.from.mockReturnValue(chain);
  chain.where.mockResolvedValue(rows);
  return chain;
}

/** The at-most-once CAS claim update `dispatchExternalOnce` issues. */
function updateChain(claimed: boolean) {
  const chain = { set: vi.fn(), where: vi.fn(), returning: vi.fn() };
  chain.set.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.returning.mockResolvedValue(claimed ? [{ id: "p1" }] : []);
  return chain;
}

const PROPOSAL: ProposalExecutorArgs["proposal"] = {
  id: "p1",
  targetType: "capability",
  targetId: "skill-1",
  proposalType: "run",
  workspaceId: "ws-1",
  sessionId: null,
  projectId: null,
  agentUserId: "agent-1",
  sourceMessageId: null,
  data: {
    capabilityKind: "skill",
    capabilityId: "skill-1",
    input: { to: "a@b.com" },
    workspaceId: "ws-1",
  },
};

function args(): ProposalExecutorArgs {
  return {
    proposal: PROPOSAL,
    payload: null,
    userId: "user-1",
    input: { proposalId: "p1" },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps: {
      reportProposalOutcome: vi.fn(),
      emitProposalReviewed: vi.fn(),
    } as unknown as ProposalExecutorArgs["deps"],
  };
}

// `registerApproveExecutors()` is a module-singleton (registers exactly once
// — see its `registered` guard), so it must run ONCE, before any test resets
// the registry — a per-test `_reset()` + re-register would silently no-op on
// the 2nd+ test (the guard skips re-registering into the now-empty registry).
registerApproveExecutors();

describe("capability/run executor — Shape B (skill/command) now executes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls runResolvedSkill and materializes its result (was: silent no-op)", async () => {
    // 1) the "already APPROVED?" idempotency-guard select.
    // 2) the skill row lookup by capabilityId.
    mockDb.select
      .mockReturnValueOnce(selectWhereOnlyChain([{ status: "pending" }]))
      .mockReturnValueOnce(
        selectLimitChain([
          {
            id: "skill-1",
            name: "gmail.send",
            kind: "code",
            providerSpec: null,
          },
        ])
      );

    // dispatchExternalOnce's CAS claim, then the final status-flip update.
    const claimUpdate = updateChain(true);
    const statusUpdate = updateChain(true);
    mockDb.update
      .mockReturnValueOnce(claimUpdate)
      .mockReturnValueOnce(statusUpdate);

    mockRunResolvedSkill.mockResolvedValue({
      kind: "run",
      skillId: "skill-1",
      result: { sent: true },
    });

    const executor = proposalExecRegistry.resolve("capability/run", "run");
    expect(executor).toBeDefined();

    const result = await executor!.execute(args());

    expect(result).toEqual({ success: true });
    // THE regression check: the skill/command branch actually ran the skill.
    expect(mockRunResolvedSkill).toHaveBeenCalledTimes(1);
    expect(mockRunResolvedSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: "skill-1" }),
      { to: "a@b.com" },
      expect.objectContaining({ userId: "user-1", workspaceId: "ws-1" })
    );
    // The result is materialized into `data`, not dropped (statusUpdate.set's
    // sole call captures the final .set({...}) payload).
    const setPayload = statusUpdate.set.mock.calls[0]?.[0];
    expect(setPayload.status).toBe("approved");
    expect(setPayload.data).toMatchObject({
      capabilityKind: "skill",
      runResult: { sent: true },
    });
  });

  it("does NOT execute the tool branch's code path for a skill/command proposal (no shared path)", async () => {
    mockDb.select
      .mockReturnValueOnce(selectWhereOnlyChain([{ status: "pending" }]))
      .mockReturnValueOnce(
        selectLimitChain([
          {
            id: "skill-1",
            name: "gmail.send",
            kind: "code",
            providerSpec: null,
          },
        ])
      );
    mockDb.update
      .mockReturnValueOnce(updateChain(true))
      .mockReturnValueOnce(updateChain(true));
    mockRunResolvedSkill.mockResolvedValue({
      kind: "run",
      skillId: "skill-1",
      result: {},
    });

    const executor = proposalExecRegistry.resolve("capability/run", "run");
    await executor!.execute(args());

    // triggerProviderAction (the tool branch's dispatch) is never invoked for
    // a skill/command proposal — confirmed indirectly: no `.set()` call ever
    // materializes a `providerResult` shape (that would mean the tool branch
    // ran instead of / in addition to the skill branch).
    const allSetCalls = mockDb.update.mock.results
      .flatMap((r) => r.value?.set?.mock?.calls ?? [])
      .flat();
    for (const call of allSetCalls) {
      expect(call).not.toHaveProperty("data.providerResult");
    }
  });
});
