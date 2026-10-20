/**
 * Hub Protocol REST — `PATCH /rules/:id`, the API-key door onto the governed
 * rule EDIT.
 *
 * Before this route an agent could CREATE a rule (`POST /rules`,
 * `synap_create_rule`) but never propose a correction to one: the only edit
 * door was `skills.updateRule`, the app's session door. So a rule an agent
 * wrote, a person approved, and the facts then outgrew could only be fixed by a
 * person.
 *
 * What these pin, against the REAL `updateRuleGoverned` and the REAL
 * `rule/update` executor (only the row store, the gate's verdict, the lineage
 * edges and the automations router are stubbed — each proven elsewhere):
 *  1. An agent key's edit is PROPOSED (HTTP 200 — a proposal is a success) and
 *     writes nothing; approving that proposal through the executor writes
 *     exactly what a person's direct edit writes.
 *  2. A person's key APPLIES the edit.
 *  3. A rule the caller cannot see is a 404, and nothing past the visibility
 *     read runs — no gate, no automation read, no write.
 *  4. The route reuses `POST /rules`' identity checks verbatim: write scope,
 *     verified agent attribution, workspace confinement.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** The stored rule row, owned by `ownerId`. */
  storedRow: undefined as Record<string, unknown> | undefined,
  ownerId: "",
  /** Who the visibility floor was evaluated for. */
  visibleFor: [] as string[],
  findFirstCalls: 0,
  automationReads: 0,
  automationRows: [] as Array<Record<string, unknown>>,
  skillWrites: [] as Array<Record<string, unknown>>,
  automationWrites: [] as Array<Record<string, unknown>>,
  proposalWrites: [] as Array<Record<string, unknown>>,
  linkCalls: [] as Array<Record<string, unknown>>,
  gateCalls: [] as Array<Record<string, unknown>>,
  actorError: null as string | null,
  confineError: null as string | null,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        skills: {
          findFirst: async () => {
            h.findFirstCalls++;
            // The floor, simulated: the row comes back only to its owner.
            return h.visibleFor.at(-1) === h.ownerId ? h.storedRow : undefined;
          },
        },
      },
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === actual.proposals) return [];
            h.automationReads++;
            return h.automationRows;
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            if (table === actual.skills) h.skillWrites.push(values);
            else if (table === actual.proposals) h.proposalWrites.push(values);
            else h.automationWrites.push(values);
          },
        }),
      }),
    },
  };
});

vi.mock("./_shared.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  hasScope: (scopes: string[], scope: string) => scopes.includes(scope),
  httpStatusForTrpcError: () => 500,
  confineWorkspaceOrForbidden: (
    _c: unknown,
    requested: string | null | undefined
  ) =>
    h.confineError
      ? { ok: false as const, error: h.confineError }
      : { ok: true as const, workspaceId: requested },
  resolveActingContext: async (
    c: { get: (k: string) => unknown },
    body: { workspaceId?: string }
  ) => ({
    ok: true as const,
    userId: c.get("userId") as string,
    workspaceId: body.workspaceId ?? null,
    role: "owner",
  }),
  resolveActorId: async (agentUserId: string | undefined, userId: string) =>
    h.actorError ? { error: h.actorError } : { actorId: agentUserId ?? userId },
}));

// The gate's VERDICT is stubbed (its routing is proven in permission-check's
// own tests): an agent-authored write is routed to review, a person's applies.
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (args: Record<string, unknown>) => {
    h.gateCalls.push(args);
    return args.agentUserId ? { proposalId: "prop-1" } : { allowed: true };
  },
}));

vi.mock("../../../services/skills/visibility.js", () => ({
  visibleSkillsWhere: (userId: string) => {
    h.visibleFor.push(userId);
    return {};
  },
}));

vi.mock("../../../services/rules/lineage.js", () => ({
  readRuleAutomationIds: async () => h.automationRows.map((a) => a.id),
}));

vi.mock("../../../services/rules/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/rules/index.js")>();
  return {
    ...actual,
    linkRuleHalves: async (args: Record<string, unknown>) => {
      h.linkCalls.push(args);
    },
    unlinkRuleBehaviours: async () => undefined,
  };
});

vi.mock("../../automations.js", () => ({
  materializeAutomationForPrincipal: async () => {
    throw new Error("an in-place edit must not create an automation");
  },
  automationsRouter: {
    createCaller: () => ({
      update: async (args: Record<string, unknown>) => {
        h.automationWrites.push({ viaRouter: true, ...args });
        return { id: args.id };
      },
    }),
  },
}));

vi.mock("../../../services/playbooks/workers.js", () => ({
  WorkerScopeOverlapError: class extends Error {},
  assertNoWorkerOverlap: async () => undefined,
}));

import { registerRulesRoutes } from "./rules.js";
import type { HubHono, HubVariables } from "./_shared.js";
import {
  RULE_METADATA_KEY,
  buildRuleMetadata,
} from "../../../services/rules/index.js";
import { proposalExecRegistry } from "../../proposals/execution-registry.js";
import { registerRuleExecutors } from "../../proposals/executors/rule.js";

registerRuleExecutors();

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const RULE_ID = "44444444-4444-4444-8444-444444444444";
const AUTOMATION_ID = "55555555-5555-4555-8555-555555555555";

const SENTENCE = {
  trigger: {
    triggerType: "event",
    subjectCategory: "entity",
    actionVerb: "created",
  },
  conditions: [],
  actions: [{ type: "notify", config: { message: "a deal moved" } }],
};

const EDIT = {
  intent: "When a deal is created, notify the founder",
  scope: { kind: "pod" },
  expiresAt: "2027-01-31T00:00:00Z",
  sentence: SENTENCE,
};

function buildApp(vars: Partial<HubVariables> = {}): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", vars.scopes ?? ["hub-protocol.read", "hub-protocol.write"]);
    c.set("userId", vars.userId ?? USER);
    if (vars.agentUserId) c.set("agentUserId", vars.agentUserId);
    await next();
  });
  registerRulesRoutes(app);
  return app;
}

const patch = (body: unknown) => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  h.ownerId = USER;
  h.storedRow = {
    id: RULE_ID,
    userId: USER,
    metadata: {
      [RULE_METADATA_KEY]: {
        ...buildRuleMetadata({
          intent: "When a deal is created, notify the old founder",
          scope: { kind: "pod" },
          behaviours: [{ automationId: AUTOMATION_ID, flowHash: "stale" }],
          sentence: SENTENCE as never,
        }),
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  h.automationRows = [
    {
      id: AUTOMATION_ID,
      workspaceId: null,
      metadata: { ruleId: RULE_ID, kind: "rule" },
      flowDefinition: { nodes: [], edges: [] },
    },
  ];
  h.visibleFor.length = 0;
  h.findFirstCalls = 0;
  h.automationReads = 0;
  h.skillWrites.length = 0;
  h.automationWrites.length = 0;
  h.proposalWrites.length = 0;
  h.linkCalls.length = 0;
  h.gateCalls.length = 0;
  h.actorError = null;
  h.confineError = null;
});

/** Everything the edit wrote, minus the wall-clock stamps of when it ran. */
function writtenState() {
  const strip = (v: Record<string, unknown>) => {
    const { updatedAt: _u, ...rest } = v;
    void _u;
    return rest;
  };
  return {
    skills: h.skillWrites.map((w) => {
      const meta = w.metadata as Record<string, Record<string, unknown>>;
      const { updatedAt: _ru, ...rule } = meta[RULE_METADATA_KEY]!;
      void _ru;
      return strip({ ...w, metadata: { ...meta, [RULE_METADATA_KEY]: rule } });
    }),
    automations: h.automationWrites.map(strip),
    links: [...h.linkCalls],
  };
}

describe("PATCH /rules/:id — an agent PROPOSES", () => {
  it("returns 200 with {status:'proposed'} and writes nothing", async () => {
    const res = await buildApp({ agentUserId: AGENT }).request(
      `/rules/${RULE_ID}`,
      patch(EDIT)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "proposed",
      proposalId: "prop-1",
    });
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      userId: USER,
      agentUserId: AGENT,
      subjectType: "rule",
      action: "update",
      data: {
        id: RULE_ID,
        intent: EDIT.intent,
        auditSource: "hub.rules.update",
      },
    });
    expect(h.skillWrites).toHaveLength(0);
    expect(h.automationWrites).toHaveLength(0);
  });

  it("approving the proposal writes exactly what a person's direct edit writes", async () => {
    // 1. A person edits directly.
    const direct = await buildApp().request(`/rules/${RULE_ID}`, patch(EDIT));
    expect(direct.status).toBe(200);
    expect(await direct.json()).toMatchObject({
      status: "updated",
      ruleId: RULE_ID,
      automationIds: [AUTOMATION_ID],
    });
    const directState = writtenState();
    expect(directState.skills).toHaveLength(1);

    // 2. An agent sends the SAME edit through the same door → a proposal.
    h.skillWrites.length = 0;
    h.automationWrites.length = 0;
    h.linkCalls.length = 0;
    h.gateCalls.length = 0;
    await buildApp({ agentUserId: AGENT }).request(
      `/rules/${RULE_ID}`,
      patch(EDIT)
    );
    const filed = h.gateCalls.at(-1)!;
    expect(h.skillWrites).toHaveLength(0);

    // 3. The person approves it: the REAL executor replays the stored payload.
    await proposalExecRegistry.resolveExact("rule/update")!.execute({
      proposal: {
        id: "prop-1",
        workspaceId: (filed.workspaceId as string | undefined) ?? null,
        agentUserId: AGENT,
        data: { data: filed.data },
      },
      payload: undefined,
      userId: USER,
      input: { proposalId: "prop-1" },
      deps: {
        emitProposalReviewed: () => undefined,
        reportProposalOutcome: () => undefined,
      },
    } as never);

    expect(h.proposalWrites.at(-1)).toMatchObject({
      status: "approved",
      data: { materialized: { ruleId: RULE_ID } },
    });
    expect(writtenState()).toEqual(directState);
  });
});

describe("PATCH /rules/:id — a person's key APPLIES", () => {
  it("updates in place through the governed door, with no agent fabricated", async () => {
    const res = await buildApp().request(`/rules/${RULE_ID}`, patch(EDIT));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "updated",
      ruleId: RULE_ID,
    });
    expect(h.gateCalls[0]).not.toHaveProperty("agentUserId", AGENT);
    expect(h.gateCalls[0]?.agentUserId).toBeUndefined();
    expect(h.skillWrites.at(-1)).toMatchObject({ body: EDIT.intent });
    expect(h.automationWrites.at(-1)).toMatchObject({
      viaRouter: true,
      id: AUTOMATION_ID,
    });
  });

  it("forwards an explicit null as CLEAR, not as 'leave alone'", async () => {
    await buildApp().request(
      `/rules/${RULE_ID}`,
      patch({ ...EDIT, expiresAt: null, sentence: null })
    );
    const rule = (
      h.skillWrites.at(-1)!.metadata as Record<string, Record<string, unknown>>
    )[RULE_METADATA_KEY]!;
    expect(rule.expiresAt).toBeUndefined();
    expect(rule.sentence).toBeUndefined();
    // Prose-only now: the rule's own automation is retired.
    expect(h.automationWrites.at(-1)).toMatchObject({ status: "archived" });
  });
});

describe("PATCH /rules/:id — what the caller cannot see is a 404", () => {
  it("another user's rule: 404, and nothing past the visibility read runs", async () => {
    const res = await buildApp({ userId: STRANGER }).request(
      `/rules/${RULE_ID}`,
      patch(EDIT)
    );
    expect(res.status).toBe(404);
    expect(h.visibleFor).toEqual([STRANGER]);
    expect(h.findFirstCalls).toBe(1);
    expect(h.gateCalls).toHaveLength(0);
    expect(h.automationReads).toBe(0);
    expect(h.skillWrites).toHaveLength(0);
    expect(h.automationWrites).toHaveLength(0);
  });

  it("an unknown id: 404", async () => {
    h.storedRow = undefined;
    const res = await buildApp().request(
      "/rules/66666666-6666-4666-8666-666666666666",
      patch(EDIT)
    );
    expect(res.status).toBe(404);
    expect(h.gateCalls).toHaveLength(0);
  });

  it("a non-uuid id is a 400 before any read", async () => {
    const res = await buildApp().request("/rules/not-a-rule", patch(EDIT));
    expect(res.status).toBe(400);
    expect(h.findFirstCalls).toBe(0);
  });
});

describe("PATCH /rules/:id — the same identity checks as POST /rules", () => {
  it("403s without hub-protocol.write", async () => {
    const res = await buildApp({ scopes: ["hub-protocol.read"] }).request(
      `/rules/${RULE_ID}`,
      patch(EDIT)
    );
    expect(res.status).toBe(403);
    expect(h.findFirstCalls).toBe(0);
  });

  it("rejects an agentUserId the caller may not act as (400, nothing read)", async () => {
    h.actorError = "Not authorized to act as this agentUserId";
    const res = await buildApp().request(
      `/rules/${RULE_ID}`,
      patch({ ...EDIT, agentUserId: AGENT })
    );
    expect(res.status).toBe(400);
    expect(h.findFirstCalls).toBe(0);
  });

  it("a workspace outside a bound key's confinement is a 403 (scope cannot be widened)", async () => {
    h.confineError = "This key is bound to another workspace";
    const res = await buildApp().request(
      `/rules/${RULE_ID}`,
      patch({
        ...EDIT,
        scope: {
          kind: "workspace",
          workspaceId: "77777777-7777-4777-8777-777777777777",
        },
      })
    );
    expect(res.status).toBe(403);
    expect(h.findFirstCalls).toBe(0);
  });

  it("400s on an invalid body before reaching the governed door", async () => {
    const res = await buildApp().request(
      `/rules/${RULE_ID}`,
      patch({ scope: { kind: "pod" } })
    );
    expect(res.status).toBe(400);
    expect(h.findFirstCalls).toBe(0);
  });

  it("/rules/classify and /rules/parse are not captured by /rules/:id", async () => {
    const res = await buildApp().request(
      "/rules/classify",
      patch({ text: "x" })
    );
    // No PATCH /rules/classify exists; the id route must not claim it as an
    // id and run an edit against a rule called "classify".
    expect(res.status).not.toBe(200);
    expect(h.findFirstCalls).toBe(0);
  });
});
