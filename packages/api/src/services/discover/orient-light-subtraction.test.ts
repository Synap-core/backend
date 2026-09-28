/**
 * Orient's LIGHT payload is a BRIEFING, not an inventory — and `detail:'full'`
 * is what makes that subtraction safe.
 *
 * Measured live (2026-09-05) the light payload was dominated by rows that do
 * not help an agent act: 26 profile rows (the schema listing the profile tool
 * already serves), 4 workspaces holding zero entities, and a `description`
 * that was a rendering of the `domain` field on the same row ("Domain:
 * personal" on 9 of 14). This pins the three subtractions AND the escape
 * hatch: every one of them must still be there under `detail:'full'`.
 *
 * It also pins the `who` block's floor — a prose line about the PERSON is the
 * one thing orient never carried — including the case that matters most: no
 * observations must yield NO key, never an empty heading that would teach the
 * agent the pod knows nothing about its owner.
 *
 * DB-INDEPENDENT. There is no local Postgres in this environment, so
 * `@synap/database`'s `db` is faked at the export seam (dispatch on table
 * identity, the convention `document-body-neighbors.test.ts` uses for
 * `getDb()`). That proves the DTO SHAPE and its gating — not that the live SQL
 * predicates floor correctly, which needs a real database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  workspaceRows: [] as Record<string, unknown>[],
  rankedPromise: null as unknown,
  startHereRanked: null as unknown,
  briefCalls: [] as Array<Record<string, unknown>>,
  entityCountRows: [] as Record<string, unknown>[],
  observationRows: [] as Record<string, unknown>[],
  projectRows: [] as Record<string, unknown>[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();

  const thenable = (rows: unknown[]) => ({
    then: (
      resolve: (v: unknown[]) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(rows).then(resolve, reject),
  });
  // `entities` is queried twice with different shapes: the per-workspace count
  // (which calls .groupBy) and the user_observation read (which calls .limit).
  // Dispatch on that, so one table can serve both without a second seam.
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
        if (table === actual.entities)
          return chain(h.observationRows, h.entityCountRows);
        if (table === actual.projects) return chain(h.projectRows);
        // proposals → no pending backlog
        return chain([{ count: 0, oldest: null }]);
      },
    }),
  };

  return {
    ...actual,
    db: fakeDb,
    // The polymorphic type-match door needs its own `profiles` lookup; stub it
    // to a sentinel predicate (same seam `knowledge/__tests__/structured.test.ts`
    // uses). What this file proves is the `who` block's FLOOR and its prose —
    // the door's own kind-vs-facet resolution has its own tests.
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
  getUserAccessibleWorkspaceIds: async () => [
    "ws-full",
    "ws-empty",
    "ws-onboard",
  ],
}));

vi.mock("../team-roster-context.js", () => ({
  loadTeamRosterForCapture: async () => ({
    members: [],
    names: [],
    instructionBlock: null,
  }),
  formatTeamRosterBlock: () => null,
}));

// The briefing's own sections have their own tests (`start-here.test.ts`,
// `usage-aggregate.pglite.test.ts`); this file proves the lens map around it.
vi.mock("./start-here.js", () => ({
  readRankedLensProfiles: () => {
    h.rankedPromise = Promise.resolve([]);
    return h.rankedPromise;
  },
  buildStartHere: async (p: { learnMoreSkill: string; ranked?: unknown }) => ({
    ...((h.startHereRanked = p.ranked), {}),
    pendingReview: { count: 0 },
    openSessions: { count: 0, countIsLowerBound: false },
    topKinds: [],
    actions: { count: 0, examples: [], lens: "pod" },
    learnMore: { skill: p.learnMoreSkill },
  }),
}));

// The brief's CONTENT has its own tests (`space-brief.test.ts`); this file
// proves orient SERVES it when — and only when — a space is pinned.
vi.mock("./space-brief.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./space-brief.js")>()),
  buildSpaceBrief: async (p: Record<string, unknown>) => {
    h.briefCalls.push(p);
    return { workspaceId: p.workspaceId, name: "brief", more: "m" };
  },
}));

import { discover } from "./discover.js";

const PROFILE_ROWS = {
  profiles: [
    { slug: "task", name: "Task", profileKind: "kind" },
    { slug: "person", name: "Person", profileKind: "kind" },
  ],
};

const caller = {
  profiles: { listProfiles: async () => PROFILE_ROWS },
} as unknown as Parameters<typeof discover>[0]["caller"];

const run = (
  detail: "light" | "full",
  scope?: Array<"workspaces" | "projects" | "profiles">
) =>
  discover({ caller, userId: "u1", authScopes: ["mcp.read"], detail, scope });

beforeEach(() => {
  h.workspaceRows = [
    // Real domain, holds data, has NO authored description — only a domain.
    {
      id: "ws-full",
      name: "Builder",
      description: null,
      settings: { workspaceSubtype: "personal" },
      workspaceType: "personal",
    },
    // Zero entities, nothing waiting on it — pure noise in a "where do I
    // write?" decision.
    {
      id: "ws-empty",
      name: "New Workspace",
      description: null,
      settings: { workspaceSubtype: "personal" },
      workspaceType: "personal",
    },
    // Zero entities but a fresh template install with an onboarding goal —
    // empty because it is WAITING for the user, so it is not noise.
    {
      id: "ws-onboard",
      name: "Foundation",
      description: null,
      settings: {
        workspaceSubtype: "foundation",
        onboarding: { goal: "Capture the strategic DNA.", steps: ["a", "b"] },
      },
      workspaceType: "foundation",
    },
  ];
  h.entityCountRows = [{ workspaceId: "ws-full", count: 901 }];
  h.observationRows = [];
  h.projectRows = [];
  h.briefCalls = [];
});

describe("orient light — subtraction", () => {
  it("omits the entity-type inventory, and says where it went", async () => {
    const light = await run("light");
    expect(light.profiles).toBeUndefined();
    // The absence must be explained, and NOT by naming a tool: a runtime
    // response string reaches the Control Plane door verbatim, where the tool
    // is called `pod__list_profiles`, not `synap_list_profiles`.
    expect(light.note).toMatch(/profile-listing tool/i);
    expect(light.note).not.toMatch(/synap_list_profiles|pod__list_profiles/);
  });

  it("hides empty domains but keeps onboarding-pending ones, and reports the count", async () => {
    const light = await run("light");
    const ids = light.workspaces.map((w) => w.id);
    expect(ids).toContain("ws-full");
    expect(ids).toContain("ws-onboard");
    expect(ids).not.toContain("ws-empty");
    expect(light.hiddenEmptyWorkspaceCount).toBe(1);
    // workspaceCount must describe the list actually returned.
    expect(light.workspaceCount).toBe(light.workspaces.length);
    expect(light.note).toMatch(/1 empty domain\(s\) are hidden/);
  });

  it("emits description only when it is REAL, never a rendering of `domain`", async () => {
    const light = await run("light");
    const builder = light.workspaces.find((w) => w.id === "ws-full")!;
    expect(builder.description).toBeUndefined();
    expect(builder.domain).toBe("personal");
    // An authored purpose (here, the onboarding goal) still comes through.
    const foundation = light.workspaces.find((w) => w.id === "ws-onboard")!;
    expect(foundation.description).toBe("Capture the strategic DNA.");
  });

  it("serves the inventory when the caller ASKS for it by scope", async () => {
    const explicit = await run("light", ["workspaces", "profiles"]);
    expect(explicit.profiles?.map((p) => p.slug)).toEqual(["task", "person"]);
  });
});

describe("orient note — concept prose only on request", () => {
  // Both halves: light stays short and points at the skill; explain/full still
  // deliver the prose.
  const CONCEPT = /WRITE by kind\/profile/;

  it("light carries no concept prose and points at startHere.learnMore", async () => {
    const light = await run("light");
    expect(light.note).not.toMatch(CONCEPT);
    expect(light.note).toMatch(/startHere\.learnMore/);
    expect(light.startHere.learnMore).toEqual({ skill: "system/synap/lenses" });
  });

  it("explain:true adds the concept prose without the rest of full", async () => {
    const explained = await discover({
      caller,
      userId: "u1",
      authScopes: ["mcp.read"],
      detail: "light",
      explain: true,
    });
    expect(explained.note).toMatch(CONCEPT);
    expect(explained.profiles).toBeUndefined();
  });

  it("detail:'full' carries the concept prose too", async () => {
    expect((await run("full")).note).toMatch(CONCEPT);
  });
});

describe("detail:'full' still carries everything light drops", () => {
  it("returns the profile inventory and every workspace", async () => {
    const full = await run("full");
    expect(full.profiles?.map((p) => p.slug)).toEqual(["task", "person"]);

    const ids = full.workspaces.map((w) => w.id);
    expect(ids).toContain("ws-empty");
    expect(full.hiddenEmptyWorkspaceCount).toBeUndefined();

    // The `Domain: <x>` filler is gone from BOTH detail levels — a workspace
    // with no real description/goal gets none, not a rendering of `domain`.
    const builder = full.workspaces.find((w) => w.id === "ws-full")!;
    expect(builder.description).toBeNull();

    // Per-workspace profiles + the FULL onboarding spec (not just `goal`).
    expect(full.workspaces.every((w) => Array.isArray(w.profiles))).toBe(true);
    const foundation = full.workspaces.find((w) => w.id === "ws-onboard")!;
    expect(foundation.onboarding?.steps).toEqual(["a", "b"]);

    // …and full is not nagged with the light-mode explanation.
    expect(full.note).not.toMatch(/profile-listing tool/i);
  });
});

describe("orient `who` — the person, not the building", () => {
  it("is ABSENT when the pod holds no observations", async () => {
    const light = await run("light");
    expect(light.who).toBeUndefined();
    expect("who" in light).toBe(false);
  });

  it("carries validated and high-confidence rows, and marks inferences", async () => {
    h.observationRows = [
      {
        title: "t",
        properties: {
          uo_observation: "Prefers direct, action-first collaboration.",
          uo_category: "working_style",
          uo_confidence: 0.8,
          uo_validated: false,
        },
      },
      {
        title: "t",
        properties: {
          uo_observation: "Ships in verified waves.",
          uo_category: "habits",
          uo_confidence: 0.2,
          uo_validated: true,
        },
      },
    ];
    const light = await run("light");
    expect(light.who).toContain("[working_style] Prefers direct");
    // Unvalidated → hedged, so an agent can tell a guess from a confirmation.
    expect(light.who).toMatch(/action-first collaboration\.\s*\(inferred\)/);
    // Validated wins regardless of confidence, and carries no hedge.
    expect(light.who).toContain("[habits] Ships in verified waves.");
    expect(light.who).not.toMatch(/verified waves\.\s*\(inferred\)/);
  });

  it("drops a low-confidence, unvalidated guess", async () => {
    h.observationRows = [
      {
        title: "t",
        properties: {
          uo_observation: "Maybe likes Rust.",
          uo_confidence: 0.3,
          uo_validated: false,
        },
      },
    ];
    const light = await run("light");
    expect(light.who).toBeUndefined();
  });

  it("is served under full too — full is a superset, never a different map", async () => {
    h.observationRows = [
      {
        title: "t",
        properties: { uo_observation: "Systems thinker.", uo_validated: true },
      },
    ];
    const full = await run("full");
    expect(full.who).toContain("Systems thinker.");
  });
});

describe("orient lists every workspace TYPE — a type is a property, not a filter", () => {
  // Live 2026-09-25: `operational` (Finance, Synap Dev) and `agent` (Agent
  // Fleet) workspaces were dropped SILENTLY — not even counted as hidden.
  beforeEach(() => {
    h.workspaceRows.push(
      {
        id: "ws-ops",
        name: "Finance",
        description: null,
        settings: {},
        workspaceType: "operational",
      },
      {
        id: "ws-agent",
        name: "Agent Fleet",
        description: null,
        settings: {},
        workspaceType: "agent",
      }
    );
    h.entityCountRows = [
      { workspaceId: "ws-full", count: 901 },
      { workspaceId: "ws-ops", count: 3 },
      { workspaceId: "ws-agent", count: 2 },
    ];
  });

  it("light and full both list operational + agent workspaces", async () => {
    for (const detail of ["light", "full"] as const) {
      const ids = (await run(detail)).workspaces.map((w) => w.id);
      expect(ids).toEqual(expect.arrayContaining(["ws-ops", "ws-agent"]));
    }
  });

  it("marks the ones that cannot hold entities — same predicate the create door refuses with", async () => {
    const light = await run("light");
    const byId = new Map(light.workspaces.map((w) => [w.id, w]));
    expect(byId.get("ws-ops")?.acceptsEntities).toBe(false);
    expect(byId.get("ws-agent")?.acceptsEntities).toBe(false);
    expect(byId.get("ws-ops")?.domain).toBe("operational");
    // A domain home carries no flag (absent = accepts).
    expect(byId.get("ws-full")).not.toHaveProperty("acceptsEntities");
  });
});

describe("orient pinned to a space serves its brief", () => {
  it("light + workspaceId carries `brief`, built from the pinned row and the SAME lens listing startHere ranks", async () => {
    const pinned = await discover({
      caller,
      userId: "u1",
      authScopes: ["mcp.read"],
      detail: "light",
      workspaceId: "ws-onboard",
    });
    expect(pinned.brief).toEqual({
      workspaceId: "ws-onboard",
      name: "brief",
      more: "m",
    });
    expect(Object.keys(pinned)[0]).toBe("startHere");
    expect(h.briefCalls).toHaveLength(1);
    const call = h.briefCalls[0]!;
    expect(call.workspaceId).toBe("ws-onboard");
    expect((call.workspace as { name: string }).name).toBe("Foundation");
    // One read, shared — never a second listing for the brief.
    expect(call.ranked).toBe(h.rankedPromise);
    expect(h.startHereRanked).toBe(h.rankedPromise);
  });

  it("an unpinned orient carries no brief key at all", async () => {
    const light = await run("light");
    expect("brief" in light).toBe(false);
    expect(h.briefCalls).toHaveLength(0);
  });
});

describe("orient light — every listed space carries its purpose as ONE line", () => {
  // 13 spaces, the live pod's count (2026-09-28). Purposes come from the one
  // rule (`resolveSpacePurpose`): authored description, else onboarding goal,
  // never a `Domain: x` placeholder.
  const long = (i: number) =>
    `Space ${i} is where the ${"team keeps its working records and ".repeat(5)}decides next steps.`;
  beforeEach(() => {
    h.workspaceRows = Array.from({ length: 13 }, (_, i) => ({
      id: `ws-${i}`,
      name: `Space ${i}`,
      description:
        i % 3 === 0 ? null : i % 3 === 1 ? long(i) : "Domain: personal",
      settings: {
        workspaceSubtype: "personal",
        ...(i % 3 !== 1
          ? {
              onboarding: {
                goal: `Goal ${i}: ${"capture the domain ".repeat(12)}`,
              },
            }
          : {}),
      },
      workspaceType: "personal",
    }));
    h.entityCountRows = h.workspaceRows.map((w, i) => ({
      workspaceId: w.id,
      count: i < 10 ? 5 : 0,
    }));
  });

  it("clips each purpose to 120 chars, from the authored description or the goal", async () => {
    const light = await run("light");
    console.log(
      Buffer.byteLength(JSON.stringify(light)),
      Buffer.byteLength(JSON.stringify(light.workspaces))
    );
    expect(light.workspaces).toHaveLength(13 - 1); // ws-10 is empty with no goal
    for (const w of light.workspaces) {
      // Non-vacuity: every fixture row resolves to a purpose.
      expect(typeof w.description).toBe("string");
      expect((w.description as string).length).toBeLessThanOrEqual(120);
      expect(w.description).not.toMatch(/^Domain:/);
    }
    const authored = light.workspaces.find((w) => w.id === "ws-1")!;
    expect(authored.description).toMatch(/^Space 1 is where the team/);
    expect(authored.description).toMatch(/…$/);
    // A placeholder description falls through to the goal.
    const placeholder = light.workspaces.find((w) => w.id === "ws-2")!;
    expect(placeholder.description).toMatch(/^Goal 2: capture the domain/);
  });

  it("keeps `onboarding.goal` only where onboarding is pending (an empty space)", async () => {
    const light = await run("light");
    const byId = new Map(light.workspaces.map((w) => [w.id, w]));
    // Holds entities: the goal already rides as its purpose — not twice.
    expect(byId.get("ws-0")).not.toHaveProperty("onboarding");
    // Empty with a goal: the onboarding hint is the point.
    expect(byId.get("ws-12")?.onboarding).toEqual({
      goal: expect.stringMatching(/^Goal 12/),
    });
    // Full keeps the whole spec everywhere.
    const full = await run("full");
    expect(
      full.workspaces.find((w) => w.id === "ws-0")?.onboarding?.goal
    ).toMatch(/^Goal 0/);
  });
});
