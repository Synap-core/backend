/**
 * A PROSE rule through the tRPC rule doors (decision D1, founder, 20 Nov 2026,
 * proposal 8d04d49e): a skill marked `category: "rule"` with NO
 * `metadata.rule` (`rules/start-here`, `rules/ui-rules`…).
 *
 * Before this change every door below read `metadata.rule` only: `listRules`
 * dropped the row, `getRule` answered "Rule not found", so marking the pod's
 * prose rules as rules would have hidden them from the Rules list. What is
 * pinned here:
 *   - `listRules` / `getRule` show it, as a rule, with its body as its words,
 *     its row scope as its scope, and no behaviour (`form: "prose"`);
 *   - the rule-loop edit doors (`renewRule`) refuse it and name the skill door;
 *   - `skills.update` refuses `category: "rule"` on a code skill, and refuses
 *     to take a rule-loop rule out of the rules, BEFORE the gate.
 *
 * Drives the REAL procedures through `createCaller`; only the row store, the
 * lineage reads (links / automations tables) and the gate are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  existing: null as Record<string, unknown> | null,
  permCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = {
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [h.existing] }) }),
    }),
    query: { skills: { findFirst: async () => h.existing } },
  };
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../services/rules/lineage.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRuleHealthBulk: async () => new Map(),
  readRuleAutomationIds: async () => [],
  readRuleFactSkillId: async () => null,
}));
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.permCalls.push(opts);
    return { proposalId: "prop-1" };
  },
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => undefined }));
vi.mock("../middleware/read-only-guard.js", () => ({
  readOnlyGuardMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));
vi.mock("../middleware/audit-log.js", () => ({
  auditLogMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));

const { skillsRouter } = await import("./skills.js");

const USER = "11111111-1111-4111-8111-111111111111";
const PROSE_ID = "44444444-4444-4444-8444-444444444444";
const LOOP_ID = "55555555-5555-4555-8555-555555555555";
const WS = "66666666-6666-4666-8666-666666666666";

const PROSE = {
  id: PROSE_ID,
  userId: USER,
  slug: "rules/shared-tree",
  name: "Shared tree",
  kind: "instruction",
  category: "rule",
  scope: "workspace",
  workspaceId: WS,
  approved: true,
  status: "active",
  body: "Never stash in a shared tree.",
  description: "How to work in a tree other sessions edit.",
  metadata: { autoLoad: false },
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
};

const LOOP = {
  ...PROSE,
  id: LOOP_ID,
  slug: null,
  name: "Tag every new lead",
  scope: "pod",
  workspaceId: null,
  body: "Tag every new lead",
  metadata: {
    rule: {
      v: 1,
      intent: "Tag every new lead",
      scope: { kind: "pod" },
      behaviours: [],
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  },
};

function caller() {
  return skillsRouter.createCaller({
    db: {
      query: {
        skills: {
          findMany: async () => h.rows,
          findFirst: async () => h.existing,
        },
      },
    },
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
  h.rows = [];
  h.existing = null;
  h.permCalls.length = 0;
});

describe("a prose rule in the rule read doors", () => {
  it("listRules lists it as a rule, beside a rule-loop rule", async () => {
    h.rows = [PROSE, LOOP];
    const { rules } = await caller().listRules({});
    expect(rules.map((r) => [r.id, r.form])).toEqual([
      [PROSE_ID, "prose"],
      [LOOP_ID, "loop"],
    ]);
    const prose = rules[0]!;
    expect(prose.rule.intent).toBe("Never stash in a shared tree.");
    expect(prose.rule.scope).toEqual({ kind: "workspace", workspaceId: WS });
    expect(prose.rule.behaviours).toEqual([]);
    expect(prose.automationIds).toEqual([]);
    expect(prose.status).toBe("active");
  });

  it("getRule shows it, with nothing to diverge", async () => {
    h.existing = PROSE;
    const { rule, divergence } = await caller().getRule({ id: PROSE_ID });
    expect(rule.form).toBe("prose");
    expect(rule.rule.intent).toBe("Never stash in a shared tree.");
    expect(divergence).toEqual({ diverged: false, behaviours: [] });
  });

  it("a row that is not a rule at all is still not found", async () => {
    h.existing = { ...PROSE, category: null };
    await expect(caller().getRule({ id: PROSE_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("a prose rule in the rule-loop edit doors", () => {
  it("renewRule refuses it and names the skill door", async () => {
    h.existing = PROSE;
    await expect(
      caller().renewRule({ id: PROSE_ID, expiresAt: null })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("synap_update_skill"),
    });
  });
});

describe("skills.update — category", () => {
  it("files 'rule' on a documentation skill through the gate", async () => {
    h.existing = { ...PROSE, category: null };
    const out = await caller().update({ id: PROSE_ID, category: "rule" });
    expect(out).toMatchObject({ status: "proposed" });
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "skill",
      action: "update",
      data: { id: PROSE_ID, category: "rule" },
    });
  });

  it("refuses 'rule' on a code skill before the gate", async () => {
    h.existing = { ...PROSE, kind: "code", code: "return 1;", category: null };
    await expect(
      caller().update({ id: PROSE_ID, category: "rule" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.permCalls).toHaveLength(0);
  });

  it("refuses to turn a prose rule into code before the gate", async () => {
    h.existing = PROSE;
    await expect(
      caller().update({ id: PROSE_ID, kind: "code", code: "return 1;" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.permCalls).toHaveLength(0);
  });

  it("refuses to take a rule-loop rule out of the rules before the gate", async () => {
    h.existing = LOOP;
    await expect(
      caller().update({ id: LOOP_ID, category: "custom" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("synap_update_rule"),
    });
    expect(h.permCalls).toHaveLength(0);
  });
});
