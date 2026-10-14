/**
 * Orient flags a space the calling AGENT has not joined (`joined: false`), so
 * the agent knows a write there files a JOIN request (the write is kept and
 * replayed once approved) — before it writes, not after.
 *
 * DB-independent: `@synap/database`'s `db` is faked at the export seam,
 * dispatching on table identity (same harness as
 * `orient-light-subtraction.test.ts`). The membership read is served from
 * `h.memberRows`; it proves the DTO flag and its gating, not the live SQL.
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

const run = (agentUserId?: string) =>
  discover({
    caller,
    userId: "u1",
    authScopes: ["mcp.read"],
    detail: "light",
    ...(agentUserId ? { agentUserId } : {}),
  });

beforeEach(() => {
  h.workspaceRows = [
    { id: "ws-a", name: "A", description: null, settings: {} },
    { id: "ws-b", name: "B", description: null, settings: {} },
  ];
  h.entityCountRows = [
    { workspaceId: "ws-a", count: 3 },
    { workspaceId: "ws-b", count: 4 },
  ];
  // The agent is a member of A only.
  h.memberRows = [{ workspaceId: "ws-a" }];
  h.memberReads = 0;
});

describe("orient — spaces the agent has not joined", () => {
  it("flags joined:false on the space the agent is not a member of, only", async () => {
    const out = await run("agent-1");
    const byId = new Map(out.workspaces.map((w) => [w.id, w]));
    expect(byId.get("ws-a")).toBeDefined();
    expect(byId.get("ws-b")).toBeDefined();
    expect("joined" in byId.get("ws-a")!).toBe(false);
    expect((byId.get("ws-b") as { joined?: boolean }).joined).toBe(false);
  });

  it("a person's own orient (no agent) reads no membership and flags nothing", async () => {
    const out = await run();
    expect(h.memberReads).toBe(0);
    expect(out.workspaces.length).toBe(2);
    for (const w of out.workspaces) expect("joined" in w).toBe(false);
  });
});
