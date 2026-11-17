import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * KEY GAP (founder, 17 Nov 2026): a person edits a tool run's text on the
 * review card ("Approve with your changes"). The edit travels the ONE revise
 * door (`computeRevisedEnvelope`, the pure core `mergeProposalRevision` runs),
 * and approval must RUN the revised arguments, not the agent's originals.
 *
 * This feeds the revised stored envelope to the real `capability.run`
 * executor and asserts `runResolvedSkill` receives the revised text, the
 * revision history records proposed -> approved, and that the identity fields
 * stay pinned.
 *
 * NEGATIVE CONTROL: run the executor on the ORIGINAL envelope (the second
 * test) and the assertion on the revised text fails; patching `parameters`
 * into a nested `data.data` slot instead of the flat envelope (what a revise
 * that missed the executor's slot would do) turns the first test red.
 */

const { mockDb, mockRunResolvedSkill } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    update: vi.fn(),
    // The proposal door's one statement (`WITH … UPDATE`).
    $with: () => ({ as: () => ({}) }),
    with() {
      return this;
    },
  },
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


import { computeRevisedEnvelope } from "../../../services/proposals/proposals-service.js";

const isSecretName = (key: string) => /key|token|secret|password/i.test(key);

const ORIGINAL = {
  skillId: "skill-1",
  verbId: "unipile_linkedin_publish_post",
  parameters: { text: "Hello world", accountId: "acc-1", apiKey: "sk-1", limit: 3 },
  targetType: "capability",
  changeType: "run",
  requestId: "req-1",
};

function proposalWith(data: Record<string, unknown>): ProposalExecutorArgs["proposal"] {
  return {
    id: "p1",
    targetType: "capability",
    targetId: "skill-1",
    proposalType: "capability.run",
    workspaceId: "ws-1",
    sessionId: null,
    projectId: null,
    agentUserId: "agent-1",
    sourceMessageId: null,
    data,
  };
}

function argsFor(data: Record<string, unknown>): ProposalExecutorArgs {
  return {
    proposal: proposalWith(data),
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

function primeDb() {
  mockDb.select
    .mockReturnValueOnce(selectWhereOnlyChain([{ status: "pending" }]))
    .mockReturnValueOnce(
      selectLimitChain([
        {
          id: "skill-1",
          name: "unipile_linkedin_publish_post",
          kind: "code",
          providerSpec: null,
          approved: true,
        },
      ])
    );
  mockDb.update
    .mockReturnValueOnce(updateChain(true))
    .mockReturnValueOnce(updateChain(true));
  mockRunResolvedSkill.mockResolvedValue({
    kind: "run",
    skillId: "skill-1",
    result: { posted: true },
  });
}

registerApproveExecutors();

describe("a revised tool-run argument is the one approval runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the person's text, and records proposed -> approved on the chain", async () => {
    const { merged, revision } = computeRevisedEnvelope({
      proposalType: "capability.run",
      envelope: ORIGINAL,
      patch: {
        kind: "envelope",
        fields: { parameterEdits: { text: "Hello, LinkedIn" } },
      },
      actorId: "user-1",
      isSecretName,
    });
    // The identity the approve path keys on is untouched.
    expect(merged.targetType).toBe("capability");
    expect(merged.changeType).toBe("run");
    expect(merged.skillId).toBe("skill-1");
    // The chain carries both sides.
    // Only the changed key rides the chain: no credential, no other argument.
    expect(revision.before).toEqual({ parameters: { text: "Hello world" } });
    expect(revision.patch).toEqual({ parameters: { text: "Hello, LinkedIn" } });
    expect(JSON.stringify(revision)).not.toContain("sk-1");
    expect(merged).not.toHaveProperty("parameterEdits");

    primeDb();
    const executor = proposalExecRegistry.resolve("capability/capability.run", "capability.run");
    expect(executor).toBeDefined();
    await executor!.execute(argsFor(merged));

    expect(mockRunResolvedSkill).toHaveBeenCalledTimes(1);
    expect(mockRunResolvedSkill).toHaveBeenCalledWith(
      expect.objectContaining({ id: "skill-1" }),
      { text: "Hello, LinkedIn", accountId: "acc-1", apiKey: "sk-1", limit: 3 },
      expect.objectContaining({ userId: "user-1" })
    );
  });

  it("runs the agent's original text when nothing was revised", async () => {
    primeDb();
    const executor = proposalExecRegistry.resolve("capability/capability.run", "capability.run");
    await executor!.execute(argsFor(ORIGINAL));
    expect(mockRunResolvedSkill).toHaveBeenCalledWith(
      expect.anything(),
      ORIGINAL.parameters,
      expect.anything()
    );
  });
});

describe("the edit scope is text arguments only", () => {
  const edit = (fields: Record<string, unknown>, proposalType = "capability.run") =>
    computeRevisedEnvelope({
      proposalType,
      envelope: ORIGINAL,
      patch: { kind: "envelope", fields },
      actorId: "user-1",
      isSecretName,
    });

  it("refuses a credential argument", () => {
    expect(() => edit({ parameterEdits: { apiKey: "x" } })).toThrow(/credential/);
  });
  it("refuses an argument that is not text, or not there", () => {
    expect(() => edit({ parameterEdits: { limit: "9" } })).toThrow(/not a text argument/);
    expect(() => edit({ parameterEdits: { nope: "9" } })).toThrow(/not a text argument/);
  });
  it("refuses a non-text new value", () => {
    expect(() => edit({ parameterEdits: { text: 5 } })).toThrow(/only be changed to text/);
  });
  it("refuses both a whole `parameters` and edits, and other proposal types", () => {
    expect(() =>
      edit({ parameterEdits: { text: "a" }, parameters: {} })
    ).toThrow(/not both/);
    expect(() => edit({ parameterEdits: { text: "a" } }, "document.update")).toThrow(
      /Only a tool run/
    );
  });
});
