/**
 * Pod-scope skills are not writable by every pod user (audit 2026-10-28 F6).
 *
 * THE DEFECT. `skills.update` / `delete` / `setRequiredTools` found the row
 * with `scope = pod OR userId = me`, so any signed-in pod user (a viewer of one
 * space included) could rewrite the body of a pod-scope instruction skill —
 * which is injected verbatim into the owner's agents' prompts — and it stayed
 * `approved`, because the reset fired only for an acting agent. `create`
 * defaulted to `scope: "pod"` for everyone.
 *
 * THE RULE (`services/skills/skill-write-authority.ts`): the author may change
 * the skill; anyone else needs the authority that can APPROVE it (space owner
 * for a space skill, pod admin for a pod-wide one), and a non-author's body
 * edit re-earns approval. Publishing pod-wide needs that authority too; without
 * it a new skill is the author's own.
 *
 * Drives the REAL procedures through `createCaller`; the gate verdict, the role
 * reads and the row store are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  permCalls: [] as Array<Record<string, unknown>>,
  sets: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  deletes: 0,
  existing: null as Record<string, unknown> | null,
  admins: new Set<string>(),
  wsRole: undefined as string | undefined,
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
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        h.inserts.push(values);
        return { returning: async () => [{ ...values }] };
      },
    }),
    delete: () => {
      h.deletes++;
      return { where: () => ({ returning: async () => [h.existing] }) };
    },
    query: { skills: { findFirst: async () => h.existing } },
  };
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => h.admins.has(userId),
  getWorkspaceRole: async () => h.wsRole,
}));
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

import { insertSkillGoverned, skillsRouter } from "./skills.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "44444444-4444-4444-8444-444444444444";
const SKILL_ID = "33333333-3333-4333-8333-333333333333";
const SPACE = "55555555-5555-4555-8555-555555555555";

function caller(userId: string) {
  return skillsRouter.createCaller({
    db: { query: { skills: { findFirst: async () => h.existing } } },
    authenticated: true,
    userId,
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
  h.inserts.length = 0;
  h.deletes = 0;
  h.admins = new Set([OWNER]);
  h.wsRole = undefined;
  h.existing = {
    id: SKILL_ID,
    slug: "house-style",
    name: "House style",
    body: "# approved body",
    kind: "instruction",
    scope: "pod",
    userId: OWNER,
    workspaceId: null,
    approved: true,
    status: "active",
    metadata: null,
  };
});

describe("F6: changing a pod skill someone else wrote", () => {
  it("refuses a member's body rewrite of the owner's pod skill, writes nothing", async () => {
    await expect(
      caller(MEMBER).update({ id: SKILL_ID, body: "# injected" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.sets).toHaveLength(0);
    expect(h.permCalls).toHaveLength(0);
  });

  it("refuses a member's delete of the owner's pod skill", async () => {
    await expect(caller(MEMBER).delete({ id: SKILL_ID })).rejects.toMatchObject(
      { code: "FORBIDDEN" }
    );
    expect(h.deletes).toBe(0);
  });

  it("refuses a member re-pointing the owner's pod skill's required tools", async () => {
    await expect(
      caller(MEMBER).setRequiredTools({ skillId: SKILL_ID, toolIds: [] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a space member who is not the space's owner on a space-bound skill", async () => {
    h.existing = { ...h.existing!, workspaceId: SPACE };
    h.wsRole = "editor";
    await expect(
      caller(MEMBER).update({ id: SKILL_ID, body: "# injected" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.sets).toHaveLength(0);
  });

  it("lets a pod admin edit another person's skill, and the body re-earns approval", async () => {
    h.existing = { ...h.existing!, userId: MEMBER };
    await caller(OWNER).update({ id: SKILL_ID, body: "# admin edit" });
    expect(h.sets).toHaveLength(1);
    expect(h.sets[0]).toMatchObject({ body: "# admin edit", approved: false });
  });

  it("the author's own edit keeps its approval", async () => {
    await caller(OWNER).update({ id: SKILL_ID, body: "# owner edit" });
    expect(h.sets).toHaveLength(1);
    expect(h.sets[0]?.approved).toBeUndefined();
  });
});

describe("F6: publishing a pod-wide skill", () => {
  it("refuses a member who asks for scope pod", async () => {
    await expect(
      caller(MEMBER).create({ name: "x", body: "# x", scope: "pod" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.inserts).toHaveLength(0);
  });

  it("a member's skill with no scope is their own", async () => {
    await caller(MEMBER).create({ name: "x", body: "# x" });
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]).toMatchObject({ scope: "user", userId: MEMBER });
  });

  it("a pod admin's skill with no scope stays pod-wide", async () => {
    await caller(OWNER).create({ name: "x", body: "# x" });
    expect(h.inserts[0]).toMatchObject({ scope: "pod" });
  });

  it("the shared insert door refuses a member's pod-wide skill (absent scope = the pod column default)", async () => {
    const result = await insertSkillGoverned({
      userId: MEMBER,
      workspaceId: null,
      kind: "instruction",
      name: "x",
      body: "# x",
      auditSource: "test",
    });
    expect(result.status).toBe("denied");
    expect(h.inserts).toHaveLength(0);
    expect(h.permCalls).toHaveLength(0);
  });
});
