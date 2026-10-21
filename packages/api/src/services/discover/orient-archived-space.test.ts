/**
 * Orient never lists an ARCHIVED space by default — the same rule
 * `workspaces.list` (and so `synap_list_workspaces`, `includeArchived=false`)
 * applies, through the ONE predicate `isHiddenAsArchived`.
 *
 * Live 2026-10-20: light orient listed "Radar" (archived 2026-10-11) beside
 * the live spaces, so an agent was offered an archived space to write into
 * while `synap_list_workspaces` (correctly) did not list it.
 *
 * Harness: the table-identity fake `db` of `orient-unjoined-space.test.ts`.
 * The fake ignores WHERE clauses, so this proves the DTO rule, not live SQL.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  workspaceRows: [] as Record<string, unknown>[],
  entityCountRows: [] as Record<string, unknown>[],
  memberRows: [] as Record<string, unknown>[],
  memberReads: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const thenable = (rows: unknown[]) => ({
    then: (
      resolve: (v: unknown[]) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(rows).then(resolve, reject),
  });
  const chain = (rows: unknown[], groupRows: unknown[] = []) => {
    const self: Record<string, unknown> = {
      where: () => self,
      limit: () => self,
      orderBy: () => self,
      groupBy: () => thenable(groupRows),
      then: (
        resolve: (v: unknown[]) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return self;
  };
  const fakeDb = {
    select: () => ({
      from: (table: unknown) => {
        if (table === actual.workspaces) return chain(h.workspaceRows);
        if (table === actual.workspaceMembers) {
          h.memberReads++;
          return chain(h.memberRows);
        }
        if (table === actual.entities) return chain([], h.entityCountRows);
        if (table === actual.projects) return chain([]);
        return chain([{ count: 0, oldest: null }]);
      },
    }),
  };
  return {
    ...actual,
    db: fakeDb,
    profileSlugScopeCondition: async () => ({ _tag: "profileSlugScope" }),
  };
});

vi.mock("../../utils/workspace-membership.js", () => ({
  resolveFacetVisibilityScope: async () => ({
    userId: "u1",
    workspaceId: undefined,
    allowedWorkspaceIds: [],
  }),
}));

vi.mock("../../routers/hub-protocol/rest/_shared.js", () => ({
  getUserAccessibleWorkspaceIds: async () => ["ws-a", "ws-b"],
}));

vi.mock("../team-roster-context.js", () => ({
  loadTeamRosterForCapture: async () => ({
    members: [],
    names: [],
    instructionBlock: null,
  }),
  formatTeamRosterBlock: () => null,
}));

vi.mock("./start-here.js", () => ({
  readRankedLensProfiles: () => Promise.resolve([]),
  buildStartHere: async (p: { learnMoreSkill: string }) => ({
    pendingReview: { count: 0 },
    openSessions: { count: 0, countIsLowerBound: false },
    topKinds: [],
    actions: { count: 0, examples: [], lens: "pod" },
    learnMore: { skill: p.learnMoreSkill },
  }),
}));

import { discover } from "./discover.js";

const caller = {
  profiles: { listProfiles: async () => ({ profiles: [] }) },
} as unknown as Parameters<typeof discover>[0]["caller"];

const run = (detail: "light" | "full", workspaceId?: string) =>
  discover({
    caller,
    userId: "u1",
    authScopes: ["mcp.read"],
    detail,
    ...(workspaceId ? { workspaceId } : {}),
  });

beforeEach(() => {
  h.workspaceRows = [
    {
      id: "ws-a",
      name: "A",
      description: null,
      settings: {},
      archivedAt: null,
    },
    {
      id: "ws-b",
      name: "Radar",
      description: null,
      settings: {},
      archivedAt: new Date("2026-10-11T18:22:22Z"),
    },
  ];
  // The archived space still HOLDS entities — it is hidden for being
  // archived, not for being empty.
  h.entityCountRows = [
    { workspaceId: "ws-a", count: 3 },
    { workspaceId: "ws-b", count: 59 },
  ];
  h.memberRows = [];
  h.memberReads = 0;
});

describe("orient — archived spaces", () => {
  it("light orient does not list an archived space, and does not count it as a hidden EMPTY one", async () => {
    const out = await run("light");
    expect(out.workspaces.map((w) => w.id)).toEqual(["ws-a"]);
    expect(out.workspaceCount).toBe(1);
    expect(
      (out as { hiddenEmptyWorkspaceCount?: number }).hiddenEmptyWorkspaceCount
    ).toBeUndefined();
  });

  it("full orient does not list it either (full = more detail, not archived rows)", async () => {
    const out = await run("full");
    expect(out.workspaces.map((w) => w.id)).toEqual(["ws-a"]);
  });

  it("a PIN to an archived space still answers, and says it is archived", async () => {
    // A pin reads only the pinned row (`inArray(id, [pin])`); the fake ignores
    // WHERE, so serve that row alone.
    h.workspaceRows = h.workspaceRows.filter((w) => w.id === "ws-b");
    const out = await run("light", "ws-b");
    expect(out.workspaces).toHaveLength(1);
    expect(out.workspaces[0]).toMatchObject({ id: "ws-b", archived: true });
  });

  it("a live space carries no archived mark", async () => {
    const out = await run("light");
    expect("archived" in out.workspaces[0]!).toBe(false);
  });
});
