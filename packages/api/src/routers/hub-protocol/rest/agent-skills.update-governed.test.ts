/**
 * PATCH /agent-skills/:slug — the door → `updateSkillGoverned` → the REAL
 * `skills.update` procedure, end to end. Only the gate verdict and the row
 * store are stubbed; nothing between the HTTP request and the UPDATE's `.set()`
 * is hand-built.
 *
 * The defect this pins: the route was a bare `db.update(skills).where(slug)`
 * behind a scope check — no gate, no owner floor, no acting agent, and
 * `approved` untouched. Any `hub-protocol.write` key could rewrite an APPROVED
 * instruction skill's body (prose injected verbatim into agents' prompts) and
 * it stayed approved and live.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  perm: {} as Record<string, unknown>,
  permCalls: [] as Array<Record<string, unknown>>,
  /** Every `.set()` an UPDATE on the skills table received. */
  sets: [] as Array<Record<string, unknown>>,
  existing: null as Record<string, unknown> | null,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.limit = async () => (h.existing ? [h.existing] : []);
  const db = {
    select: () => selectChain,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        h.sets.push(values);
        return { where: () => ({ returning: async () => [h.existing] }) };
      },
    }),
    query: { skills: { findFirst: async () => h.existing } },
  };
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.permCalls.push(opts);
    return h.perm;
  },
}));
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: () => undefined }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: () => undefined,
}));
vi.mock(
  "../../../services/skills/template-skills.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    alwaysSkillBudgetWarningsOnEdit: async () => undefined,
  })
);
// protectedProcedure's DB-backed middlewares are not this seam — pass through.
vi.mock("../../../middleware/read-only-guard.js", () => ({
  readOnlyGuardMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));
vi.mock("../../../middleware/audit-log.js", () => ({
  auditLogMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));

import { registerAgentSkillsRoutes } from "./agent-skills.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function approvedSkill(): Record<string, unknown> {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "house-style",
    name: "House style",
    description: null,
    topics: [],
    body: "# approved body",
    source: null,
    author: null,
    version: null,
    tags: [],
    teachesTools: [],
    skillGroup: null,
    alwaysOn: false,
    kind: "instruction",
    scope: "pod",
    userId: USER,
    workspaceId: null,
    approved: true,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

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

function patch(body: Record<string, unknown>) {
  return {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  h.perm = { granted: true };
  h.permCalls.length = 0;
  h.sets.length = 0;
  h.existing = approvedSkill();
});

describe("PATCH /agent-skills/:slug — governed through skills.update", () => {
  it("an AGENT rewrite of an approved skill's body lands UNAPPROVED, never silently live", async () => {
    const app = buildApp({ userId: USER, agentUserId: AGENT });
    const res = await app.request(
      "/agent-skills/house-style",
      patch({ body: "# rewritten by an agent" })
    );

    expect(res.status).toBe(200);
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "skill",
      action: "update",
    });
    expect(h.sets).toHaveLength(1);
    expect(h.sets[0]).toMatchObject({
      body: "# rewritten by an agent",
      approved: false,
    });
  });

  it("a proposed verdict writes NOTHING and answers an honest 202", async () => {
    h.perm = { proposalId: "prop-1" };
    const app = buildApp({ userId: USER, agentUserId: AGENT });
    const res = await app.request(
      "/agent-skills/house-style",
      patch({ body: "# rewritten" })
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      status: "proposed",
      proposalId: "prop-1",
    });
    expect(h.sets).toHaveLength(0);
  });

  it("an operator's own edit keeps approval (no agent on the request)", async () => {
    const app = buildApp({ userId: USER });
    const res = await app.request(
      "/agent-skills/house-style",
      patch({ body: "# operator edit" })
    );

    expect(res.status).toBe(200);
    expect(h.sets).toHaveLength(1);
    expect(h.sets[0]).toMatchObject({ body: "# operator edit" });
    expect(h.sets[0]?.approved).toBeUndefined();
  });

  it("a field the governed door cannot carry is a 400, never a silent drop", async () => {
    const app = buildApp({ userId: USER, agentUserId: AGENT });
    const res = await app.request(
      "/agent-skills/house-style",
      patch({ tags: ["x"] })
    );

    expect(res.status).toBe(400);
    expect(h.permCalls).toHaveLength(0);
    expect(h.sets).toHaveLength(0);
  });

  it("an unknown slug is a 404 and reaches no gate", async () => {
    h.existing = null;
    const app = buildApp({ userId: USER, agentUserId: AGENT });
    const res = await app.request("/agent-skills/nope", patch({ body: "# x" }));

    expect(res.status).toBe(404);
    expect(h.permCalls).toHaveLength(0);
    expect(h.sets).toHaveLength(0);
  });
});
