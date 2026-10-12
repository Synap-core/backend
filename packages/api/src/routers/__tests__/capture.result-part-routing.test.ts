/**
 * The AI's PROJECT + WORKSPACE picks reach the persisted `capture_result` part,
 * driven through the REAL `capture.structure` procedure and the REAL writer
 * (`persistCaptureResult` → `projectCaptureRoutingBlocks` →
 * `CaptureResultPartSchema.parse`), then read back through the REAL reader
 * (`readCapturePart`).
 *
 * THE DEFECT this pins: relay renders ONLY the persisted part, and the picks
 * lived on the structure RESPONSE only — so the phone could neither show
 * "filed in project X / space Y" nor forward the hints on accept.
 *
 * Harness: the same module-boundary stubs as `capture.project-outcome.test.ts`
 * (no Postgres, no IS), plus the session room and the message INSERT — the one
 * write the writer makes. Everything between the IS body and the inserted part
 * is production code.
 *
 * NOT covered here: the jsonb round-trip through a real Postgres (the pglite
 * suite `capture-result-part.pglite.test.ts` covers the writer against a real
 * DB) and execute's consumption of the hints (a reader's job).
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
  lifecycles: new Map<
    string,
    { propertySlug: string; options: Array<{ key: string }> }
  >(),
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
}));

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
        return h.lifecycles;
      }
    },
    getRequestGrant: () => h.grant ?? undefined,
    resolveWorkspacePlacement: async () => ({
      candidates: [],
      rung: 6,
      workspaceId: null,
      reason: "no ontology signal",
      confidence: null,
    }),
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
import { readCapturePart } from "@synap-core/types/capture";

const ENTITY = {
  tempId: "t1",
  profileSlug: "note",
  title: "Lunch with Alice",
  confidence: 0.9,
  properties: {},
};

const PROJECTS = [
  { id: randomUUID(), name: "Synap", description: "the product" },
  { id: randomUUID(), name: "Launch The Architech", description: null },
];

function callerFor(userId: string, workspaceId: string | null = null) {
  return captureRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId,
    sessionId: null,
    agentUserId: null,
  } as never);
}

const run = () => callerFor(`user-${randomUUID()}`).structure({ text: "hi" });

/** The newest persisted part, read back through the real reader. */
function persisted() {
  expect(h.written.length).toBeGreaterThan(0); // non-vacuity: it was written
  const part = readCapturePart({ capturePart: h.written.at(-1)!.part });
  expect(part?.kind).toBe("capture_result");
  return part as Extract<NonNullable<typeof part>, { kind: "capture_result" }>;
}

beforeEach(() => {
  h.written = [];
  h.isInputs = [];
  h.room = null;
  h.profileReads = [];
  h.playbookMatches = [];
  h.ruleMatches = [];
  h.matchCalls = [];
  h.searchHits = [];
  h.profiles = [{ id: "p-note", slug: "note", displayName: "Note" }];
  h.projectRows = PROJECTS;
  h.isBody = { entities: [ENTITY], relations: [], followUp: null };
});

describe("capture.structure — the persisted result part carries the AI's picks", () => {
  it("SELECTED: the project id, reason, confidence and outcome VALUES arrive", async () => {
    h.isBody = {
      ...h.isBody,
      targetProjectId: PROJECTS[0]!.id,
      targetProjectReason: "the note is about the product",
      targetProjectConfidence: 0.8,
    };
    const r = (await run()) as Record<string, unknown>;
    expect(r.captureResult).not.toBeNull();
    const part = persisted();
    expect(part.project).toEqual({
      id: PROJECTS[0]!.id,
      reason: "the note is about the product",
      confidence: 0.8,
      outcome: "selected",
    });
    // The part says the SAME thing the response says — one fact, two views.
    expect(part.project?.outcome).toBe(r.targetProjectOutcome);
  });

  it("UNSTATED: candidates sent, model mute — the outcome survives, ids stay null", async () => {
    await run();
    expect(persisted().project).toEqual({
      id: null,
      reason: null,
      confidence: null,
      outcome: "unstated",
    });
  });

  it("NOT_OFFERED is distinguishable from UNSTATED on the persisted part", async () => {
    h.projectRows = [];
    await run();
    expect(persisted().project?.outcome).toBe("not_offered");
  });

  it("PLACEMENT: the response's placement block is persisted field for field", async () => {
    const r = (await run()) as Record<string, unknown>;
    const part = persisted();
    expect(r.placement).toBeTruthy(); // non-vacuity: the response had one
    expect(part.placement).toEqual(r.placement);
  });

  it("a long AI reason is CUT to the bound, never fails the whole part", async () => {
    h.isBody = {
      ...h.isBody,
      targetProjectId: PROJECTS[1]!.id,
      targetProjectReason: "x".repeat(5000),
      targetProjectConfidence: 0.5,
    };
    const r = (await run()) as Record<string, unknown>;
    expect(r.captureResult).not.toBeNull();
    expect(persisted().project?.reason).toHaveLength(500);
  });
});

describe("projectCaptureRoutingBlocks — a placement WITH a suggestion", () => {
  it("keeps the suggestion, caps alternatives at 3, and the part parses", async () => {
    const { projectCaptureRoutingBlocks } =
      await import("../../services/intake/capture-result-part.js");
    const { CaptureResultPartSchema } =
      await import("@synap-core/types/capture");
    const alt = (n: number) => ({
      workspaceId: `ws-${n}`,
      workspaceName: `Space ${n}`,
      weight: 1 / (n + 1),
    });
    const blocks = projectCaptureRoutingBlocks({
      placement: {
        workspaceId: "ws-ambient",
        workspaceName: "Builder",
        deterministic: false,
        suggestion: {
          workspaceId: "ws-1",
          workspaceName: "Space 1",
          reason: "about the brand",
          alternatives: [alt(1), alt(2), alt(3), alt(4)],
        },
      },
    });
    expect(blocks.project).toBeUndefined(); // absent in ⇒ absent out
    expect(blocks.placement?.suggestion?.workspaceId).toBe("ws-1");
    expect(blocks.placement?.suggestion?.alternatives).toHaveLength(3);
    expect(
      CaptureResultPartSchema.safeParse({
        kind: "capture_result",
        v: 1,
        sessionId: "11111111-1111-4111-8111-111111111111",
        round: 1,
        rows: [],
        truncated: false,
        notice: null,
        ...blocks,
      }).success
    ).toBe(true);
  });
});

describe("capture.structure — a re-read takes the room's comments", () => {
  const SESSION = "55555555-5555-4555-8555-555555555555";
  const reread = () =>
    callerFor(`user-${randomUUID()}`).structure({
      text: "idea of content for synap",
      sessionId: SESSION,
    });

  it("sends every comment since the last round, and the open rows to refine", async () => {
    h.room = {
      comments: ["make it about relay", "and tag it Launch"],
      previousEntities: [
        { tempId: "t1", profileSlug: "post", title: "Synap content idea" },
      ],
    };
    await reread();
    expect(h.isInputs).toHaveLength(1);
    expect(h.isInputs[0]!.comments).toEqual([
      "make it about relay",
      "and tag it Launch",
    ]);
    expect(
      (h.isInputs[0]!.hints as { previousEntities?: unknown }).previousEntities
    ).toEqual([
      { tempId: "t1", profileSlug: "post", title: "Synap content idea" },
    ]);
  });

  it("a room with no comments sends no comments field", async () => {
    h.room = { comments: [] };
    await reread();
    expect(h.isInputs[0]).not.toHaveProperty("comments");
  });

  it("sends the records the room settled and the note it holds, comments or not", async () => {
    h.room = {
      comments: [],
      settled: [
        { profileSlug: "task", title: "Call Marie", outcome: "filed" },
        { profileSlug: "event", title: "Dentist", outcome: "rejected" },
      ],
      noteTitle: "Call Marie, dentist Tue",
    };
    await reread();
    const hints = h.isInputs[0]!.hints as {
      settledEntities?: unknown;
      sourceNote?: unknown;
    };
    expect(hints.settledEntities).toEqual([
      { profileSlug: "task", title: "Call Marie", outcome: "filed" },
      { profileSlug: "event", title: "Dentist", outcome: "rejected" },
    ]);
    expect(hints.sourceNote).toEqual({
      profileSlug: "note",
      title: "Call Marie, dentist Tue",
    });
  });

  it("the caller's own previousEntities win over the room's", async () => {
    h.room = {
      comments: ["x"],
      previousEntities: [{ tempId: "room", profileSlug: "note", title: "R" }],
    };
    await callerFor(`user-${randomUUID()}`).structure({
      text: "hi",
      sessionId: SESSION,
      previousEntities: [{ tempId: "mine", profileSlug: "note", title: "M" }],
    });
    expect(
      (
        h.isInputs[0]!.hints as { previousEntities?: Array<{ tempId: string }> }
      ).previousEntities?.map((e) => e.tempId)
    ).toEqual(["mine"]);
  });
});

describe("capture.structure — schema linking across every visible space (D1)", () => {
  it("reads kinds pod-wide and offers another space's kind, named with its space", async () => {
    h.profiles = [
      { id: "p-note", slug: "note", displayName: "Note" },
      {
        id: "p-post",
        slug: "post",
        displayName: "Post",
        workspaceId: "66666666-6666-4666-8666-666666666666",
        uiHints: { description: "A piece of content to publish" },
      },
    ];
    // Captured FROM another space (Builder): the read must still be pod-wide.
    await callerFor(
      `user-${randomUUID()}`,
      "77777777-7777-4777-8777-777777777777"
    ).structure({ text: "idea of content for synap" });
    // Workspace-less = the whole visible floor, never the starting space.
    expect(h.profileReads).toEqual([""]);
    const offered = (
      h.isInputs[0]!.hints as {
        availableProfiles: Array<{ slug: string; description?: string }>;
      }
    ).availableProfiles;
    expect(offered.map((p) => p.slug)).toContain("post");
    expect(offered.find((p) => p.slug === "post")?.description).toBe(
      "A piece of content to publish"
    );
  });

  it("every kind names where its lifecycle starts; a key granted on one space never sees another space's kinds", async () => {
    const CONTENT = "66666666-6666-4666-8666-666666666666";
    const CRM = "88888888-8888-4888-8888-888888888888";
    h.profiles = [
      { id: "p-note", slug: "note", displayName: "Note" },
      { id: "p-post", slug: "post", displayName: "Post", workspaceId: CONTENT },
      { id: "p-deal", slug: "deal", displayName: "Deal", workspaceId: CRM },
    ];
    h.lifecycles = new Map([
      [
        "p-post",
        {
          propertySlug: "status",
          options: [{ key: "idea" }, { key: "draft" }],
        },
      ],
    ]);
    h.grant = { scopes: [{ permissions: ["*"], workspaceIds: [CONTENT] }] };
    try {
      await callerFor(`user-${randomUUID()}`).structure({
        text: "idea of content for synap",
      });
    } finally {
      h.grant = null;
      h.lifecycles = new Map();
    }
    const offered = (
      h.isInputs[0]!.hints as {
        availableProfiles: Array<{
          slug: string;
          firstStatus?: { property: string; value: string };
        }>;
      }
    ).availableProfiles;
    expect(offered.map((p) => p.slug).sort()).toEqual(["note", "post"]);
    expect(offered.find((p) => p.slug === "post")?.firstStatus).toEqual({
      property: "status",
      value: "idea",
    });
  });
});

describe("capture.structure — the row carries the structurer's signals (D10)", () => {
  it("description, roles (facets), confidence and label VALUES arrive on the persisted row", async () => {
    h.isBody = {
      ...h.isBody,
      entities: [
        {
          ...ENTITY,
          description: "Lunch to plan the\n  launch",
          confidence: 0.72,
          label: "likely",
          facets: [{ profileSlug: "client" }, { profileSlug: "client" }],
        },
      ],
    };
    await run();
    const [row] = persisted().rows;
    expect(row).toMatchObject({
      description: "Lunch to plan the launch",
      roles: ["client"],
      confidence: 0.72,
      label: "likely",
    });
  });

  it("an unknown label and a missing description stay ABSENT, never defaulted", async () => {
    h.isBody = {
      ...h.isBody,
      entities: [{ ...ENTITY, label: "perhaps" }],
    };
    await run();
    const [row] = persisted().rows;
    expect(row).not.toHaveProperty("label");
    expect(row).not.toHaveProperty("description");
    expect(row).not.toHaveProperty("roles");
    expect(row!.confidence).toBe(0.9);
  });
});

describe("capture.structure — next steps ride the part before anything is filed (D6)", () => {
  const WS = "88888888-8888-4888-8888-888888888888";
  const runIn = () =>
    callerFor(`user-${randomUUID()}`, WS).structure({
      text: "lunch with alice",
    });

  it("matched playbooks and rules arrive on the part, ranked, for the row's kind in the landing space", async () => {
    h.playbookMatches = [
      {
        id: "pb-1",
        name: "Follow up",
        score: 4,
        reason: "about lunch",
        subjectProfileSlug: "note",
      },
    ];
    h.ruleMatches = [{ id: "r-1", name: "Tag notes", score: 2 }];
    await runIn();
    expect(persisted().suggestions).toEqual([
      {
        kind: "playbook",
        id: "pb-1",
        title: "Follow up",
        forTempId: "t1",
        reason: "about lunch",
      },
      { kind: "rule", id: "r-1", title: "Tag notes", forTempId: "t1" },
    ]);
    expect(h.matchCalls[0]).toEqual({
      profileSlug: "note",
      workspaceId: WS,
      intentText: "lunch with alice",
    });
  });

  it("none found is an EMPTY list; a failed match is NO list", async () => {
    await runIn();
    expect(persisted().suggestions).toEqual([]);
    h.written = [];
    h.ruleMatches = "rules down";
    await callerFor(`user-${randomUUID()}`, WS).structure({ text: "other" });
    expect(persisted()).not.toHaveProperty("suggestions");
  });
});

describe("capture.structure — the row names its top fuzzy duplicate (D9)", () => {
  const EXISTING = "99999999-9999-4999-8999-999999999999";

  it("the best dedup candidate's id, title and score arrive on the row", async () => {
    h.searchHits = [
      {
        document: {
          id: EXISTING,
          title: "Lunch with Alice!",
          entityType: "note",
        },
      },
    ];
    const r = (await run()) as {
      dedupCandidates: Record<string, Array<{ score: number }>>;
    };
    const [row] = persisted().rows;
    expect(row!.updatesExisting).toBe(true);
    // The SAME candidate the response names — one fact, two views.
    expect(row!.candidate).toEqual({
      entityId: EXISTING,
      title: "Lunch with Alice!",
      score: r.dedupCandidates.t1![0]!.score,
    });
  });

  it("no duplicate: no candidate (absent, never an empty one)", async () => {
    await run();
    expect(persisted().rows[0]).not.toHaveProperty("candidate");
  });
});
