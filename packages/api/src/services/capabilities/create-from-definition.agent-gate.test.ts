/**
 * D2 — a capability applied by an AGENT (hub `POST /capabilities/apply`, whose
 * caller ctx carries no agent) routes its playbooks and automations through
 * their gates. Before, both callers took the operator path: no proposal, and an
 * automation declaring `status:"active"` landed active.
 *
 * The agent comes from the request's acting-agent scope (REAL
 * `runWithActingAgent`). NOT covered: tools / skills / vault seeded by the same
 * apply — outside D1/D2, listed in plans/reports/door-g.md.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  playbookCreate: vi.fn(async (_input: Record<string, unknown>) => ({
    status: "proposed",
    playbook: null,
    proposalId: "pb-proposal",
  })),
  automationCreate: vi.fn(async (_input: Record<string, unknown>) => ({
    status: "proposed",
    id: null,
    proposalId: "auto-proposal",
  })),
}));

vi.mock("../../routers/playbooks.js", () => ({
  playbooksRouter: { createCaller: () => ({ create: m.playbookCreate }) },
}));
vi.mock("../../routers/automations.js", () => ({
  automationsRouter: { createCaller: () => ({ create: m.automationCreate }) },
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
}));
vi.mock("../../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: vi.fn(async () => ({ capability: { id: "cap-1" } })),
      addPart: vi.fn(async () => ({ ok: true })),
    }),
  },
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [] as unknown[],
  };
  const upd = { set: () => upd, where: async () => undefined };
  return { ...actual, db: { select: () => chain, update: () => upd } };
});

import { runWithActingAgent } from "@synap/database";
import { createCapabilityFromDefinition } from "./create-from-definition.js";

const WS = "11111111-1111-1111-1111-111111111111";
const UID = "22222222-2222-2222-2222-222222222222";
const AGENT = "33333333-3333-3333-3333-333333333333";

const apply = () =>
  createCapabilityFromDefinition(
    {
      key: "test.cap",
      name: "Test Capability",
      vault: [],
      tools: [],
      skills: [],
      playbooks: [{ name: "Grant Process", goalTemplate: "Advance it." }],
      automations: [
        {
          name: "Nightly ingest",
          triggerType: "manual",
          flowDefinition: { nodes: [], edges: [] },
          status: "active",
        },
      ],
    } as never,
    {},
    { userId: UID, workspaceId: WS } as never
  );

describe("createCapabilityFromDefinition — acting agent reaches the gates", () => {
  beforeEach(() => {
    m.playbookCreate.mockClear();
    m.automationCreate.mockClear();
  });

  it("an agent apply passes the agent to both creates and reports the proposals", async () => {
    const result = await runWithActingAgent(AGENT, apply);
    expect(m.playbookCreate.mock.calls[0][0]).toMatchObject({
      agentUserId: AGENT,
    });
    expect(m.automationCreate.mock.calls[0][0]).toMatchObject({
      agentUserId: AGENT,
    });
    expect(result.created.automations[0]).toMatchObject({
      status: "proposed",
      proposalId: "auto-proposal",
    });
    expect(result.proposals).toEqual(
      expect.arrayContaining(["pb-proposal", "auto-proposal"])
    );
  });

  it("a person's apply passes no agent (operator path unchanged)", async () => {
    await apply();
    expect(m.playbookCreate.mock.calls[0][0].agentUserId).toBeUndefined();
    expect(m.automationCreate.mock.calls[0][0].agentUserId).toBeUndefined();
  });
});
