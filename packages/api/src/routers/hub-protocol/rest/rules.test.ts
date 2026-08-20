/**
 * Hub Protocol REST — /rules
 *
 * What these pin:
 *  1. `/rules/classify` reaches the ONE classifier and returns its full route
 *     (shapes + confidences + the literal cues that fired), and writes NOTHING.
 *  2. A one-off ask carries the `oneShot` signal through the wire unchanged —
 *     that is the expensive mistake the classifier exists to prevent, so it
 *     must survive the REST hop.
 *  3. `POST /rules` returns HTTP 200 with `{status:"proposed"}` — a proposal is
 *     a SUCCESS, never an error status.
 *  4. The create door is ATTRIBUTED: the context `agentUserId` an agent key
 *     carries is verified and threaded into `createRuleGoverned`, so the gate
 *     sees an agent write.
 *  5. `/rules/classify` is not shadowed: it resolves as the static route even
 *     when a `/rules/:id` route is registered after it (a regression guard for
 *     the day someone adds a get-by-id door).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  createResult: {} as Record<string, unknown>,
  dbWrites: 0,
  findManyRows: [] as Array<Record<string, unknown>>,
  actorError: null as string | null,
}));

vi.mock("@synap/database", () => ({
  db: {
    query: { skills: { findMany: vi.fn(async () => h.findManyRows) } },
    insert: vi.fn(() => {
      h.dbWrites++;
      return { values: vi.fn(() => ({ returning: vi.fn(async () => []) })) };
    }),
    update: vi.fn(() => {
      h.dbWrites++;
      return { set: vi.fn(() => ({ where: vi.fn(async () => []) })) };
    }),
  },
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  and: (...c: unknown[]) => ({ op: "and", c }),
  desc: (a: unknown) => ({ op: "desc", a }),
  skills: { id: "id", category: "category", createdAt: "createdAt" },
}));

vi.mock("./_shared.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  hasScope: (scopes: string[], scope: string) => scopes.includes(scope),
  httpStatusForTrpcError: () => 500,
  confineWorkspaceOrForbidden: (
    _c: unknown,
    requested: string | null | undefined
  ) => ({ ok: true as const, workspaceId: requested }),
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

vi.mock("../../../services/rules/create.js", () => ({
  createRuleGoverned: async (input: Record<string, unknown>) => {
    h.createCalls.push(input);
    return h.createResult;
  },
}));

vi.mock("../../../services/rules/index.js", () => ({
  RULE_CATEGORY: "rule",
  readRuleMetadata: (m: unknown) =>
    (m as { rule?: unknown } | null)?.rule ?? null,
}));

vi.mock("../../../services/skills/visibility.js", () => ({
  visibleSkillsWhere: (userId: string, workspaceId?: string) => ({
    op: "visible",
    userId,
    workspaceId,
  }),
}));

// NOT mocked — the classifier is the thing under test on the classify door.
import { registerRulesRoutes } from "./rules.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

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

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  h.createCalls.length = 0;
  h.dbWrites = 0;
  h.findManyRows = [];
  h.actorError = null;
  h.createResult = { status: "created", ruleId: "rule-1" };
});

describe("POST /rules/classify", () => {
  it("returns shapes with confidences and the cues that fired, and writes nothing", async () => {
    const app = buildApp();
    const res = await app.request(
      "/rules/classify",
      post({
        text: "Whenever a new invoice lands, post a summary to the finance channel.",
      })
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      shapes: Array<{ shape: string; confidence: number; cues: string[] }>;
      primary: string;
      oneShot: boolean;
    };

    expect(json.shapes.length).toBeGreaterThan(0);
    for (const s of json.shapes) {
      expect(typeof s.shape).toBe("string");
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(0.95);
    }
    // At least one shape must explain itself — an unexplained classification
    // is not reviewable, which is the whole point of returning cues.
    expect(json.shapes.some((s) => s.cues.length > 0)).toBe(true);
    expect(json.shapes.map((s) => s.shape)).toContain("behaviour");
    expect(json.primary).not.toBe("unknown");

    // READ-ONLY door.
    expect(h.dbWrites).toBe(0);
    expect(h.createCalls).toHaveLength(0);
  });

  it("carries the one-shot signal for a one-off ask", async () => {
    const app = buildApp();
    const res = await app.request(
      "/rules/classify",
      post({ text: "Can you summarise this document for me right now?" })
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { oneShot: boolean };
    expect(json.oneShot).toBe(true);
    expect(h.dbWrites).toBe(0);
  });

  it("400s on a missing text", async () => {
    const app = buildApp();
    const res = await app.request("/rules/classify", post({}));
    expect(res.status).toBe(400);
  });

  it("403s without hub-protocol.read", async () => {
    const app = buildApp({ scopes: [] });
    const res = await app.request("/rules/classify", post({ text: "hello" }));
    expect(res.status).toBe(403);
  });
});

describe("POST /rules — governed create", () => {
  it('returns 200 with {status:"proposed"} — a proposal is a SUCCESS', async () => {
    h.createResult = { status: "proposed", proposalId: "prop-9" };
    const app = buildApp({ agentUserId: AGENT });
    const res = await app.request(
      "/rules",
      post({ intent: "Brief me before every call", scope: { kind: "pod" } })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "proposed",
      proposalId: "prop-9",
    });
  });

  it("attributes the write to the agent the key carries", async () => {
    h.createResult = { status: "proposed", proposalId: "prop-9" };
    const app = buildApp({ agentUserId: AGENT });
    await app.request(
      "/rules",
      post({ intent: "Brief me before every call", scope: { kind: "pod" } })
    );

    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0]).toMatchObject({
      userId: USER,
      agentUserId: AGENT,
      intent: "Brief me before every call",
      auditSource: "hub.rules.create",
    });
  });

  it("omits agentUserId entirely for a human key (no fabricated agent)", async () => {
    const app = buildApp();
    await app.request("/rules", post({ intent: "x", scope: { kind: "pod" } }));
    expect(h.createCalls[0]).not.toHaveProperty("agentUserId");
  });

  it("rejects an agentUserId the caller may not act as (400, no create)", async () => {
    h.actorError = "Not authorized to act as this agentUserId";
    const app = buildApp();
    const res = await app.request(
      "/rules",
      post({ intent: "x", scope: { kind: "pod" }, agentUserId: AGENT })
    );
    expect(res.status).toBe(400);
    expect(h.createCalls).toHaveLength(0);
  });

  it('maps a "denied" verdict to 403', async () => {
    h.createResult = { status: "denied", reason: "nope" };
    const app = buildApp();
    const res = await app.request(
      "/rules",
      post({ intent: "x", scope: { kind: "pod" } })
    );
    expect(res.status).toBe(403);
  });

  it("400s on an invalid body before reaching the governed door", async () => {
    const app = buildApp();
    const res = await app.request("/rules", post({ scope: { kind: "pod" } }));
    expect(res.status).toBe(400);
    expect(h.createCalls).toHaveLength(0);
  });

  it("403s without hub-protocol.write", async () => {
    const app = buildApp({ scopes: ["hub-protocol.read"] });
    const res = await app.request(
      "/rules",
      post({ intent: "x", scope: { kind: "pod" } })
    );
    expect(res.status).toBe(403);
    expect(h.createCalls).toHaveLength(0);
  });
});

describe("GET /rules", () => {
  it("returns rules under the visibility floor, dropping non-rule metadata", async () => {
    h.findManyRows = [
      {
        id: "r1",
        name: "Rule one",
        approved: true,
        workspaceId: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        metadata: { rule: { intent: "one" } },
      },
      {
        id: "r2",
        name: "Not a rule",
        approved: false,
        workspaceId: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        metadata: {},
      },
    ];
    const app = buildApp();
    const res = await app.request("/rules");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rules: Array<{ id: string }> };
    expect(json.rules.map((r) => r.id)).toEqual(["r1"]);
  });

  it("403s without hub-protocol.read", async () => {
    const app = buildApp({ scopes: [] });
    expect((await app.request("/rules")).status).toBe(403);
  });
});

describe("route ordering — /rules/classify is not shadowed", () => {
  it("resolves classify as the static route even with a later /rules/:id", async () => {
    const app = buildApp();
    // Simulate the future get-by-id door being added AFTER registerRulesRoutes.
    app.get("/rules/:id", (c) => c.json({ shadowed: c.req.param("id") }));

    const res = await app.request(
      "/rules/classify",
      post({ text: "Every Monday send me the pipeline." })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("shadowed");
    expect(json).toHaveProperty("shapes");
  });
});
