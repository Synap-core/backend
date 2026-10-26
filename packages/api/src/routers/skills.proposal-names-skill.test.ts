/**
 * A skill proposal NAMES the skill (needs-truth §2 (f), plan v5 PR C).
 *
 * The defect: `skills.update` gated `{ id, ...patch }`. A patch carries no name
 * unless it renames, so the summary composer found nothing to quote and five
 * pending agent edits on the founder's pod read "Update Tool" — which skill,
 * nobody could tell. Delete had the same hole (`{ id }`).
 *
 * The noun stays the vocabulary's ("Tool", founder D2, `resolveObjectNoun`);
 * what was missing is the NAME, carried display-only as `targetName`.
 *
 * Drives the REAL procedure through `createCaller` with the gate stubbed to
 * PROPOSE, then the REAL `buildProposalSummary` over the payload it was handed.
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
    delete: () => ({ where: async () => undefined }),
  };
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.permCalls.push(opts);
    return { proposalId: "p-1", proposalType: "update" };
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
import { buildProposalSummary } from "../utils/permission-check.js";

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

describe("skill proposals name the skill", () => {
  it("an agent's body edit: the gate payload carries the name, the summary quotes it", async () => {
    await runWithActingAgent(AGENT, () =>
      caller().update({ id: SKILL_ID, body: "# rewritten by an agent" })
    );
    expect(h.permCalls).toHaveLength(1);
    const data = h.permCalls[0]!.data as Record<string, unknown>;
    expect(data).toMatchObject({ id: SKILL_ID, targetName: "House style" });
    expect(buildProposalSummary("skill", "update", data)).toBe(
      'Update Tool "House style"'
    );
    // Proposed: nothing was written.
    expect(h.sets).toHaveLength(0);
  });

  it("a rename is still named by the name the reviewer knows", async () => {
    await runWithActingAgent(AGENT, () =>
      caller().update({ id: SKILL_ID, name: "House voice" })
    );
    const data = h.permCalls[0]!.data as Record<string, unknown>;
    expect(buildProposalSummary("skill", "update", data)).toBe(
      'Update Tool "House style"'
    );
  });

  it("a delete names the skill too", async () => {
    await runWithActingAgent(AGENT, () => caller().delete({ id: SKILL_ID }));
    const data = h.permCalls[0]!.data as Record<string, unknown>;
    expect(buildProposalSummary("skill", "delete", data)).toBe(
      'Delete Tool "House style"'
    );
  });
});
