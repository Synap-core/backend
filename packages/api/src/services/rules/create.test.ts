/**
 * The classifier at the rule WRITE door.
 *
 * `POST /rules/classify` computed a shape and `createRuleGoverned` discarded
 * it, so a rule describing a behaviour became a `skills` row of prose that
 * never executes — and said nothing about it. These tests drive the real door
 * (not a source scan) and assert BOTH halves: the routing is persisted, and
 * the "nothing will run" signal is INFORMATION, never a refusal.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const inserted: Array<Record<string, unknown>> = [];
let permResult: Record<string, unknown> = { allowed: true };

vi.mock("@synap/database", () => ({
  db: {
    // snapshotBehaviours' select — no automation rows in these tests.
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: async () => [{ id: values.id }] };
      },
    }),
  },
  skills: { __table: "skills" },
  automations: { id: "id", flowDefinition: "flowDefinition" },
  inArray: () => ({}),
}));

vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (args: Record<string, unknown>) => {
    gateCalls.push(args);
    return permResult;
  },
}));

vi.mock("../links/links-service.js", () => ({
  createLinks: async () => undefined,
}));

const gateCalls: Array<Record<string, unknown>> = [];

const { createRuleGoverned } = await import("./create.js");
const { readRuleMetadata, RULE_METADATA_KEY } = await import("./index.js");

const create = (over: Record<string, unknown> = {}) =>
  createRuleGoverned({
    userId: "user-1",
    workspaceId: "ws-1",
    intent: "x",
    scope: { kind: "pod" },
    ...over,
  } as Parameters<typeof createRuleGoverned>[0]);

const metadataOfLastInsert = () => {
  const row = inserted.at(-1);
  return readRuleMetadata((row?.metadata ?? {}) as Record<string, unknown>);
};

beforeEach(() => {
  inserted.length = 0;
  gateCalls.length = 0;
  permResult = { allowed: true };
});

const FACT = "All our client contracts live in the shared drive.";
const BEHAVIOUR = "When a client emails an invoice, file it and tag it.";
const ONE_SHOT = "Can you research the Acme deadlines for now?";

describe("routing is persisted, not recomputed by every reader", () => {
  it("stores the primary shape, confidence, oneShot and the cues that fired", async () => {
    await create({ intent: BEHAVIOUR });
    const routing = metadataOfLastInsert()?.routing;
    expect(routing?.shape).toBe("behaviour");
    expect(routing?.oneShot).toBe(false);
    expect(routing?.confidence).toBeGreaterThan(0);
    expect(routing?.cues).toContain("when a");
  });

  it("round-trips through the metadata reader", async () => {
    await create({ intent: FACT });
    const row = inserted.at(-1)!;
    const blob = (row.metadata as Record<string, unknown>)[RULE_METADATA_KEY];
    expect(readRuleMetadata({ [RULE_METADATA_KEY]: blob })?.routing).toEqual(
      (blob as { routing: unknown }).routing
    );
  });
});

describe("needsBehaviour — information, never a refusal", () => {
  it("a fact rule creates cleanly with no signal", async () => {
    const result = await create({ intent: FACT });
    expect(result.status).toBe("created");
    expect(result).not.toHaveProperty("needsBehaviour");
    expect(metadataOfLastInsert()?.routing?.shape).toBe("fact");
  });

  it("a behavioural rule with NO automations still CREATES, and reports", async () => {
    const result = await create({ intent: BEHAVIOUR, automationIds: [] });
    // The rule row is written — this is the whole point.
    expect(result.status).toBe("created");
    expect(inserted).toHaveLength(1);
    expect(
      (result as { needsBehaviour?: { shape: string; reason: string } })
        .needsBehaviour
    ).toMatchObject({ shape: "behaviour" });
    expect(
      (result as { needsBehaviour?: { reason: string } }).needsBehaviour?.reason
    ).toMatch(/will not execute/);
  });

  it("a behavioural rule WITH automationIds does not report it", async () => {
    const result = await create({
      intent: BEHAVIOUR,
      automationIds: ["11111111-1111-1111-1111-111111111111"],
    });
    expect(result.status).toBe("created");
    expect(result).not.toHaveProperty("needsBehaviour");
  });

  it("a one-shot ask does not report it — it is not a standing rule", async () => {
    const result = await create({ intent: ONE_SHOT, automationIds: [] });
    expect(metadataOfLastInsert()?.routing?.oneShot).toBe(true);
    expect(result).not.toHaveProperty("needsBehaviour");
  });

  it("rides along a proposed verdict too — the agent path is where it matters", async () => {
    permResult = { proposalId: "p-1" };
    const result = await create({
      intent: BEHAVIOUR,
      agentUserId: "agent-1",
      automationIds: [],
    });
    expect(result).toMatchObject({
      status: "proposed",
      proposalId: "p-1",
      needsBehaviour: { shape: "behaviour" },
    });
    expect(inserted).toHaveLength(0);
  });
});

describe("propose → approve carries the routing", () => {
  it("the gate payload holds the SAME routing the direct path persists", async () => {
    permResult = { proposalId: "p-2" };
    await create({ intent: BEHAVIOUR, agentUserId: "agent-1" });
    const proposedRouting = (gateCalls.at(-1)?.data as Record<string, unknown>)
      .routing;

    // The approval replay re-enters this door as the approver with the same
    // intent — so the materialized rule must carry an identical routing.
    permResult = { allowed: true };
    await create({ intent: BEHAVIOUR });
    expect(metadataOfLastInsert()?.routing).toEqual(proposedRouting);
  });
});
