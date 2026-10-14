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
  selectChain.limit = async () => (h.existing ? [{ id: h.existing.id }] : []);
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
});
