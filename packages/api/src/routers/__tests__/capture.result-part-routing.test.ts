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
    db: { select: () => selectChain() },
    ProfileResolutionService: class {
      async getAccessibleProfiles() {
        return [{ id: "p-note", slug: "note", displayName: "Note" }];
      }
      async getEffectiveProperties() {
        return [];
      }
    },
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
    client: { structure: async () => structuredClone(h.isBody) },
  }),
}));

vi.mock("@synap/search", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchService: { searchCollection: async () => ({ results: [] }) },
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

function callerFor(userId: string) {
  return captureRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
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
