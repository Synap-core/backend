/**
 * `skills.update` on a BOX skill judges the bag the UPDATE STORES — the patch
 * shallow-merged onto the live bag — against "a box skill is never read-only".
 *
 * The defect this pins: the door checked only the PATCH. A box skill whose live
 * bag already said `readOnly: true` (the template applier merged it in, before
 * that door was fixed too) kept it through every edit that did not mention
 * readOnly, and the capability gate auto-runs a declared reader
 * (`verbDeclaresReadOnly`): a script with packages and network, unreviewed.
 *
 * Drives the REAL procedure through `createCaller`; only the gate verdict and
 * the row store are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
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
  checkPermissionOrPropose: async () => ({ granted: true }),
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
const SKILL_ID = "33333333-3333-4333-8333-333333333333";

const BOX_STORED = {
  language: "python",
  entrypoint: "main.py",
  packages: [{ name: "pandas", version: "2.2.3" }],
  hosts: ["api.example.com"],
  limits: {
    wallSeconds: 900,
    cpus: 2,
    memoryMb: 2048,
    diskMb: 8192,
    outMb: 200,
  },
};

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

function boxSkill(metadata: Record<string, unknown>) {
  return {
    id: SKILL_ID,
    slug: "crunch",
    name: "crunch",
    body: null,
    kind: "code",
    code: "import pandas as pd\n",
    executionMode: "box",
    scope: "pod",
    userId: USER,
    workspaceId: null,
    approved: true,
    metadata,
  };
}

beforeEach(() => {
  h.sets.length = 0;
  h.existing = null;
});

describe("skills.update — a box skill is never read-only, judged on the stored bag", () => {
  it("a LIVE readOnly: true is refused, even when the patch does not mention it", async () => {
    h.existing = boxSkill({ box: BOX_STORED, readOnly: true });
    await expect(
      caller().update({
        id: SKILL_ID,
        metadata: { marketSource: { slug: "vendor-pack" } },
      })
    ).rejects.toThrow("A box skill cannot be read-only");
    await expect(
      caller().update({ id: SKILL_ID, description: "Crunch a csv" })
    ).rejects.toThrow("A box skill cannot be read-only");
    expect(h.sets).toEqual([]);
  });

  it("a patch that clears it (readOnly: false) is stored", async () => {
    h.existing = boxSkill({ box: BOX_STORED, readOnly: true });
    await caller().update({ id: SKILL_ID, metadata: { readOnly: false } });
    expect(h.sets).toHaveLength(1);
    expect(h.sets[0]?.metadata).toEqual({ box: BOX_STORED, readOnly: false });
  });

  it("a box skill with no readOnly edits as before", async () => {
    h.existing = boxSkill({ box: BOX_STORED });
    await caller().update({ id: SKILL_ID, description: "Crunch a csv" });
    expect(h.sets).toHaveLength(1);
  });
});
