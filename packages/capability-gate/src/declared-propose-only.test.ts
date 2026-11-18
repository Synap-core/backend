import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A pack can mark a verb propose-only (ticket 231020d4): `metadata.proposeOnly:
 * true` on the verb means no `auto` grant and no `auto` rule ever runs it on
 * its own. Before, only four Postiz NAMES and the `publish_post` intent were
 * floored, so a pack's `hcloud_delete_server` (destroys a server and its disk)
 * could be widened to run unattended.
 *
 * Each row tries one widening on a declared verb: an auto grant, an auto rule
 * with no grant, a row pre-loaded WITHOUT its metadata (the gate must read it,
 * never assume none). Controls: the same verb with no declaration, `false`,
 * or a non-boolean declaration runs.
 */

const findCapabilityGrantMock = vi.fn();
const resolveGovernanceRuleMock = vi.fn();
const skillMetadata = new Map<string, Record<string, unknown>>();

const T = {
  tools: { __t: "tools" },
  skills: {
    __t: "skills",
    id: "skills.id",
    intent: "skills.intent",
    metadata: "skills.metadata",
  },
  capabilityIntents: { __t: "ci", slug: "ci.slug", effect: "ci.effect" },
};

const fakeDb = {
  select: () => ({
    from: (table: { __t: string }) => ({
      where: async (cond: { b: string }) =>
        table.__t === "skills" && skillMetadata.has(cond.b)
          ? [{ intent: null, metadata: skillMetadata.get(cond.b) }]
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
const { capabilityVerbAllowsRuleWiden } =
  await import("@synap/governance-policy");

const agentRun = (metadata?: Record<string, unknown>) => ({
  capabilityKind: "skill" as const,
  capabilityId: "skill-1",
  skill: {
    id: "skill-1",
    approved: true,
    userId: "person-1",
    name: "hcloud_delete_server",
    intent: null,
    ...(metadata === undefined ? {} : { metadata }),
  },
  actorUserId: "person-1",
  agentUserId: "agent-1",
  workspaceId: "ws-1",
});

const PROPOSES = { decision: "propose", proposalType: "run" };
const DECLARED = { proposeOnly: true };

describe("a verb declaring metadata.proposeOnly never runs on its own", () => {
  beforeEach(() => {
    findCapabilityGrantMock.mockReset();
    resolveGovernanceRuleMock.mockReset();
    resolveGovernanceRuleMock.mockResolvedValue(undefined);
    skillMetadata.clear();
  });

  it("an auto grant does not widen it (control: undeclared runs)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });
    expect(await gateCapabilityExecution(agentRun(DECLARED))).toMatchObject(
      PROPOSES
    );
    expect(await gateCapabilityExecution(agentRun({}))).toEqual({
      decision: "run",
    });
  });

  it("an auto rule with no grant does not widen it (control: undeclared runs)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    resolveGovernanceRuleMock.mockResolvedValue({ verdict: "auto" });
    expect(await gateCapabilityExecution(agentRun(DECLARED))).toMatchObject(
      PROPOSES
    );
    expect(await gateCapabilityExecution(agentRun({}))).toEqual({
      decision: "run",
    });
  });

  it("a row pre-loaded without its metadata: the gate reads it", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });
    skillMetadata.set("skill-1", DECLARED);
    expect(await gateCapabilityExecution(agentRun())).toMatchObject(PROPOSES);
    skillMetadata.set("skill-1", {});
    expect(await gateCapabilityExecution(agentRun())).toEqual({
      decision: "run",
    });
  });

  it("only a real boolean declares it: false and \"true\" run", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });
    expect(
      await gateCapabilityExecution(agentRun({ proposeOnly: false }))
    ).toEqual({ decision: "run" });
    expect(
      await gateCapabilityExecution(agentRun({ proposeOnly: "true" }))
    ).toEqual({ decision: "run" });
  });
});

describe("capabilityVerbAllowsRuleWiden reads the declaration", () => {
  it("refuses a declared verb whatever its name and intent; allows the rest", () => {
    expect(
      capabilityVerbAllowsRuleWiden("hcloud_delete_server", null, DECLARED)
    ).toBe(false);
    expect(
      capabilityVerbAllowsRuleWiden("gmail_send", "send_email", DECLARED)
    ).toBe(false);
    expect(capabilityVerbAllowsRuleWiden("hcloud_delete_server", null, {})).toBe(
      true
    );
    expect(capabilityVerbAllowsRuleWiden("hcloud_delete_server")).toBe(true);
  });
});
