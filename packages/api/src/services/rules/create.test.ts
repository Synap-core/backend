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

/**
 * The ONE automation insert door. Mocked so these tests stay DB-free, but the
 * arguments are recorded: the draft floor is derived from the principal INSIDE
 * that door, and what this door is handed is exactly what the compiler produced.
 */
const materializeCalls: Array<Record<string, unknown>> = [];
let materializeThrows: Error | null = null;
vi.mock("../../routers/automations.js", () => ({
  materializeAutomationForPrincipal: async (args: Record<string, unknown>) => {
    materializeCalls.push(args);
    if (materializeThrows) throw materializeThrows;
    return "33333333-3333-3333-3333-333333333333";
  },
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
  materializeCalls.length = 0;
  materializeThrows = null;
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

// ---------------------------------------------------------------------------
// COMPILE OR REFUSE — the reason this door exists.
//
// Before this, `createRuleGoverned` only LINKED pre-existing automations and
// every live caller passed `automationIds: []`, so a behavioural rule became
// prose that could never run and was told so only in a non-fatal signal. A rule
// that carries a sentence now either compiles to an automation or is REFUSED
// with the failing clause named.
// ---------------------------------------------------------------------------

/** A well-formed sentence: WHEN an entity is created → THEN notify. */
const GOOD_SENTENCE = {
  trigger: {
    triggerType: "event" as const,
    subjectCategory: "entity" as const,
    actionVerb: "created" as const,
  },
  conditions: [],
  actions: [{ type: "notify" as const, config: { message: "hi" } }],
};

describe("a rule that carries a sentence compiles or is refused", () => {
  it("compiles the sentence into an automation through the ONE insert door", async () => {
    const result = await create({ intent: BEHAVIOUR, sentence: GOOD_SENTENCE });
    expect(result.status).toBe("created");
    expect(materializeCalls).toHaveLength(1);

    const def = materializeCalls[0]!.definition as Record<string, unknown>;
    // Executor-true, not merely well-formed: the imperative event pattern the
    // runtime actually emits, and an `output` node the executor dispatches.
    expect((def.triggerConfig as Record<string, unknown>).eventPattern).toBe(
      "entity.create.completed"
    );
    const nodes = (
      def.flowDefinition as { nodes: Array<Record<string, unknown>> }
    ).nodes;
    expect(nodes.some((n) => n.type === "output")).toBe(true);
  });

  it("links the new automation to the rule, so `needsBehaviour` is not reported", async () => {
    const result = await create({ intent: BEHAVIOUR, sentence: GOOD_SENTENCE });
    expect(result).not.toHaveProperty("needsBehaviour");
    expect(metadataOfLastInsert()?.behaviours?.[0]?.automationId).toBe(
      "33333333-3333-3333-3333-333333333333"
    );
  });

  it("passes agentUserId to the door so an agent-authored rule's automation lands DRAFT", async () => {
    // The floor itself lives inside `materializeAutomationForPrincipal` (it must
    // not be a flag a caller can forget). What this door owes is the principal.
    await create({
      intent: BEHAVIOUR,
      sentence: GOOD_SENTENCE,
      agentUserId: "agent-1",
    });
    expect(materializeCalls.at(-1)).toMatchObject({ agentUserId: "agent-1" });
  });

  it("the APPROVAL replay still lands the automation DRAFT for an agent-authored rule", async () => {
    // The replay runs as the APPROVER (no `agentUserId`, so the re-entrant gate
    // auto-grants) — but the draft floor must key on who AUTHORED the behaviour.
    // Without the separate field this materialized an ACTIVE automation, making
    // `rule/create` a wider path to a live trigger than `automation/create`.
    await create({
      intent: BEHAVIOUR,
      sentence: GOOD_SENTENCE,
      agentUserId: undefined,
      behaviourAuthorAgentUserId: "agent-1",
    });
    expect(materializeCalls.at(-1)).toMatchObject({ agentUserId: "agent-1" });
  });

  it("a HUMAN-authored rule approved by someone else is NOT forced to draft", async () => {
    // A member who lacks `create` is not a prompt-injection surface; forcing
    // their approved rule to draft would make approval a half-action.
    await create({ intent: BEHAVIOUR, sentence: GOOD_SENTENCE });
    expect(materializeCalls.at(-1)).not.toHaveProperty("agentUserId");
  });

  it("compiles the EXECUTOR-TRUE dialect the browser's rule editor emits", async () => {
    // `type: null` + `__outputType` is how the only surface offering the full
    // executor vocabulary encodes a THEN. The compiler used to count it as
    // unconfigured and refuse the rule as "no THEN" — so the door could not
    // consume the only sentence the product actually produces.
    const result = await create({
      intent: BEHAVIOUR,
      sentence: {
        ...GOOD_SENTENCE,
        actions: [
          {
            type: null,
            config: {
              __outputType: "notification",
              __actionKey: "notification",
              message: "hi",
            },
          },
        ],
      },
    });
    expect(result.status).toBe("created");
    const def = materializeCalls.at(-1)!.definition as Record<string, unknown>;
    const nodes = (
      def.flowDefinition as { nodes: Array<Record<string, unknown>> }
    ).nodes;
    const output = nodes.find((n) => n.type === "output");
    expect((output!.data as Record<string, unknown>).outputType).toBe(
      "notification"
    );
    // Bookkeeping keys never reach the stored flow.
    expect(
      (output!.data as { config: Record<string, unknown> }).config
    ).toEqual({
      message: "hi",
    });
  });

  it("a POD-scoped rule compiles a POD-WIDE automation, not a workspace one", async () => {
    // The `skills` row and the automation must agree about scope. They did not:
    // the row was pod-wide and the automation was pinned to whatever workspace
    // the caller was in, so the rule fired for a fraction of what it said.
    await create({
      intent: BEHAVIOUR,
      sentence: GOOD_SENTENCE,
      scope: { kind: "pod" },
      workspaceId: "ws-1",
    });
    const def = materializeCalls.at(-1)!.definition as Record<string, unknown>;
    expect(def.workspaceId).toBeNull();
  });

  it("a WORKSPACE-scoped rule still pins its automation to that workspace", async () => {
    await create({
      intent: BEHAVIOUR,
      sentence: GOOD_SENTENCE,
      scope: { kind: "workspace", workspaceId: "ws-9" },
      workspaceId: "ws-1",
    });
    const def = materializeCalls.at(-1)!.definition as Record<string, unknown>;
    expect(def.workspaceId).toBe("ws-9");
  });

  it("REFUSES a sentence with no THEN, naming the clause", async () => {
    const result = await create({
      intent: BEHAVIOUR,
      sentence: { ...GOOD_SENTENCE, actions: [] },
    });
    expect(result).toMatchObject({
      status: "denied",
      failure: { clause: "THEN" },
    });
    // Nothing persisted, nothing proposed, no automation.
    expect(inserted).toHaveLength(0);
    expect(gateCalls).toHaveLength(0);
    expect(materializeCalls).toHaveLength(0);
  });

  it("REFUSES a WHEN whose compiled pattern the runtime cannot match", async () => {
    // `approved` is an ActionVerb the editor offers with no `entity.*` event —
    // refused by the runtime's own validator, not by a list in this door.
    const result = await create({
      intent: BEHAVIOUR,
      sentence: {
        ...GOOD_SENTENCE,
        trigger: { ...GOOD_SENTENCE.trigger, actionVerb: "approved" as const },
      },
    });
    expect(result).toMatchObject({
      status: "denied",
      failure: { clause: "WHEN" },
    });
  });

  it("REFUSES an unreadable sentence rather than storing prose that cannot run", async () => {
    const result = await create({ intent: BEHAVIOUR, sentence: { nope: 1 } });
    expect(result.status).toBe("denied");
    expect(inserted).toHaveLength(0);
  });

  it("REFUSES when the insert door rejects the flow against the live catalog", async () => {
    // The compiler is pure — it cannot know whether a commandId exists. The
    // door can, and its refusal must reach the author, not be swallowed into a
    // rule kept as prose.
    materializeThrows = new Error('Unknown command "nope"');
    const result = await create({ intent: BEHAVIOUR, sentence: GOOD_SENTENCE });
    expect(result).toMatchObject({
      status: "denied",
      failure: { clause: "THEN" },
    });
  });

  it("carries the sentence in the gate payload so approval rebuilds the SAME behaviour", async () => {
    permResult = { proposalId: "p-3" };
    const result = await create({
      intent: BEHAVIOUR,
      sentence: GOOD_SENTENCE,
      agentUserId: "agent-1",
    });
    expect(result.status).toBe("proposed");
    expect(
      (gateCalls.at(-1)?.data as Record<string, unknown>).sentence
    ).toEqual(GOOD_SENTENCE);
    // A proposed rule leaves NO automation behind — the owner has not approved.
    expect(materializeCalls).toHaveLength(0);
  });

  it("a prose-only rule with no sentence is unchanged (still creates, still reports)", async () => {
    const result = await create({ intent: BEHAVIOUR });
    expect(result.status).toBe("created");
    expect(materializeCalls).toHaveLength(0);
    expect(result).toHaveProperty("needsBehaviour");
  });
});
