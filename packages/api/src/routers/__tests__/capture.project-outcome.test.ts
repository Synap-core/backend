/**
 * The PROJECT AXIS reports a state, driven through the REAL `capture.structure`
 * procedure — both of its plan exits.
 *
 * THE DEFECT this pins: `targetProjectId`/`Reason`/`Confidence` are the
 * structurer's raw output with no deterministic pod-side backfill, so three
 * different facts collapsed onto the wire and two of them were BYTE-IDENTICAL:
 *
 *   not_offered — no project candidates existed  → id/reason/confidence null
 *   unstated    — 4 candidates sent, model mute  → id/reason/confidence null  ← same bytes
 *   declined    — candidates sent, model said why→ reason: "<sentence>"
 *
 * `not_offered` vs `unstated` is therefore the DISCRIMINATING pair: a fixture
 * that only proves `declined` works would be decoration, because `declined`
 * was already legible before the fix.
 *
 * Driven end to end from the projects DB read + the IS body through the real
 * `deriveCaptureProjectOutcome` call site to the real response object — nothing
 * hand-built downstream of the line under test. Deleting either call site, or
 * feeding it the wrong argument, fails here.
 *
 * Stubbed at module boundaries (no Postgres, no IS), mirroring
 * `capture.structure-progress.test.ts`; the one addition is a `select()` chain
 * that discriminates on `.from(projects)` so the candidate set is controllable.
 *
 * NOT covered: `capture.execute` (the outcome is a structure-time honesty
 * discriminator and is not threaded into execute's placement ladder), and the
 * degraded exits (they carry `degraded`/`degradedReason` and no project block).
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

import { captureRouter } from "../capture.js";

const ENTITY = {
  tempId: "t1",
  profileSlug: "note",
  title: "Lunch with Alice",
  confidence: 0.9,
  properties: {},
};

/** Four real-looking candidates — what the pod sends when projects exist. */
const FOUR_PROJECTS = [
  { id: randomUUID(), name: "Synap", description: "the product" },
  { id: randomUUID(), name: "Launch The Architech", description: null },
  { id: randomUUID(), name: "Dogfood plan review", description: null },
  { id: randomUUID(), name: "Ethical Fashion", description: null },
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

beforeEach(() => {
  h.projectRows = [];
  h.isBody = { entities: [ENTITY], relations: [], followUp: null };
});

describe("capture.structure — the project axis reports WHAT HAPPENED", () => {
  it("NOT_OFFERED: zero candidates ⇒ a null pick carries no judgement", async () => {
    h.projectRows = [];
    const r = (await run()) as Record<string, unknown>;
    expect(r.targetProjectId).toBeNull();
    expect(r.targetProjectReason).toBeNull();
    expect(r.targetProjectOutcome).toBe("not_offered");
  });

  it("UNSTATED: four candidates sent and the model said NOTHING — the byte-identical twin of not_offered", async () => {
    h.projectRows = FOUR_PROJECTS;
    const r = (await run()) as Record<string, unknown>;
    // Every legacy field is identical to the not_offered row above …
    expect(r.targetProjectId).toBeNull();
    expect(r.targetProjectReason).toBeNull();
    expect(r.targetProjectConfidence).toBeNull();
    // … and only the outcome separates them.
    expect(r.targetProjectOutcome).toBe("unstated");
  });

  it("DISCRIMINATION: the two null rows differ ONLY in the outcome", async () => {
    h.projectRows = [];
    const notOffered = (await run()) as Record<string, unknown>;
    h.projectRows = FOUR_PROJECTS;
    const unstated = (await run()) as Record<string, unknown>;

    const projectFields = (r: Record<string, unknown>) => ({
      id: r.targetProjectId,
      reason: r.targetProjectReason,
      confidence: r.targetProjectConfidence,
    });
    expect(projectFields(notOffered)).toEqual(projectFields(unstated));
    expect(notOffered.targetProjectOutcome).not.toBe(
      unstated.targetProjectOutcome
    );
    expect([
      notOffered.targetProjectOutcome,
      unstated.targetProjectOutcome,
    ]).toEqual(["not_offered", "unstated"]);
  });

  it("DECLINED: candidates sent, the model judged and said why", async () => {
    h.projectRows = FOUR_PROJECTS;
    h.isBody = {
      entities: [ENTITY],
      relations: [],
      followUp: null,
      targetProjectId: null,
      targetProjectReason: "a personal lunch belongs to no initiative",
      targetProjectConfidence: 0.9,
    };
    const r = (await run()) as Record<string, unknown>;
    expect(r.targetProjectOutcome).toBe("declined");
    expect(r.targetProjectReason).toBe(
      "a personal lunch belongs to no initiative"
    );
  });

  it("SELECTED: the model picked one — never reported as 'declined'", async () => {
    h.projectRows = FOUR_PROJECTS;
    h.isBody = {
      entities: [ENTITY],
      relations: [],
      followUp: null,
      targetProjectId: FOUR_PROJECTS[0]!.id,
      targetProjectReason: "the note is about the product",
      targetProjectConfidence: 0.8,
    };
    const r = (await run()) as Record<string, unknown>;
    expect(r.targetProjectId).toBe(FOUR_PROJECTS[0]!.id);
    expect(r.targetProjectOutcome).toBe("selected");
  });

  it("THE OTHER EXIT: the follow-up (question) response carries the outcome too", async () => {
    h.projectRows = FOUR_PROJECTS;
    h.isBody = {
      entities: [ENTITY],
      relations: [],
      followUp: "Which Alice?",
    };
    const r = (await run()) as Record<string, unknown>;
    // Non-vacuity: this really is the follow-up exit, not the plan exit.
    expect(r.followUp).toBe("Which Alice?");
    expect(r).toHaveProperty("followUpMessageId");
    expect(r.targetProjectOutcome).toBe("unstated");

    h.projectRows = [];
    const none = (await run()) as Record<string, unknown>;
    expect(none.followUp).toBe("Which Alice?");
    expect(none.targetProjectOutcome).toBe("not_offered");
  });
});
