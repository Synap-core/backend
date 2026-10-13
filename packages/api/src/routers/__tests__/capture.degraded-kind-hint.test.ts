/**
 * A caller's explicit kind survives the degraded fallback (ticket fb83317d).
 *
 * Driven through the REAL `capture.structure` procedure with the IS returning
 * null (the "IS reachable, no usable structure" outage). Before: the fallback
 * always filed a `note`, dropping the caller's `profileSlug`. Now it files that
 * kind — still `degraded`, confidence 0.3 — when it is a kind this capture may
 * file into; a role, a reserved slug, or an unknown slug still falls to a note.
 *
 * Stubbed at module boundaries (same harness as
 * `capture.structure-progress.test.ts`): IS client, `getDb` (empty reads),
 * `ProfileResolutionService`, placement, context assembly, search, routing
 * memory, relation types, embeddings, read-only guard, intake recording.
 */
import { describe, it, expect, vi } from "vitest";

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
        return [
          {
            id: "p-note",
            slug: "note",
            displayName: "Note",
            profileKind: "kind",
          },
          {
            id: "p-task",
            slug: "task",
            displayName: "Task",
            profileKind: "kind",
          },
          // A stale `project` profile row: listed, but reserved — never a kind.
          {
            id: "p-project",
            slug: "project",
            displayName: "Project",
            profileKind: "kind",
          },
          {
            id: "p-lead",
            slug: "crm-lead",
            displayName: "Lead",
            profileKind: "role",
          },
        ];
      }
      async getEffectiveLifecycles() {
        return new Map();
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
    client: { structure: async () => null },
  }),
}));
vi.mock("../../utils/is-structure-retry.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // One attempt: the retry policy is not under test, and its backoff is slow.
  callStructureWithRetry: async (call: () => Promise<unknown>) => ({
    result: await call(),
    attempts: 1,
    lastReason: undefined,
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

const caller = captureRouter.createCaller({
  authenticated: true,
  userId: "u-degraded-kind",
  workspaceId: null,
  sessionId: null,
  agentUserId: null,
} as never);

async function fallbackFor(profileSlug?: string) {
  const out = (await caller.structure({
    text: "Call the accountant about the Q3 filing",
    ...(profileSlug ? { profileSlug } : {}),
  })) as {
    degraded?: boolean;
    proposals: Array<{ profileSlug: string; confidence: number }>;
  };
  expect(out.degraded).toBe(true);
  expect(out.proposals).toHaveLength(1);
  return out.proposals[0]!;
}

describe("capture.structure degraded fallback honours the caller's kind", () => {
  it("files the caller's kind, still low-confidence", async () => {
    const p = await fallbackFor("task");
    expect(p.profileSlug).toBe("task");
    expect(p.confidence).toBe(0.3);
  });

  it("no hint ⇒ note", async () => {
    expect((await fallbackFor()).profileSlug).toBe("note");
  });

  it("a role, a reserved slug, or an unknown slug ⇒ note", async () => {
    expect((await fallbackFor("crm-lead")).profileSlug).toBe("note");
    expect((await fallbackFor("project")).profileSlug).toBe("note");
    expect((await fallbackFor("ghost")).profileSlug).toBe("note");
  });
});
