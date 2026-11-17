import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A public post never runs on its own (ticket c7feaa6e): the never-widen floor
 * was keyed on four Postiz verb NAMES, so a verb serving the `publish_post`
 * intent under another name (`unipile_publish_post`) or a case variant of a
 * listed name ran directly under an `auto` grant or an `auto` rule. The floor
 * is now the one derivation `capabilityVerbAllowsRuleWiden(name, intent)`,
 * read by the gate with the verb's intent.
 *
 * Each row tries one widening: an auto grant, an auto rule with no grant, a
 * row pre-loaded WITHOUT its intent (the gate must read it, never assume
 * none), a case variant of a listed name. Controls: the same runs on a
 * widenable intent run.
 */

const findCapabilityGrantMock = vi.fn();
const resolveGovernanceRuleMock = vi.fn();
const skillIntents = new Map<string, string | null>();

const T = {
  tools: { __t: "tools" },
  skills: { __t: "skills", id: "skills.id", intent: "skills.intent" },
  capabilityIntents: { __t: "ci", slug: "ci.slug", effect: "ci.effect" },
};

const fakeDb = {
  select: () => ({
    from: (table: { __t: string }) => ({
      where: async (cond: { b: string }) =>
        table.__t === "skills" && skillIntents.has(cond.b)
          ? [{ intent: skillIntents.get(cond.b) }]
          : [],
    }),
  }),
};

vi.mock("@synap/database", () => ({
  getDb: async () => fakeDb,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  findCapabilityGrant: (...args: unknown[]) => findCapabilityGrantMock(...args),
  getRequestGrant: () => undefined,
}));

vi.mock("@synap/database/agent-governance", () => ({
  resolveGovernanceRule: (...args: unknown[]) =>
    resolveGovernanceRuleMock(...args),
  resolveOriginTrust: async () => undefined,
}));

vi.mock("@synap/database/schema", () => T);

const { gateCapabilityExecution } = await import("./index.js");
const { capabilityVerbAllowsRuleWiden } = await import(
  "@synap/governance-policy"
);

const agentRun = (name: string, intent?: string | null) => ({
  capabilityKind: "skill" as const,
  capabilityId: "skill-1",
  skill: {
    id: "skill-1",
    approved: true,
    userId: "person-1",
    name,
    ...(intent === undefined ? {} : { intent }),
  },
  actorUserId: "person-1",
  agentUserId: "agent-1",
  workspaceId: "ws-1",
});

const PROPOSES = { decision: "propose", proposalType: "run" };

describe("a publish_post verb under any name never runs on its own", () => {
  beforeEach(() => {
    findCapabilityGrantMock.mockReset();
    resolveGovernanceRuleMock.mockReset();
    resolveGovernanceRuleMock.mockResolvedValue(undefined);
    skillIntents.clear();
  });

  it("an auto grant does not widen unipile_publish_post (control: a widenable intent runs)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });
    expect(
      await gateCapabilityExecution(
        agentRun("unipile_publish_post", "publish_post")
      )
    ).toMatchObject(PROPOSES);
    expect(
      await gateCapabilityExecution(agentRun("unipile_send", "send_message"))
    ).toEqual({ decision: "run" });
  });

  it("an auto rule with no grant does not widen linkedin_create_post (control: a widenable intent runs)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    resolveGovernanceRuleMock.mockResolvedValue({ verdict: "auto" });
    expect(
      await gateCapabilityExecution(
        agentRun("linkedin_create_post", "publish_post")
      )
    ).toMatchObject(PROPOSES);
    expect(
      await gateCapabilityExecution(agentRun("unipile_send", "send_message"))
    ).toEqual({ decision: "run" });
  });

  it("a row pre-loaded without its intent: the gate reads it", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });
    skillIntents.set("skill-1", "publish_post");
    expect(
      await gateCapabilityExecution(agentRun("unipile_publish_post"))
    ).toMatchObject(PROPOSES);
    skillIntents.set("skill-1", "send_message");
    expect(
      await gateCapabilityExecution(agentRun("unipile_publish_post"))
    ).toEqual({ decision: "run" });
  });

  it("a case variant of a listed Postiz name is the same verb", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });
    expect(
      await gateCapabilityExecution(agentRun(" Postiz_Publish ", null))
    ).toMatchObject(PROPOSES);
  });
});

describe("capabilityVerbAllowsRuleWiden — the one derivation the menus read", () => {
  it("refuses a propose-only intent or a listed name in any case; allows the rest", () => {
    expect(
      capabilityVerbAllowsRuleWiden("unipile_publish_post", "publish_post")
    ).toBe(false);
    expect(capabilityVerbAllowsRuleWiden("Postiz_Publish")).toBe(false);
    expect(capabilityVerbAllowsRuleWiden("gmail_send", "send_email")).toBe(
      true
    );
    expect(capabilityVerbAllowsRuleWiden(null, null)).toBe(true);
  });
});
