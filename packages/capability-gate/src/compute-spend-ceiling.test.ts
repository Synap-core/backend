import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The compute spend ceiling (0430, founder 18 Nov 2026: opt-in per pod, like
 * the daily-write limit). An AGENT's compute start that would RUN is proposed
 * instead when the day's started maximums plus its own pass the
 * `compute_spend_daily_cents` ceiling. Each row rules out one wrong placement:
 *  - an auto grant would run it                 → the ceiling sits after the grant;
 *  - an auto rule would run it                  → the ceiling sits after the rule;
 *  - no ceiling set (null)                      → opt-in: nothing changes;
 *  - exactly at the ceiling                     → only PAST it proposes;
 *  - a person's own start                       → never reaches the person;
 *  - a run that is not a compute start          → never consulted;
 *  - an already-proposed start                  → stays a proposal (tighten-only).
 */

const findCapabilityGrantMock = vi.fn();
const resolveGovernanceRuleMock = vi.fn();
const resolveCeilingMock = vi.fn();
let dayTotal = 0;

const T = {
  tools: { __t: "tools" },
  skills: { __t: "skills", id: "skills.id", intent: "skills.intent" },
  capabilityIntents: { __t: "ci", slug: "ci.slug", effect: "ci.effect" },
  computeLeases: {
    __t: "leases",
    maxSpendCents: "leases.max_spend_cents",
    createdAt: "leases.created_at",
    state: "leases.state",
  },
};

const fakeDb = {
  select: () => ({
    from: (table: { __t: string }) => ({
      where: async () => (table.__t === "leases" ? [{ total: dayTotal }] : []),
    }),
  }),
};

vi.mock("@synap/database", () => ({
  getDb: async () => fakeDb,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  and: (...parts: unknown[]) => ({ and: parts }),
  gte: (a: unknown, b: unknown) => ({ gte: [a, b] }),
  ne: (a: unknown, b: unknown) => ({ ne: [a, b] }),
  drizzleSql: () => ({ sql: true }),
  findCapabilityGrant: (...args: unknown[]) => findCapabilityGrantMock(...args),
  getRequestGrant: () => undefined,
}));

vi.mock("@synap/database/agent-governance", () => ({
  resolveGovernanceRule: (...args: unknown[]) =>
    resolveGovernanceRuleMock(...args),
  resolveOriginTrust: async () => undefined,
  resolveCeiling: (...args: unknown[]) => resolveCeilingMock(...args),
}));

vi.mock("@synap/database/schema", () => T);

const { gateCapabilityExecution, COMPUTE_SPEND_CEILING } =
  await import("./index.js");

/** An agent starting a machine for 300 cents, through an approved verb. */
const agentStart = (over: object = {}) => ({
  capabilityKind: "skill" as const,
  capabilityId: "skill-1",
  skill: {
    id: "skill-1",
    approved: true,
    userId: "person-1",
    name: "hetzner_create_server",
    intent: "provision_compute",
  },
  actorUserId: "person-1",
  agentUserId: "agent-1",
  workspaceId: "ws-1",
  computeSpendCents: 300,
  ...over,
});

const PROPOSED_FOR_SPEND = {
  decision: "propose",
  reasonCode: "COMPUTE_SPEND_CEILING",
  proposalType: "run",
};

describe("gateCapabilityExecution — the compute spend ceiling", () => {
  beforeEach(() => {
    findCapabilityGrantMock.mockReset();
    // An ACTIVE auto grant: without the ceiling, this agent start would run.
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });
    resolveGovernanceRuleMock.mockReset();
    resolveGovernanceRuleMock.mockResolvedValue(undefined);
    resolveCeilingMock.mockReset();
    resolveCeilingMock.mockResolvedValue({
      value: 1000,
      source: "row",
      ceilingId: "c-1",
    });
    dayTotal = 800;
  });

  it("names its reason code and reads its own axis", async () => {
    expect(COMPUTE_SPEND_CEILING).toBe("COMPUTE_SPEND_CEILING");
    await gateCapabilityExecution(agentStart());
    expect(resolveCeilingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        axis: "compute_spend_daily_cents",
        agentUserId: "agent-1",
        workspaceId: "ws-1",
      })
    );
  });

  it("an auto grant does not run a start past the ceiling (800 + 300 > 1000)", async () => {
    expect(await gateCapabilityExecution(agentStart())).toMatchObject(
      PROPOSED_FOR_SPEND
    );
  });

  it("an auto rule does not run it either", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    resolveGovernanceRuleMock.mockResolvedValue({ verdict: "auto" });
    expect(await gateCapabilityExecution(agentStart())).toMatchObject(
      PROPOSED_FOR_SPEND
    );
  });

  it("control: under the ceiling it runs (700 + 300 = 1000)", async () => {
    dayTotal = 700;
    expect(await gateCapabilityExecution(agentStart())).toEqual({
      decision: "run",
    });
  });

  it("opt-in: no ceiling set (null) never proposes", async () => {
    resolveCeilingMock.mockResolvedValue({
      value: null,
      source: "default",
      ceilingId: null,
    });
    dayTotal = 1_000_000;
    expect(await gateCapabilityExecution(agentStart())).toEqual({
      decision: "run",
    });
  });

  it("a person's own start is theirs to make", async () => {
    expect(
      await gateCapabilityExecution(agentStart({ agentUserId: null }))
    ).toEqual({ decision: "run" });
    expect(resolveCeilingMock).not.toHaveBeenCalled();
  });

  it("a run that is not a compute start never reads the ceiling", async () => {
    expect(
      await gateCapabilityExecution(agentStart({ computeSpendCents: null }))
    ).toEqual({ decision: "run" });
    expect(resolveCeilingMock).not.toHaveBeenCalled();
  });

  it("a start already proposed stays proposed for its own reason", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    expect(await gateCapabilityExecution(agentStart())).toMatchObject({
      decision: "propose",
      reasonCode: "CAPABILITY_PROPOSE",
    });
    expect(resolveCeilingMock).not.toHaveBeenCalled();
  });
});
