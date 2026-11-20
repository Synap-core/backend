/**
 * synap_update_skill (ticket 8c07f46c) — an agent can revise a teaching
 * skill it authored, through the ONE governed skill-update door.
 *
 * Driven through the real handler → `updateSkillGoverned` → the REAL
 * `skills.update` procedure. Only the gate verdict and the row store are
 * stubbed, so what is asserted is the `.set()` the UPDATE actually received.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  perm: {} as Record<string, unknown>,
  permCalls: [] as Array<Record<string, unknown>>,
  sets: [] as Array<Record<string, unknown>>,
  existing: null as Record<string, unknown> | null,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.limit = async () =>
    h.existing
      ? [
          {
            id: h.existing.id,
            kind: h.existing.kind,
            workspaceId: h.existing.workspaceId,
            category: h.existing.category ?? null,
            metadata: h.existing.metadata ?? null,
            name: h.existing.name ?? "House style",
            body: h.existing.body ?? null,
          },
        ]
      : [];
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
vi.mock("../../../middleware/read-only-guard.js", () => ({
  readOnlyGuardMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));
vi.mock("../../../middleware/audit-log.js", () => ({
  auditLogMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));

import { buildHandlers } from "./build.js";
import type { McpToolContext } from "./shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SKILL_ID = "33333333-3333-4333-8333-333333333333";

async function call(args: Record<string, unknown>, agentUserId?: string) {
  const res = await buildHandlers.synap_update_skill!({
    toolName: "synap_update_skill",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.write"],
    agentUserId,
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  } as McpToolContext);
  const block = res.content?.[0] as { text: string };
  return { isError: res.isError, text: block.text };
}

beforeEach(() => {
  h.perm = { granted: true };
  h.permCalls.length = 0;
  h.sets.length = 0;
  h.existing = {
    id: SKILL_ID,
    slug: "biz/house-style",
    kind: "instruction",
    scope: "pod",
    userId: USER,
    workspaceId: null,
    approved: true,
    metadata: null,
    body: "# old",
  };
});

describe("synap_update_skill", () => {
  it("an agent's body rewrite goes through the gate and lands UNAPPROVED", async () => {
    const r = await call({ slug: "biz/house-style", body: "# new" }, AGENT);

    expect(JSON.parse(r.text)).toEqual({
      status: "updated",
      skillId: SKILL_ID,
    });
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "skill",
      action: "update",
    });
    expect(h.sets).toHaveLength(1);
    expect(h.sets[0]).toMatchObject({ body: "# new", approved: false });
  });

  it("a proposed verdict is success and writes nothing", async () => {
    h.perm = { proposalId: "prop-1" };
    const r = await call({ id: SKILL_ID, body: "# new" }, AGENT);

    expect(JSON.parse(r.text)).toMatchObject({
      status: "proposed",
      skillId: SKILL_ID,
      proposalId: "prop-1",
    });
    expect(h.sets).toHaveLength(0);
  });

  it("an unknown skill is a clear error, never a silent no-op", async () => {
    h.existing = null;
    const r = await call({ slug: "nope", body: "# x" }, AGENT);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("nope");
    expect(h.permCalls).toHaveLength(0);
  });

  it("refuses a call with nothing to change", async () => {
    const r = await call({ slug: "biz/house-style" }, AGENT);

    expect(r.isError).toBe(true);
    expect(h.permCalls).toHaveLength(0);
  });

  // Ticket 01fc187c: a code skill is fixed IN PLACE, not by a second create.
  it("an agent's code fix rides the same governed door and leaves the skill off", async () => {
    h.existing = {
      ...h.existing!,
      kind: "code",
      code: "return 1;",
      timeoutSeconds: 30,
      parameters: {},
    };
    const r = await call(
      {
        id: SKILL_ID,
        code: "return 2;",
        timeoutSeconds: 120,
        parameters: { n: "number" },
      },
      AGENT
    );

    expect(JSON.parse(r.text)).toEqual({
      status: "updated",
      skillId: SKILL_ID,
    });
    // The gate saw the whole change, so a held edit replays it whole.
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "skill",
      action: "update",
      data: {
        id: SKILL_ID,
        code: "return 2;",
        timeoutSeconds: 120,
        parameters: { n: "number" },
      },
    });
    expect(h.sets[0]).toMatchObject({
      code: "return 2;",
      timeoutSeconds: 120,
      approved: false,
    });
  });

  it("refuses code on a documentation-only skill, before the gate", async () => {
    const r = await call({ id: SKILL_ID, code: "return 1;" }, AGENT);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("synap_create_skill");
    expect(h.permCalls).toHaveLength(0);
  });

  it("refuses a timeout outside 1..300 in words", async () => {
    const r = await call({ id: SKILL_ID, timeoutSeconds: 900 }, AGENT);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("1 to 300");
    expect(h.permCalls).toHaveLength(0);
  });
});

// Decision D1 (proposal 8d04d49e): `category: "rule"` makes a documentation
// skill a rule, pushed into every piece of work in its scope. The MCP door
// carries it through the SAME gate as every other field.
describe("synap_update_skill — category", () => {
  it("an agent marking a skill a rule goes through the gate, which sees the change", async () => {
    h.perm = { proposalId: "prop-rule" };
    const r = await call({ slug: "biz/house-style", category: "rule" }, AGENT);

    expect(JSON.parse(r.text)).toMatchObject({
      status: "proposed",
      proposalId: "prop-rule",
    });
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "skill",
      action: "update",
      data: { id: SKILL_ID, category: "rule" },
    });
    expect(h.sets).toHaveLength(0);
  });

  it("a granted change writes the category", async () => {
    const r = await call({ id: SKILL_ID, category: "rule" }, AGENT);

    expect(JSON.parse(r.text)).toEqual({
      status: "updated",
      skillId: SKILL_ID,
    });
    expect(h.sets[0]).toMatchObject({ category: "rule" });
  });

  it("refuses 'rule' on a code skill, before the gate", async () => {
    h.existing = { ...h.existing!, kind: "code", code: "return 1;" };
    const r = await call({ id: SKILL_ID, category: "rule" }, AGENT);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("documentation skill");
    expect(h.permCalls).toHaveLength(0);
  });

  it("refuses to take a rule-loop rule out of the rules, before the gate", async () => {
    h.existing = {
      ...h.existing!,
      category: "rule",
      metadata: {
        rule: { intent: "Tag every new lead", scope: { kind: "pod" } },
      },
    };
    const r = await call({ id: SKILL_ID, category: "custom" }, AGENT);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("synap_update_rule");
    expect(h.permCalls).toHaveLength(0);
  });

  it("lets a prose rule go back to a plain skill, through the gate", async () => {
    h.perm = { proposalId: "prop-unrule" };
    h.existing = { ...h.existing!, category: "rule", metadata: null };
    const r = await call({ id: SKILL_ID, category: "custom" }, AGENT);

    expect(JSON.parse(r.text)).toMatchObject({ status: "proposed" });
    expect(h.permCalls[0]).toMatchObject({ data: { category: "custom" } });
  });

  it("refuses an empty category in words", async () => {
    const r = await call({ id: SKILL_ID, category: "  " }, AGENT);

    expect(r.isError).toBe(true);
    expect(r.text).toContain("category");
    expect(h.permCalls).toHaveLength(0);
  });
  it("warns, never refuses, when a rule's words are over the standing-rules tier", async () => {
    h.perm = { proposalId: "prop-big" };
    h.existing = { ...h.existing!, body: "x".repeat(8_004) };
    const r = await call({ id: SKILL_ID, category: "rule" }, AGENT);

    const out = JSON.parse(r.text) as { status: string; warnings?: string[] };
    expect(out.status).toBe("proposed");
    expect(out.warnings?.[0]).toContain("standing-rules tier");
  });

  it("no warning for a rule that fits, nor for a big skill that is not a rule", async () => {
    h.perm = { proposalId: "prop-fit" };
    const fits = JSON.parse(
      (await call({ id: SKILL_ID, category: "rule" }, AGENT)).text
    ) as { warnings?: string[] };
    expect(fits.warnings).toBeUndefined();

    h.existing = { ...h.existing!, body: "x".repeat(8_004) };
    const notRule = JSON.parse(
      (await call({ id: SKILL_ID, description: "d" }, AGENT)).text
    ) as { warnings?: string[] };
    expect(notRule.warnings).toBeUndefined();
  });
});
