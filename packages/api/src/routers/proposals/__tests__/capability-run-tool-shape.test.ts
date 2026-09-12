import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A TOOL-shaped capability-run proposal must execute when approved.
 *
 * THE BUG THIS PINS. The proposal-type literal was unified to
 * `CAPABILITY_RUN_PROPOSAL_TYPE` ("capability.run"). The tool-execute door
 * (external-dispatch.ts) therefore files `targetType:"capability"` +
 * `proposalType:"capability.run"` with a TOOL payload `{capabilityKind:"tool",
 * capabilityId, provider, method, path, body}`. `resolve()` tries the exact
 * composite "capability/capability.run" (unregistered), then the
 * proposalType-only "capability.run", which is the SKILL executor. It threw
 * "capability.run requires skillId" before any tool handling, so an agent's
 * governed tool call could be proposed but NEVER run once approved.
 * `proposal-class.ts` claimed all three spellings reach one executor; they
 * did not.
 *
 * WHAT MAKES THIS DISCRIMINATING. The existing registry test registers STUBS
 * under every key and counts that dispatch reached SOME key. That is correct
 * for routing by key, but it cannot see a payload SHAPE landing on an executor
 * that does not understand it. These cases run the REAL executors through the
 * REAL `resolve()`, and pair the tool shape with a SKILL shape under the SAME
 * key, asserting each shape REACHES its runner. Negative controls, both run:
 * removing the delegation fails the tool case; delegating EVERY capability.run
 * fails the skill case.
 *
 * DB and the two side-effecting doors are mocked (no live Postgres), mirroring
 * capability-run-shape-b.test.ts. Every mock spreads `importOriginal`: a total
 * `vi.mock` silently kills the whole file when the source gains an import.
 */

const { mockDb, mockRunResolvedSkill, mockTriggerProviderAction } = vi.hoisted(
  () => ({
    mockDb: { select: vi.fn(), update: vi.fn() },
    mockRunResolvedSkill: vi.fn(),
    mockTriggerProviderAction: vi.fn(),
  })
);

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

vi.mock(
  "../../../services/capabilities/execute-capability.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../services/capabilities/execute-capability.js")
      >();
    return {
      ...actual,
      runResolvedSkill: mockRunResolvedSkill,
      assertApprovalTargetResolves: vi.fn(async () => null),
    };
  }
);

vi.mock("../../../connectors/external-dispatch.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../connectors/external-dispatch.js")
    >();
  return { ...actual, triggerProviderAction: mockTriggerProviderAction };
});

import { proposalExecRegistry } from "../execution-registry.js";
import { registerApproveExecutors } from "../approve-executors.js";
import type { ProposalExecutorArgs } from "../execution-registry.js";

/**
 * One chain that serves every query shape the executors issue:
 * `.from().where()` awaited directly, `.from().where().limit(n)`, and
 * `.update().set().where().returning()`. Rows default to a pending proposal.
 */
function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of [
    "from",
    "where",
    "set",
    "innerJoin",
    "leftJoin",
    "orderBy",
  ]) {
    c[m] = vi.fn(() => c);
  }
  c.limit = vi.fn(async () => rows);
  c.returning = vi.fn(async () => rows);
  c.then = (resolve: (v: unknown) => unknown) => resolve(rows);
  return c;
}

function proposal(
  proposalType: string,
  data: Record<string, unknown>
): ProposalExecutorArgs["proposal"] {
  return {
    id: "p1",
    targetType: "capability",
    targetId: "cap-1",
    proposalType,
    workspaceId: "ws-1",
    sessionId: null,
    projectId: null,
    agentUserId: "agent-1",
    sourceMessageId: null,
    data,
  };
}

function args(p: ProposalExecutorArgs["proposal"]): ProposalExecutorArgs {
  return {
    proposal: p,
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

/** Resolve exactly the way the approve mutation does, then run it. */
async function approve(p: ProposalExecutorArgs["proposal"]) {
  const executor = proposalExecRegistry.resolve(
    `${p.targetType}/${p.proposalType}`,
    p.proposalType
  );
  expect(
    executor,
    `no executor for ${p.targetType}/${p.proposalType}`
  ).toBeDefined();
  return executor!.execute(args(p));
}

const TOOL_DATA = {
  capabilityKind: "tool",
  capabilityId: "tool-1",
  provider: "freellmapi_set_routing_strategy",
  method: "POST",
  path: "/set_routing_strategy",
  body: { strategy: "reliable" },
  workspaceId: "ws-1",
};

// Module singleton: register once, before any test (see shape-b's note).
registerApproveExecutors();

describe("approving a capability-run proposal routes by PAYLOAD SHAPE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockImplementation(() => chain([{ status: "pending" }]));
    mockDb.update.mockImplementation(() => chain([{ id: "p1" }]));
    mockTriggerProviderAction.mockResolvedValue({ success: true });
    mockRunResolvedSkill.mockResolvedValue({
      kind: "ok",
      result: { ok: true },
    });
  });

  it("a TOOL payload filed as capability.run executes the tool call (was: threw 'requires skillId')", async () => {
    await expect(
      approve(proposal("capability.run", TOOL_DATA))
    ).resolves.toMatchObject({ success: true });

    expect(mockTriggerProviderAction).toHaveBeenCalledTimes(1);
    expect(mockTriggerProviderAction).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "freellmapi_set_routing_strategy",
        method: "POST",
        path: "/set_routing_strategy",
        body: { strategy: "reliable" },
        // The governed re-entry: must NOT loop back into a new proposal.
        alreadyApproved: true,
        sourceProposalId: "p1",
      })
    );
    expect(mockRunResolvedSkill).not.toHaveBeenCalled();
  });

  it("the legacy spelling capability/run executes the same tool call", async () => {
    await expect(approve(proposal("run", TOOL_DATA))).resolves.toMatchObject({
      success: true,
    });
    expect(mockTriggerProviderAction).toHaveBeenCalledTimes(1);
  });

  it("a SKILL payload under capability.run still reaches the skill runner", async () => {
    // The discriminating pair for the case above: same key, other shape.
    //
    // Asserts POSITIVE reachability — the skill shape ARRIVES at
    // runResolvedSkill — not merely that the tool call was avoided. The first
    // version asserted only `triggerProviderAction` not called, behind a
    // `.catch(() => undefined)`. Against a "delegate every capability.run"
    // mutant it stayed GREEN: the skill payload was delegated, threw "requires
    // capabilityKind", the catch swallowed it, and "no tool call" still held.
    // Avoiding the wrong door is not the same fact as reaching the right one.
    mockDb.select.mockImplementation(() =>
      chain([{ status: "pending", id: "skill-1", name: "x", kind: "code" }])
    );
    await approve(
      proposal("capability.run", { skillId: "skill-1", parameters: { a: 1 } })
    ).catch(() => undefined); // the skill runner's own post-steps are not under test

    expect(mockRunResolvedSkill).toHaveBeenCalledTimes(1);
    expect(mockTriggerProviderAction).not.toHaveBeenCalled();
  });

  it("a payload with neither shape still fails loudly, never silently succeeds", async () => {
    await expect(
      approve(proposal("capability.run", { parameters: {} }))
    ).rejects.toThrow(/requires skillId/);
    expect(mockTriggerProviderAction).not.toHaveBeenCalled();
  });
});
