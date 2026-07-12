import { describe, it, expect } from "vitest";
import { dryRunAgentGovernanceDecision } from "./resolve-agent-governance-decision.js";

/**
 * Minimal fake db: a queue of `.limit(1)` results, consumed in call order.
 * `resolveAgentGovernanceDecision` always queries the agent user row first,
 * then (only when workspaceId is set) the workspace row.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(resultsQueue: any[][]): any {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => resultsQueue.shift() ?? [],
        }),
      }),
    }),
  };
}

const AGENT_ROW = {
  userType: "agent",
  agentMetadata: { autoApproveFor: ["entity.create"] },
};

describe("dryRunAgentGovernanceDecision", () => {
  it("is side-effect free: never touches db.insert (no such method on the fake db)", async () => {
    const db = makeDb([
      [AGENT_ROW],
      [{ settings: {}, workspaceType: "personal" }],
    ]);
    // The fake db has no `.insert` — if the dry-run ever reached a write
    // path, this would throw "db.insert is not a function".
    await expect(
      dryRunAgentGovernanceDecision({
        db,
        agentUserId: "agent-1",
        workspaceId: "ws-1",
        subjectType: "entity",
        action: "create",
        door: "chat",
      })
    ).resolves.toBeDefined();
  });

  it("chat door: prefers agentMetadata.autoApproveFor over the workspace override", async () => {
    // Agent metadata whitelists entity.create; workspace override does NOT.
    const db = makeDb([
      [AGENT_ROW],
      [
        {
          settings: { aiGovernance: { autoApproveFor: ["document.read"] } },
          workspaceType: "personal",
        },
      ],
    ]);

    const verdict = await dryRunAgentGovernanceDecision({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      door: "chat",
    });

    expect(verdict.outcome).toBe("auto");
    expect(verdict.rung).toBe("workspace-auto-approve-for");
  });

  it("automation door: workspace override wins, agentMetadata.autoApproveFor is IGNORED", async () => {
    // Agent metadata whitelists entity.create, but the automation door must
    // consult ONLY the workspace override — which does not whitelist it. Once
    // a workspace has an EXPLICIT autoApproveFor list, it fully replaces
    // DEFAULT_AUTO_APPROVE (decideAgentPolicy rungs 4 and 8 both key off the
    // same explicit list — there is no merge/fallback), so this proposes.
    const db = makeDb([
      [AGENT_ROW],
      [
        {
          settings: { aiGovernance: { autoApproveFor: ["document.read"] } },
          workspaceType: "personal",
        },
      ],
    ]);

    const verdict = await dryRunAgentGovernanceDecision({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      door: "automation",
    });

    expect(verdict.outcome).toBe("propose");
    expect(verdict.rung).toBe("default");
  });

  it("chat vs automation door produce DIFFERENT verdicts for the same write (the door-aware precedence, proven end to end)", async () => {
    const makeSameFixture = () =>
      makeDb([
        [AGENT_ROW],
        [
          {
            settings: { aiGovernance: { autoApproveFor: ["document.read"] } },
            workspaceType: "personal",
          },
        ],
      ]);

    const chatVerdict = await dryRunAgentGovernanceDecision({
      db: makeSameFixture(),
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      door: "chat",
    });
    const automationVerdict = await dryRunAgentGovernanceDecision({
      db: makeSameFixture(),
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      door: "automation",
    });

    expect(chatVerdict.outcome).toBe("auto"); // agent's own autoApproveFor wins
    expect(automationVerdict.outcome).toBe("propose"); // workspace override only, doesn't cover it
  });

  it("automation door propose case: neither workspace override nor default whitelist covers the action", async () => {
    const db = makeDb([
      [AGENT_ROW],
      [
        {
          settings: { aiGovernance: { autoApproveFor: ["document.read"] } },
          workspaceType: "personal",
        },
      ],
    ]);

    const verdict = await dryRunAgentGovernanceDecision({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "delete", // destructive → always propose regardless of any whitelist
      door: "automation",
    });

    expect(verdict.outcome).toBe("propose");
    expect(verdict.rung).toBe("destructive-actions-hard-floor");
  });

  it("not-agent actor → reports auto with a not-agent rung, never denies", async () => {
    const db = makeDb([[{ userType: "human", agentMetadata: null }]]);

    const verdict = await dryRunAgentGovernanceDecision({
      db,
      agentUserId: "human-1",
      workspaceId: null,
      subjectType: "entity",
      action: "create",
      door: "chat",
    });

    expect(verdict.outcome).toBe("auto");
    expect(verdict.rung).toBe("not-agent");
  });

  it("admin action always proposes regardless of door", async () => {
    const db = makeDb([
      [AGENT_ROW],
      [{ settings: {}, workspaceType: "personal" }],
    ]);

    const verdict = await dryRunAgentGovernanceDecision({
      db,
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "workspace",
      action: "update",
      door: "automation",
    });

    expect(verdict.outcome).toBe("propose");
    expect(verdict.rung).toBe("admin-actions");
  });
});
