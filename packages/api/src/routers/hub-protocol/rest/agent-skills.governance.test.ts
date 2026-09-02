/**
 * POST /agent-skills governance — the Hub door must persist through the ONE
 * governed skill-insert door (`insertSkillGoverned`, routers/skills.ts), the
 * same door its `/agent-skills/import` sibling already uses.
 *
 * The defect this pins: the route checked only the `hub-protocol.write` scope
 * and then ran a direct `db.insert(skills)` — no `checkPermissionOrPropose`, no
 * `agentUserId` read, and a fabricated `userId: "system"` fallback. An agent
 * bearer could mint pod-wide `instruction` rows (and squat their slugs) with no
 * governance record at all.
 *
 * Proven here:
 *  1. The direct `db.insert(skills)` is GONE — persistence goes through
 *     insertSkillGoverned.
 *  2. The context-injected `agentUserId` (agent API key) is forwarded, so the
 *     gate can tell an agent-initiated create from an operator's own action.
 *  3. A "proposed" verdict returns an HONEST 202 envelope and no skill body —
 *     the door never fakes a created row for a write awaiting review.
 *  4. A "denied" verdict is a 403, not a silent write.
 *  5. The pre-existing contract is preserved: 200 + wireSkill on success, 409
 *     on slug collision (checked BEFORE the gate, as before).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  governedCalls: [] as Array<Record<string, unknown>>,
  governedResult: {} as Record<string, unknown>,
  /** Rows the slug-uniqueness pre-check finds. Empty = slug is free. */
  slugLookupRows: [] as Array<{ id: string }>,
  directInsertCalls: 0,
}));

vi.mock("@synap/database", () => {
  const selectChain: Record<string, unknown> = {};
  selectChain.from = vi.fn(() => selectChain);
  selectChain.where = vi.fn(() => selectChain);
  selectChain.limit = vi.fn(async () => h.slugLookupRows);
  return {
    db: {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => {
        h.directInsertCalls++;
        return {
          values: vi.fn(() => ({ returning: vi.fn(async () => []) })),
        };
      }),
    },
    eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
    and: (...c: unknown[]) => ({ op: "and", c }),
    skills: { id: "id", slug: "slug", kind: "kind", status: "status" },
  };
});

vi.mock("drizzle-orm", () => ({
  sql: Object.assign(() => ({ op: "sql" }), { raw: () => ({ op: "raw" }) }),
}));

vi.mock("./_shared.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  hasScope: (scopes: string[], scope: string) => scopes.includes(scope),
  getCaller: async () => ({
    documents: { createDocument: async () => ({ documentId: "doc-1" }) },
  }),
}));

// Mocked like `visibility.js` below: this file tests GOVERNANCE, not SQL, and
// the real module pulls the drizzle schema in (which this file's `drizzle-orm`
// mock deliberately does not provide). Applying the predicate at the door is
// pinned separately by `expiry-enforced.tripwire.test.ts`.
vi.mock("../../../services/rules/expiry.js", () => ({
  ruleNotExpiredWhere: () => ({ op: "ruleNotExpired" }),
}));

vi.mock("../../../services/skills/visibility.js", () => ({
  visibleSkillsWhere: () => ({ op: "visible" }),
}));

vi.mock("../../skills.js", () => ({
  insertSkillGoverned: async (input: Record<string, unknown>) => {
    h.governedCalls.push(input);
    return h.governedResult;
  },
}));

import { registerAgentSkillsRoutes } from "./agent-skills.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const SKILL_ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "my-skill",
  name: "My Skill",
  description: null,
  topics: [],
  body: "# body",
  source: null,
  author: null,
  version: null,
  tags: [],
  teachesTools: [],
  skillGroup: null,
  alwaysOn: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function buildApp(vars: Partial<HubVariables>): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", vars.scopes ?? ["hub-protocol.write"]);
    if (vars.userId !== undefined) c.set("userId", vars.userId);
    if (vars.agentUserId) c.set("agentUserId", vars.agentUserId);
    await next();
  });
  registerAgentSkillsRoutes(app);
  return app;
}

function createReq(extra: Record<string, unknown> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug: "my-skill",
      name: "My Skill",
      body: "# body",
      ...extra,
    }),
  };
}

beforeEach(() => {
  h.governedCalls.length = 0;
  h.slugLookupRows = [];
  h.directInsertCalls = 0;
  h.governedResult = { status: "installed", skill: SKILL_ROW };
});

describe("POST /agent-skills — persists through the governed door", () => {
  it("never runs a direct db.insert(skills) — it calls insertSkillGoverned", async () => {
    const app = buildApp({ userId: USER });
    const res = await app.request("/agent-skills", createReq());

    expect(res.status).toBe(200);
    expect(h.directInsertCalls).toBe(0);
    expect(h.governedCalls).toHaveLength(1);
    expect(h.governedCalls[0]).toMatchObject({
      userId: USER,
      kind: "instruction",
      scope: "pod",
      workspaceId: null,
      slug: "my-skill",
      auditSource: "agent_skills_create",
    });
    // Response contract preserved: the wire-shaped skill, not a raw row.
    expect(await res.json()).toMatchObject({
      id: SKILL_ROW.id,
      slug: "my-skill",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("forwards the context-injected agentUserId so the gate sees an agent create", async () => {
    const app = buildApp({ userId: USER, agentUserId: AGENT });
    await app.request("/agent-skills", createReq());

    expect(h.governedCalls[0]?.agentUserId).toBe(AGENT);
  });

  it("an operator create (no agent key) carries no agentUserId", async () => {
    const app = buildApp({ userId: USER });
    await app.request("/agent-skills", createReq());

    // Assert the call HAPPENED first — otherwise `[0]?.x` is undefined for the
    // wrong reason and the assertion below passes vacuously.
    expect(h.governedCalls).toHaveLength(1);
    expect(h.governedCalls[0]?.agentUserId).toBeUndefined();
  });

  it("returns an HONEST 202 proposal envelope — never a faked created row", async () => {
    h.governedResult = { status: "proposed", proposalId: "proposal-1" };
    const app = buildApp({ userId: USER, agentUserId: AGENT });
    const res = await app.request("/agent-skills", createReq());

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "proposed", proposalId: "proposal-1" });
    // No skill identity is invented for a write that has not happened.
    expect(body.id).toBeUndefined();
    expect(h.directInsertCalls).toBe(0);
  });

  it("surfaces a governance denial as 403 and writes nothing", async () => {
    h.governedResult = { status: "denied", reason: "Permission denied" };
    const app = buildApp({ userId: USER, agentUserId: AGENT });
    const res = await app.request("/agent-skills", createReq());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Permission denied" });
    expect(h.directInsertCalls).toBe(0);
  });

  it("keeps the 409 slug guard ahead of the gate (no slug squatting via proposals)", async () => {
    h.slugLookupRows = [{ id: "existing" }];
    const app = buildApp({ userId: USER, agentUserId: AGENT });
    const res = await app.request("/agent-skills", createReq());

    expect(res.status).toBe(409);
    expect(h.governedCalls).toHaveLength(0);
  });

  it("refuses an unauthenticated write instead of fabricating a 'system' principal", async () => {
    const app = buildApp({ userId: undefined });
    const res = await app.request("/agent-skills", createReq());

    expect(res.status).toBe(401);
    expect(h.governedCalls).toHaveLength(0);
    expect(h.directInsertCalls).toBe(0);
  });
});
