/**
 * Approving an agent's worker enable or resume runs the overlap check (FB2
 * item 4, backend F7): a person may have enabled the same worker over the
 * same things since the proposal was filed. Real `rule/create` and
 * `rule/update` executors; the overlap check itself, the rule doors and the
 * db are stubbed (the check is proven in workers.pglite.test.ts).
 *
 * Rows rule out: a replay that never asks; a refusal that still writes the
 * rule; an update that leaves the rule a DRAFT being refused (it arms
 * nothing); the update path asking without the rule id (it could not read
 * the rule's own seed nor leave the rule out).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  overlap: false,
  asked: [] as Array<Record<string, unknown>>,
  created: 0,
  updated: 0,
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));
vi.mock("../../../services/playbooks/workers.js", () => {
  class WorkerScopeOverlapError extends Error {
    readonly reasonCode = "WORKER_SCOPE_OVERLAP";
  }
  return {
    WorkerScopeOverlapError,
    assertNoWorkerOverlap: async (input: Record<string, unknown>) => {
      h.asked.push(input);
      if (h.overlap) {
        throw new WorkerScopeOverlapError(
          "This worker already runs for this project."
        );
      }
    },
  };
});
vi.mock("../../../services/rules/create.js", () => ({
  createRuleGoverned: async () => {
    h.created++;
    return { status: "created", ruleId: "r-new", automationIds: [] };
  },
}));
vi.mock("../../../services/rules/update.js", () => ({
  updateRuleGoverned: async () => {
    h.updated++;
    return {
      status: "updated",
      ruleId: "r-1",
      automationIds: [],
      draft: false,
    };
  },
}));

const { proposalExecRegistry } = await import("../execution-registry.js");
const { registerRuleExecutors } = await import("../executors/rule.js");
registerRuleExecutors();

const SEED = {
  template: "playbook-worker:pb-1",
  key: "enters_status:review@project:p-1",
  hash: "h",
};
const deps = {
  emitProposalReviewed: () => undefined,
  reportProposalOutcome: () => undefined,
} as never;

function approve(key: string, data: Record<string, unknown>) {
  return proposalExecRegistry.resolveExact(key)!.execute({
    proposal: {
      id: "p-1",
      workspaceId: null,
      agentUserId: "agent-1",
      data: { data },
    } as never,
    payload: undefined,
    userId: "owner-1",
    input: { proposalId: "p-1" },
    deps,
  } as never);
}

beforeEach(() => {
  h.overlap = false;
  h.asked.length = 0;
  h.created = 0;
  h.updated = 0;
});

describe("rule/create — an agent's worker enable", () => {
  it("overlapping: CONFLICT, and no rule is written", async () => {
    h.overlap = true;
    await expect(
      approve("rule/create", { intent: "run review", scope: {}, seed: SEED })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.asked[0]).toMatchObject({ seed: { template: SEED.template } });
    expect(h.created).toBe(0);
  });

  it("free: the rule is written", async () => {
    await approve("rule/create", {
      intent: "run review",
      scope: {},
      seed: SEED,
    });
    expect(h.created).toBe(1);
  });
});

describe("rule/update — an agent's worker resume", () => {
  it("arming: asks with the rule id, CONFLICT when overlapping", async () => {
    h.overlap = true;
    await expect(
      approve("rule/update", { id: "r-1", intent: "run review", scope: {} })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.asked[0]).toMatchObject({ ruleId: "r-1" });
    expect(h.updated).toBe(0);
  });

  it("an edit that keeps it a draft arms nothing and is not asked", async () => {
    h.overlap = true;
    await approve("rule/update", {
      id: "r-1",
      intent: "run review",
      scope: {},
      draft: true,
    });
    expect(h.asked).toEqual([]);
    expect(h.updated).toBe(1);
  });
});
