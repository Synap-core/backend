import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Pod files to tools (decision 7d42be8c, founder 2026-10-28): an AGENT run
 * that carries one of the person's pod files to a tool ALWAYS files a
 * proposal, even on a granted verb. A pod app's credential is held to the
 * same floor. The person's own run in the pod is not.
 *
 * This file tries to DEFEAT the floor, one widening per row; each row rules
 * out one wrong placement:
 *  - an auto grant widening the agent run       → floor below the grant rung;
 *  - an auto governance rule widening it        → floor below the rule rung (2.8);
 *  - a verb claiming `readOnly`                 → floor below the read short-circuit;
 *  - a person token of an app (owner bypass)    → floor below the owner bypass;
 *  - a read intent run through an app           → floor folded into the app's
 *                                                 outward floor (reads pass it);
 * and three controls keep it honest:
 *  - the same agent run WITHOUT a file runs      (the floor is the file, not the agent);
 *  - the person's own run with a file runs       (the floor never reaches the person);
 *  - an unapproved verb is still denied          (the approval floor comes first).
 */

const grantMock = vi.fn();
const findCapabilityGrantMock = vi.fn();
const resolveGovernanceRuleMock = vi.fn();
const intentRows = new Map<string, { effect: string }>([
  ["publish_post", { effect: "write" }],
  ["list_records", { effect: "read" }],
]);

const T = {
  tools: { __t: "tools" },
  skills: { __t: "skills", id: "skills.id", intent: "skills.intent" },
  capabilityIntents: { __t: "ci", slug: "ci.slug", effect: "ci.effect" },
};

const fakeDb = {
  select: () => ({
    from: (table: { __t: string }) => ({
      where: async (cond: { b: string }) => {
        if (table.__t === "ci") {
          const row = intentRows.get(cond.b);
          return row ? [row] : [];
        }
        return [];
      },
    }),
  }),
};

vi.mock("@synap/database", () => ({
  getDb: async () => fakeDb,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  findCapabilityGrant: (...args: unknown[]) => findCapabilityGrantMock(...args),
  getRequestGrant: () => grantMock(),
}));

vi.mock("@synap/database/agent-governance", () => ({
  resolveGovernanceRule: (...args: unknown[]) =>
    resolveGovernanceRuleMock(...args),
  resolveOriginTrust: async () => undefined,
}));

vi.mock("@synap/database/schema", () => T);

const { gateCapabilityExecution, POD_FILE_OUTWARD } =
  await import("./index.js");

/** An agent running the person's approved fal edit verb (a widenable name). */
const agentRun = (over: object = {}) => ({
  capabilityKind: "skill" as const,
  capabilityId: "skill-1",
  skill: {
    id: "skill-1",
    approved: true,
    userId: "person-1",
    name: "fal_edit_reference_image",
    intent: "publish_post",
  },
  actorUserId: "person-1",
  agentUserId: "agent-1",
  workspaceId: "ws-1",
  carriesPodFiles: true,
  ...over,
});

const PROPOSES_FOR_THE_FILE = {
  decision: "propose",
  reasonCode: "POD_FILE_OUTWARD",
  proposalType: "run",
};

describe("gateCapabilityExecution — a run that sends a pod file proposes", () => {
  beforeEach(() => {
    grantMock.mockReset();
    grantMock.mockReturnValue(undefined);
    findCapabilityGrantMock.mockReset();
    // An ACTIVE auto grant: without the floor, this agent run would run.
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });
    resolveGovernanceRuleMock.mockReset();
    resolveGovernanceRuleMock.mockResolvedValue(undefined);
  });

  it("names its reason code", () => {
    expect(POD_FILE_OUTWARD).toBe("POD_FILE_OUTWARD");
  });

  it("control: the same granted agent run WITHOUT a file runs", async () => {
    expect(
      await gateCapabilityExecution(agentRun({ carriesPodFiles: false }))
    ).toEqual({ decision: "run" });
  });

  it("an auto grant does not widen it", async () => {
    expect(await gateCapabilityExecution(agentRun())).toMatchObject(
      PROPOSES_FOR_THE_FILE
    );
  });

  it("an auto governance rule does not widen it (no grant at all)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    resolveGovernanceRuleMock.mockResolvedValue({ verdict: "auto" });
    // Control: the rule alone does widen the same run without a file.
    expect(
      await gateCapabilityExecution(agentRun({ carriesPodFiles: false }))
    ).toEqual({ decision: "run" });
    expect(await gateCapabilityExecution(agentRun())).toMatchObject(
      PROPOSES_FOR_THE_FILE
    );
  });

  it("a verb claiming readOnly does not short-circuit it", async () => {
    expect(
      await gateCapabilityExecution(
        agentRun({ carriesPodFiles: false, readOnly: true })
      )
    ).toEqual({ decision: "run" });
    expect(
      await gateCapabilityExecution(agentRun({ readOnly: true }))
    ).toMatchObject(PROPOSES_FOR_THE_FILE);
  });

  it("an app's person token (the owner bypass) proposes, on a read intent too", async () => {
    grantMock.mockReturnValue({ clientId: "app_x", scopes: [] });
    const person = {
      agentUserId: null,
      skill: { ...agentRun().skill, intent: "list_records" },
    };
    // Control: a read intent through the app runs when it carries no file.
    expect(
      await gateCapabilityExecution(
        agentRun({ ...person, carriesPodFiles: false })
      )
    ).toEqual({ decision: "run" });
    expect(await gateCapabilityExecution(agentRun(person))).toMatchObject(
      PROPOSES_FOR_THE_FILE
    );
  });

  it("control: the person's own run in the pod, with a file, runs", async () => {
    expect(
      await gateCapabilityExecution(agentRun({ agentUserId: null }))
    ).toEqual({ decision: "run" });
  });

  it("an unapproved verb is still denied (the approval floor comes first)", async () => {
    const input = agentRun();
    const decision = await gateCapabilityExecution({
      ...input,
      skill: { ...input.skill, approved: false },
    });
    expect(decision.decision).toBe("deny");
  });
});
