/**
 * Live structure progress — driven through the REAL `capture.structure`
 * procedure (auth, rate limit, the progress middleware, every call-site hunk,
 * `finishIntake`) and the REAL Hono tail route.
 *
 * Stubbed at module boundaries, and why (no Postgres, no IS, no Typesense):
 *  - `resolveIntelligenceService` → a fake IS client. With `onProgress` it
 *    emits one `understanding` stage and one draft, like a streaming IS; its
 *    returned body is identical either way.
 *  - `getDb` (two empty reads: workspaces, projects), `ProfileResolutionService`,
 *    `resolveWorkspacePlacement` (rung 6, no move), `assembleStructureContext`.
 *  - `recordStructureIntake` → records its call and echoes a constant session:
 *    it IS the "intake recorded" seam (its own behaviour: `intake-run.pglite`).
 *  - search, routing memory, relation types, embeddings (null), read-only guard.
 *  - `@synap/auth` `authMiddleware` → reads the user from a test header.
 *
 * NOT covered: the IS streaming itself (IS/client lanes), a real session row,
 * multi-process delivery (the bus is in-process by design).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { StructureProgressEvent } from "@synap-core/types/capture";

const h = vi.hoisted(() => ({
  mode: "plan" as "plan" | "throw" | "null",
  gate: null as Promise<void> | null,
  isCalls: [] as Array<{ hasProgress: boolean }>,
  intakes: [] as unknown[],
}));

const IS_BODY = {
  entities: [
    {
      tempId: "t1",
      profileSlug: "note",
      title: "Lunch with Alice",
      confidence: 0.9,
      properties: {},
    },
  ],
  relations: [],
  followUp: null,
};

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
  const emptyChain = (): unknown =>
    new Proxy(() => {}, {
      get: (_t, prop) =>
        prop === "then"
          ? (resolve: (rows: unknown[]) => void) => resolve([])
          : () => emptyChain(),
    });
  return {
    ...actual,
    getDb: async () => ({ select: () => emptyChain() }),
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
    client: {
      structure: async (
        _input: unknown,
        options?: { onProgress?: (e: StructureProgressEvent) => void }
      ) => {
        h.isCalls.push({ hasProgress: Boolean(options?.onProgress) });
        if (h.gate) await h.gate;
        if (h.mode === "throw") throw new Error("IS exploded before dedup");
        if (h.mode === "null") return null;
        options?.onProgress?.({
          v: 1,
          seq: 1,
          kind: "stage",
          stage: "understanding",
          attempt: 1,
          at: new Date().toISOString(),
        });
        options?.onProgress?.({
          v: 1,
          seq: 2,
          kind: "draft",
          attempt: 1,
          rev: 0,
          entities: [{ title: "Lunch with Alice", profileSlug: "note" }],
        });
        return structuredClone(IS_BODY);
      },
    },
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
    recordStructureIntake: async (args: unknown) => {
      h.intakes.push(args);
      return {
        sessionId: "33333333-3333-4333-8333-333333333333",
        intake: { requestedSessionIgnored: false },
      };
    },
  })
);

import { captureRouter } from "../capture.js";
import { captureProgressStreamApp } from "../capture-progress-stream.js";
import { subscribeStructureProgress } from "../../utils/structure-progress-bus.js";

function callerFor(userId: string) {
  return captureRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
    sessionId: null,
    agentUserId: null,
  } as never);
}

/** Every frame the bus holds for (user, run), oldest first. */
function framesOf(userId: string, runId: string): StructureProgressEvent[] {
  const sub = subscribeStructureProgress(userId, runId, 0, () => {});
  sub.unsubscribe();
  return sub.replay;
}

const label = (f: StructureProgressEvent) =>
  f.kind === "stage"
    ? f.stage
    : f.kind === "done"
      ? `done:${f.outcome}`
      : "draft";

beforeEach(() => {
  h.mode = "plan";
  h.gate = null;
  h.isCalls.length = 0;
  h.intakes.length = 0;
});

describe("capture.structure with a progress run", () => {
  it("PARITY: the response with a captureRunId deep-equals the response without one", async () => {
    const user = `user-${randomUUID()}`;
    const runId = randomUUID();
    const caller = callerFor(user);

    const without = await caller.structure({ text: "Lunch with Alice" });
    const withRun = await caller.structure({
      text: "Lunch with Alice",
      captureRunId: runId,
    });

    expect(withRun).toEqual(without);
    // Non-vacuity: the run really reported, and only the run asked the IS to stream.
    expect(h.isCalls.map((c) => c.hasProgress)).toEqual([false, true]);
    expect(framesOf(user, runId).map(label)).toEqual([
      "reading",
      "understanding",
      "draft",
      "placing",
      "matching",
      "done:plan",
    ]);
  });

  it("PRIVACY: user B subscribed to A's run id receives nothing", async () => {
    const a = `user-a-${randomUUID()}`;
    const b = `user-b-${randomUUID()}`;
    const runId = randomUUID();
    const seenByB: StructureProgressEvent[] = [];
    const seenByA: StructureProgressEvent[] = [];
    const subB = subscribeStructureProgress(b, runId, 0, (f) =>
      seenByB.push(f)
    );
    const subA = subscribeStructureProgress(a, runId, 0, (f) =>
      seenByA.push(f)
    );

    await callerFor(a).structure({
      text: "Lunch with Alice",
      captureRunId: runId,
    });

    expect(seenByA.map(label)).toContain("done:plan");
    expect(seenByB).toEqual([]);
    expect(framesOf(b, runId)).toEqual([]);
    subA.unsubscribe();
    subB.unsubscribe();
  });

  it("DISCONNECT: closing the tail mid-run detaches the reader; the mutation completes and records its intake", async () => {
    const user = `user-${randomUUID()}`;
    const runId = randomUUID();
    let release!: () => void;
    h.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const res = await captureProgressStreamApp.request(
      `/runs/${runId}/progress`,
      { headers: { "x-test-user": user } }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();

    const run = callerFor(user).structure({
      text: "Lunch with Alice",
      captureRunId: runId,
    });
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(
      /^id: 1\ndata: \{"v":1,"seq":1,"kind":"stage","stage":"reading"/
    );
    await reader.cancel(); // the client goes away while the IS is still working

    release();
    const result = await run;
    expect(result.proposals).toHaveLength(1);
    expect(h.intakes).toHaveLength(1);

    // A reconnect after the run replays what it missed and closes on done.
    const again = await captureProgressStreamApp.request(
      `/runs/${runId}/progress?after=1`,
      { headers: { "x-test-user": user } }
    );
    const text = await again.text();
    expect(text).not.toContain('"seq":1,');
    expect(text).toContain('"kind":"done","outcome":"plan"');
  });

  it("NO FAKE STAGE: an IS that throws before dedup leaves no matching (or placing) frame, and closes degraded", async () => {
    const user = `user-${randomUUID()}`;
    const runId = randomUUID();
    h.mode = "throw";
    await expect(
      callerFor(user).structure({
        text: "Lunch with Alice",
        captureRunId: runId,
      })
    ).rejects.toThrow();
    const labels = framesOf(user, runId).map(label);
    expect(labels).toEqual(["reading", "done:degraded"]);
    expect(labels).not.toContain("matching");
  });

  it("NO FAKE STAGE: an IS that degrades (null) exits before placing and matching", async () => {
    const user = `user-${randomUUID()}`;
    const runId = randomUUID();
    h.mode = "null";
    const result = await callerFor(user).structure({
      text: "Lunch with Alice",
      captureRunId: runId,
    });
    expect((result as { degraded?: unknown }).degraded).toBe(true);
    expect(h.intakes).toHaveLength(1);
    const labels = framesOf(user, runId).map(label);
    expect(labels).toEqual(["reading", "done:degraded"]);
  });
});
