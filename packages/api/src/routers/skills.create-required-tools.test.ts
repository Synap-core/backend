/**
 * `skills.create` — a code skill DECLARES the tools it calls (ticket c5058d24).
 *
 * The `requires` edges are the scope a verb's decision covers (`verbAct`), so
 * without them every run of an agent-authored code skill needed a second
 * approval for its own `callProvider` POST. `requiredToolIds` now rides the
 * create: in the gate's stored data on the proposed path (replayed by the
 * `skill/create` executor — see `skill-create-approval-wiring.test.ts`), and
 * through `replaceSkillRequiredTools` (the `setRequiredTools` body) on the
 * direct path. A tool the author cannot see is refused before the gate.
 *
 * Stubbed: the read-only / audit middlewares, the governance gate, the tool
 * visibility read, the skill insert, and the links door (the edge sink).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  gated: [] as Array<Record<string, unknown>>,
  verdict: { proposalId: "proposal-1" } as Record<string, unknown>,
  visibleTools: [] as Array<{ id: string; name: string }>,
  links: [] as Array<Record<string, unknown>>,
}));

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (args: { data: Record<string, unknown> }) => {
    h.gated.push(args.data);
    return h.verdict;
  },
  createPendingProposal: async () => ({ proposalId: "proposal-1" }),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: vi.fn(),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    select: () => ({
      from: () => ({ where: async () => h.visibleTools }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => [{ ...v }],
      }),
    }),
  },
}));
vi.mock("../services/links/links-service.js", () => ({
  getLinksFor: async () => [],
  createLinks: async (rows: Array<Record<string, unknown>>) => {
    h.links.push(...rows);
    return rows;
  },
  deleteLink: async () => undefined,
}));

import { skillsRouter } from "./skills.js";

const member = () =>
  skillsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: null,
  } as never);

const TOOL = "7b0d9c4e-1f2a-4c3b-9d8e-5a6b7c8d9e0f";
const SKILL = {
  name: "score_handle",
  code: "return { ok: true };",
  requiredToolIds: [TOOL],
};

beforeEach(() => {
  h.gated.length = 0;
  h.links.length = 0;
  h.visibleTools = [{ id: TOOL, name: "apify_api" }];
  h.verdict = { proposalId: "proposal-1" };
});

describe("skills.create: requiredToolIds", () => {
  it("rides the gate's stored data on the proposed path (the replay's input)", async () => {
    expect(await member().create(SKILL)).toMatchObject({ status: "proposed" });
    expect(h.gated[0]).toMatchObject({
      requiredToolIds: [TOOL],
      // The display twin the summary names (a scope grant).
      requiredToolNames: ["apify_api"],
    });
    // Nothing is linked before a reviewer approves.
    expect(h.links).toEqual([]);
  });

  it("writes the `requires` edges on the direct path", async () => {
    h.verdict = { granted: true };
    expect(await member().create(SKILL)).toMatchObject({ status: "created" });
    expect(h.links).toEqual([
      expect.objectContaining({
        fromType: "skill",
        toType: "tool",
        toId: TOOL,
        linkType: "requires",
      }),
    ]);
  });

  it("refuses a tool the author cannot see, before the gate", async () => {
    h.visibleTools = [];
    await expect(member().create(SKILL)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(h.gated).toEqual([]);
  });

  it("a create naming no tools carries no key", async () => {
    await member().create({ name: "x", code: "return 1;" });
    expect(h.gated[0]).not.toHaveProperty("requiredToolIds");
  });
});
