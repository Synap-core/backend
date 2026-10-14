/**
 * `skills.update` — the body re-approval reset reads the AMBIENT acting agent.
 *
 * The defect this pins: the reset ("an agent rewriting an instruction skill's
 * body must re-earn approval") fired only when the caller put `agentUserId` in
 * the INPUT. `skillsRouter` is also reachable on plain tRPC, so an agent key
 * calling `skills.update` directly and simply omitting the field kept its body
 * rewrite `approved: true` — live in every agent prompt that loads the skill.
 * The acting agent is recorded server-side in the request ALS at every key-auth
 * entry point (`runWithActingAgent`), which the caller cannot drop.
 *
 * Drives the REAL procedure through `createCaller`; only the gate verdict and
 * the row store are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithActingAgent } from "@synap/database";

const h = vi.hoisted(() => ({
  permCalls: [] as Array<Record<string, unknown>>,
  sets: [] as Array<Record<string, unknown>>,
  existing: null as Record<string, unknown> | null,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = {
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
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.permCalls.push(opts);
    return { granted: true };
  },
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => undefined }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: () => undefined,
}));
vi.mock("../services/skills/template-skills.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  alwaysSkillBudgetWarningsOnEdit: async () => undefined,
}));
vi.mock("../middleware/read-only-guard.js", () => ({
  readOnlyGuardMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));
vi.mock("../middleware/audit-log.js", () => ({
  auditLogMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));

import { skillsRouter } from "./skills.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SKILL_ID = "33333333-3333-4333-8333-333333333333";

function caller() {
  return skillsRouter.createCaller({
    db: { query: { skills: { findFirst: async () => h.existing } } },
    authenticated: true,
    userId: USER,
    user: null,
    session: null,
    req: undefined,
    workspaceId: null,
    agentUserId: null,
  } as never);
}

beforeEach(() => {
  h.permCalls.length = 0;
  h.sets.length = 0;
  h.existing = {
    id: SKILL_ID,
    slug: "house-style",
    name: "House style",
    body: "# approved body",
    kind: "instruction",
    scope: "pod",
    userId: USER,
    workspaceId: null,
    approved: true,
    metadata: null,
  };
});

describe("skills.update — agent body rewrite without agentUserId in the input", () => {
  it("an agent-key caller that omits agentUserId still lands the body UNAPPROVED", async () => {
    await runWithActingAgent(AGENT, () =>
      caller().update({ id: SKILL_ID, body: "# rewritten by an agent" })
    );

    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({ agentUserId: AGENT });
    expect(h.sets).toHaveLength(1);
    expect(h.sets[0]).toMatchObject({
      body: "# rewritten by an agent",
      approved: false,
    });
  });

  it("a person's own edit (no agent anywhere) keeps approval", async () => {
    await caller().update({ id: SKILL_ID, body: "# operator edit" });

    expect(h.sets).toHaveLength(1);
    expect(h.sets[0]?.approved).toBeUndefined();
  });
});
