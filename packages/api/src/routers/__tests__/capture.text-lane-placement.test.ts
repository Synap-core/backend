/**
 * The `capture.structure` TEXT lane places PER ENTITY (D14), through the same
 * door as the graph lane (`resolveGraphWorkspaceFromSlugs`, a0813ed4).
 *
 * THE DEFECT this pins: the text lane routed on the FIRST entity's kind and
 * passed every other entity's kind (and every role) as a facet of it — 6
 * decisions + 1 document filed wherever the first kind lived.
 *
 * Driven through the REAL `capture.structure` procedure with the same
 * module-boundary stubs as `capture.result-part-routing.test.ts`; the door
 * itself is stubbed at the `@synap/database` boundary (its per-entity vote is
 * covered by `workspace-resolution-service.test.ts`). The single-entity door
 * answers a first-kind workspace, so a regression back to it is visible.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  projectRows: [] as Array<{
    id: string;
    name: string;
    description: string | null;
  }>,
  isBody: {} as Record<string, unknown>,
  /** What `capture.structure` sent the IS, per call. */
  isInputs: [] as Array<Record<string, unknown>>,
  /** What the room reader answers for a re-read of a capture session. */
  room: null as unknown,
  /** The profiles the person can see, and the workspace each read asked for. */
  profiles: [] as Array<Record<string, unknown>>,
  profileReads: [] as string[],
  /** Lifecycles by profile id, as `getEffectiveLifecycles` answers. */
  lifecycles: new Map() as
    | Map<string, { propertySlug: string; options: Array<{ key: string }> }>
    | "throws",
  /** The request's key grant (`getRequestGrant`); null = a session caller. */
  grant: null as null | {
    scopes: Array<{ permissions: string[]; workspaceIds?: string[] | null }>;
  },
  /** What the two next-step match doors answer (D6); a string = it throws. */
  playbookMatches: [] as unknown[] | string,
  ruleMatches: [] as unknown[] | string,
  matchCalls: [] as Array<Record<string, unknown>>,
  /** Title-dedup search hits (Typesense documents). */
  searchHits: [] as Array<{ document: Record<string, unknown> }>,
  /** What the ONE writer handed to the message insert — the persisted part. */
  written: [] as Array<{ id: string; part: unknown }>,
  /** What the text lane asked the per-entity placement door, per call. */
  graphCalls: [] as Array<Record<string, unknown>>,
  graphPlacement: {} as Record<string, unknown>,
  /** Calls to the single-entity door (the old first-kind routing). */
  firstKindCalls: [] as Array<Record<string, unknown>>,
  tiebreaks: [] as Array<Record<string, unknown>>,
}));

const FIRST_KIND_WS = "99999999-9999-4999-8999-999999999999";

vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authMiddleware: async (
    c: {
      req: { header: (k: string) => string | undefined };
      set: (k: string, v: unknown) => void;
    },
    next: () => Promise<void>
  ) => {
    c.set("userId", c.req.header("x-test-user"));
    await next();
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const rowsChain = (rows: () => unknown[]): unknown =>
    new Proxy(() => {}, {
      get: (_t, prop) =>
        prop === "then"
          ? (resolve: (r: unknown[]) => void) => resolve(rows())
          : () => rowsChain(rows),
    });
  const selectChain = (): unknown =>
    new Proxy(() => {}, {
      get: (_t, prop) => {
        if (prop === "then")
          return (resolve: (r: unknown[]) => void) => resolve([]);
        if (prop === "from")
          return (table: unknown) =>
            table === actual.projects
              ? rowsChain(() => h.projectRows)
              : selectChain();
        return () => selectChain();
      },
    });
  return {
    ...actual,
    getDb: async () => ({ select: () => selectChain() }),
    // The result writer's own reads (previous part, asked-round count) see an
    // empty room: no Postgres here.
    db: {
      select: () => selectChain(),
      // The workspace gate a capture FROM a space passes (pod member).
      query: {
        workspaceMembers: { findFirst: async () => ({ role: "owner" }) },
        workspaces: { findFirst: async () => ({ archivedAt: null }) },
      },
    },
    ProfileResolutionService: class {
      async getAccessibleProfiles(_userId: string, workspaceId: string) {
        h.profileReads.push(workspaceId);
        return h.profiles;
      }
      async getEffectiveProperties() {
        return [];
      }
      async getEffectiveLifecycles() {
        if (h.lifecycles === "throws") throw new Error("lifecycle read failed");
        return h.lifecycles;
      }
    },
    getRequestGrant: () => h.grant ?? undefined,
    resolveGraphWorkspaceFromSlugs: async (
      _db: unknown,
      input: Record<string, unknown>
    ) => {
      h.graphCalls.push(structuredClone(input));
      return structuredClone(h.graphPlacement);
    },
    resolveWorkspacePlacement: async (
      _db: unknown,
      input: Record<string, unknown>
    ) => {
      h.firstKindCalls.push(structuredClone(input));
      return {
        candidates: [],
        rung: 2,
        workspaceId: FIRST_KIND_WS,
        reason: "first kind's workspace",
        confidence: 1,
      };
    },
    assembleStructureContext: async () => ({
      instructions: undefined,
      guidelines: [],
      guidelineStatus: "ok",
    }),
  };
});

vi.mock("../../utils/intelligence-routing.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntelligenceService: async () => ({
    client: {
      structure: async (input: Record<string, unknown>) => {
        h.isInputs.push(structuredClone(input));
        return structuredClone(h.isBody);
      },
      workspaceTiebreak: async (input: Record<string, unknown>) => {
        h.tiebreaks.push(structuredClone(input));
        return { workspaceId: null, abstained: true };
      },
    },
  }),
}));

vi.mock("@synap/search", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchService: {
    searchCollection: async () => ({ results: structuredClone(h.searchHits) }),
  },
}));
vi.mock("../../services/routing-memory.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchRoutingMemory: async () => undefined,
}));
vi.mock("../../utils/relation-types.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listEffectiveRelationTypes: async () => [],
}));
vi.mock(
  "../../services/retrieval/hybrid-recall.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    embedQuery: async () => ({ embedding: null }),
  })
);
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));
vi.mock(
  "../../services/intake/record-structure-intake.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    recordStructureIntake: async () => ({
      sessionId: "33333333-3333-4333-8333-333333333333",
      intake: { requestedSessionIgnored: false },
    }),
  })
);

vi.mock(
  "../../services/focus-sessions/ensure-session-channel.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    ensureSessionChannel: async () => "44444444-4444-4444-8444-444444444444",
  })
);
// The seam AFTER the part is built and schema-parsed by the real writer: only
// the INSERT is replaced, so the part asserted on is exactly what is stored.
vi.mock(
  "../../services/intake/record-capture-part-message.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    recordCapturePartMessage: async (input: { id: string; part: unknown }) => {
      h.written.push({ id: input.id, part: structuredClone(input.part) });
      return { id: input.id, inserted: true };
    },
  })
);

vi.mock("../../services/intake/capture-room.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRestructureRoom: async () => h.room,
}));

const matchDoor = (pick: () => unknown[] | string) => ({
  createCaller: () => ({
    matchForEntity: async (input: Record<string, unknown>) => {
      h.matchCalls.push(input);
      const out = pick();
      if (typeof out === "string") throw new Error(out);
      return out;
    },
  }),
});
vi.mock("../playbooks.js", () => ({
  playbooksRouter: matchDoor(() => h.playbookMatches),
}));
vi.mock("../automations.js", () => ({
  automationsRouter: matchDoor(() => h.ruleMatches),
}));

import { captureRouter } from "../capture.js";

const ENTITIES = [
  {
    tempId: "t1",
    profileSlug: "decision",
    title: "Ship the lens page first",
    confidence: 0.9,
    properties: {},
  },
  {
    tempId: "t2",
    profileSlug: "person",
    title: "Alice Martin",
    confidence: 0.9,
    properties: {},
    facets: [{ profileSlug: "client", properties: {} }],
  },
  {
    tempId: "t3",
    profileSlug: "document",
    title: "Lens page brief",
    confidence: 0.9,
    properties: {},
  },
];

const PLACED_WS = "77777777-7777-4777-8777-777777777777";
const OTHER_WS = "88888888-8888-4888-8888-888888888888";

const run = (workspaceId: string | null = null) =>
  captureRouter
    .createCaller({
      authenticated: true,
      userId: `user-${randomUUID()}`,
      workspaceId,
      sessionId: null,
      agentUserId: null,
    } as never)
    .structure({ text: "Decided to ship the lens page first; Alice agreed." });

beforeEach(() => {
  h.written = [];
  h.isInputs = [];
  h.room = null;
  h.profileReads = [];
  h.playbookMatches = [];
  h.ruleMatches = [];
  h.matchCalls = [];
  h.searchHits = [];
  h.graphCalls = [];
  h.firstKindCalls = [];
  h.tiebreaks = [];
  h.profiles = [{ id: "p-note", slug: "note", displayName: "Note" }];
  h.projectRows = [];
  h.isBody = { entities: ENTITIES, relations: [], followUp: null };
  h.graphPlacement = {
    workspaceId: PLACED_WS,
    rung: 2,
    reason: "every placed entity agrees",
    confidence: 1,
    candidates: [],
    ask: false,
  };
});

describe("capture.structure text lane — placement is per entity", () => {
  it("asks the door once with one entry per entity, its own kind and roles", async () => {
    await run("11111111-1111-4111-8111-111111111111");
    expect(h.graphCalls).toHaveLength(1);
    expect(h.graphCalls[0]).toMatchObject({
      entities: [
        { kindSlug: "decision", facetSlugs: [] },
        { kindSlug: "person", facetSlugs: ["client"] },
        { kindSlug: "document", facetSlugs: [] },
      ],
      ambientWorkspaceId: "11111111-1111-4111-8111-111111111111",
    });
    // Never the first-kind routing (kind = entities[0], rest as facets).
    expect(h.firstKindCalls).toEqual([]);
  });

  it("a unanimous per-entity placement is the capture's target", async () => {
    const r = (await run()) as Record<string, unknown>;
    expect(r.targetWorkspaceId).toBe(PLACED_WS);
    expect(r.targetWorkspaceReason).toBe("every placed entity agrees");
  });

  it("a split tie-breaks over the candidates the entities named", async () => {
    h.graphPlacement = {
      workspaceId: null,
      rung: 6,
      reason: "entities disagree",
      confidence: 1,
      candidates: [
        { id: PLACED_WS, name: "Builder" },
        { id: OTHER_WS, name: "Brand" },
      ],
      ask: false,
    };
    const r = (await run()) as Record<string, unknown>;
    expect(h.tiebreaks).toHaveLength(1);
    expect(h.tiebreaks[0]!.candidates).toEqual([
      { id: PLACED_WS, name: "Builder" },
      { id: OTHER_WS, name: "Brand" },
    ]);
    expect(r.targetWorkspaceId).not.toBe(FIRST_KIND_WS);
  });
});
