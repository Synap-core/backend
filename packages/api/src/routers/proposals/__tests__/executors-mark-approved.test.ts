import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An approved proposal must be MARKED approved by its executor.
 *
 * THE BUG THIS PINS: the `aiProvider` executors applied the change and pushed it
 * to the IS but never set `status: APPROVED`. The registry dispatch does not do
 * it for you — every other executor does it itself — so an approved provider
 * change stayed `pending` forever: still in the review queue, and re-approving
 * it re-ran the write. Observed live (proposal e388f1e5, row written, status
 * pending, reviewedBy null).
 */

const { updates, emitted } = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  emitted: [] as unknown[][],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const rows = () => {
    const found = Promise.resolve([{ status: "pending", systemData: {} }]);
    return Object.assign(found, { limit: () => found });
  };
  const chain = {
    from: () => chain,
    where: rows,
    set: (v: Record<string, unknown>) => {
      updates.push(v);
      return { where: async () => undefined };
    },
  };
  return {
    ...actual,
    getWorkspaceMembership: async () => ({ role: "owner" }),
    db: {
      select: () => chain,
      update: () => ({ set: chain.set }),
      insert: () => ({ values: async () => undefined }),
      delete: () => ({ where: async () => undefined }),
      query: { aiProviders: { findFirst: async () => null } },
    },
  };
});
vi.mock("../../../utils/push-providers-to-is.js", () => ({
  pushProvidersToIS: vi.fn(async () => undefined),
}));
const { skillUpdates } = vi.hoisted(() => ({
  skillUpdates: [] as unknown[],
}));
vi.mock("../../playbooks.js", () => ({
  playbooksRouter: {
    createCaller: () => ({
      archive: async () => ({ success: true, status: "archived" }),
    }),
  },
}));
vi.mock("../../skills.js", () => ({
  skillsRouter: {
    createCaller: () => ({
      update: async (input: unknown) => {
        skillUpdates.push(input);
        return { status: "applied" };
      },
    }),
  },
}));

import { proposalExecRegistry } from "../execution-registry.js";
import { registerAiProviderExecutors } from "../executors/ai-provider.js";
import { registerSkillExecutors } from "../executors/skill.js";
import { registerPlaybookExecutors } from "../executors/playbook.js";
import { registerEntityExecutors } from "../executors/entity.js";
import { ProposalStatus } from "@synap/database/schema";

registerAiProviderExecutors();
registerSkillExecutors();
registerPlaybookExecutors();
registerEntityExecutors();

function run(
  key: string,
  data: Record<string, unknown>,
  targetType = "aiProvider",
  workspaceId: string | null = null
) {
  const ex = proposalExecRegistry.resolve(key, key.split("/")[1]);
  expect(ex, key).toBeDefined();
  return ex!.execute({
    proposal: {
      id: "p1",
      targetType,
      targetId: "t1",
      proposalType: key.split("/")[1]!,
      workspaceId,
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      data,
    },
    payload: null,
    userId: "human-1",
    input: { proposalId: "p1" },
    ctx: {} as never,
    deps: {
      reportProposalOutcome: vi.fn(),
      emitProposalReviewed: vi.fn((...a: unknown[]) => emitted.push(a)),
    } as never,
  });
}

beforeEach(() => {
  updates.length = 0;
  emitted.length = 0;
  skillUpdates.length = 0;
});

describe("aiProvider executors mark the proposal approved", () => {
  it("create: applies AND flips status, attributed to the approver", async () => {
    await run("aiProvider/create", {
      providerId: "freellmapi",
      name: "FreeLLMAPI",
      baseUrl: "http://eve-brain-freellmapi:3001/v1",
      priority: 90,
      enabled: true,
      models: [{ id: "auto", tier: "free" }],
    });
    const flip = updates.find((u) => u.status === ProposalStatus.APPROVED);
    expect(flip).toMatchObject({
      status: ProposalStatus.APPROVED,
      reviewedBy: "human-1",
    });
    expect(emitted).toContainEqual(["p1", null, "approved", "human-1"]);
  });

  it("delete: flips status too", async () => {
    await run("aiProvider/delete", { providerId: "freellmapi" });
    expect(updates.some((u) => u.status === ProposalStatus.APPROVED)).toBe(
      true
    );
  });
});

// The file-level convention below cannot see this one: skill.ts sets APPROVED
// in its create and delete executors, so a missing flip in `skill/update`
// passed it (proposal bf90d6a2 stayed pending after two approvals).
describe("skill/update marks the proposal approved", () => {
  it("replays the update AND flips status, attributed to the approver", async () => {
    await run(
      "skill/update",
      { data: { id: "skill-1", body: "new body" } },
      "skill"
    );
    expect(skillUpdates).toEqual([{ id: "skill-1", body: "new body" }]);
    const flip = updates.find((u) => u.status === ProposalStatus.APPROVED);
    expect(flip).toMatchObject({
      status: ProposalStatus.APPROVED,
      reviewedBy: "human-1",
    });
    expect(emitted).toContainEqual(["p1", null, "approved", "human-1"]);
  });
});

// Same defect, same blind spot: entity.ts and playbook.ts set APPROVED in
// other executors, so the file-level convention passed these two.
describe("playbook/archive and entity/renderer.set mark the proposal approved", () => {
  it.each([
    ["playbook/archive", "playbook", "ws-1", { id: "pb-1" }],
    [
      "entity/renderer.set",
      "entity",
      null,
      { data: { entityId: "e-1", ref: { kind: "cell", cellKey: "k" } } },
    ],
  ] as const)(
    "%s flips status, attributed to the approver",
    async (key, type, ws, data) => {
      await run(key, { ...data }, type, ws);
      const flip = updates.find((u) => u.status === ProposalStatus.APPROVED);
      expect(flip).toMatchObject({
        status: ProposalStatus.APPROVED,
        reviewedBy: "human-1",
      });
      expect(emitted).toContainEqual(["p1", ws, "approved", "human-1"]);
    }
  );
});

// The file-level convention that lived here ("every executor file sets
// `status: ProposalStatus.APPROVED`") was blind per executor (#427: a file that
// flipped in one executor passed for all of them), and executors now flip
// through the status door (`transitionProposal`), so a source scan has nothing
// literal to find. Its replacement reads the ROW: the approval tail's
// postcondition (`assertApprovalLanded`), pinned behaviourally by
// `approval-postcondition.pglite.test.ts`, and the derived tripwire
// `proposal-status-one-door` for every writer.
