/**
 * Every degraded early return of `capture.structure` says WHY (issue 1c252b3b).
 *
 * Driven through the REAL procedure and the REAL retry policy, with the IS
 * client's `structure()` scripted per case: a cause reported through
 * `onFailure`, an auth throw, an empty answer. `degradedReason` keeps its old
 * value on every branch (clients branch on it); `degradedDetail` carries the
 * cause, the status, the attempts made and the failure class.
 *
 * Harness: the same module-boundary stubs as
 * `capture.degraded-kind-hint.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StructureFailure } from "@synap/intelligence-client";

const h = vi.hoisted(() => ({
  structure: vi.fn(),
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
    client: { structure: h.structure },
  }),
}));
// The REAL retry policy, with no backoff wait: the attempt count is asserted.
vi.mock("../../utils/is-structure-retry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/is-structure-retry.js")>();
  return {
    ...actual,
    callStructureWithRetry: (
      call: Parameters<typeof actual.callStructureWithRetry>[0],
      options: Parameters<typeof actual.callStructureWithRetry>[1]
    ) =>
      actual.callStructureWithRetry(call, {
        ...options,
        sleep: async () => {},
      }),
  };
});
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
import { IntelligenceAuthError } from "../../utils/intelligence-routing.js";

const caller = captureRouter.createCaller({
  authenticated: true,
  userId: "u-degraded-detail",
  workspaceId: null,
  sessionId: null,
  agentUserId: null,
} as never);

/** Every call to `structure()` fails with `failure`. */
function failWith(failure: StructureFailure) {
  h.structure.mockImplementation(
    async (
      _input: unknown,
      options?: { onFailure?: (f: StructureFailure) => void }
    ) => {
      // Every call from capture.structure passes its options: a call without
      // them is not the capture's, and says where it came from.
      if (!options) throw new Error("structure() called without options");
      options.onFailure?.(failure);
      return null;
    }
  );
}

async function structure() {
  return (await caller.structure({
    text: "Met Lea Martin about the renewal",
  })) as {
    degraded?: boolean;
    degradedReason?: string;
    degradedDetail?: Record<string, unknown>;
  };
}

beforeEach(() => h.structure.mockReset());

describe("capture.structure: the degraded early returns carry degradedDetail", () => {
  it("a 402 is not retried and reads as quota", async () => {
    failWith({ cause: "http", status: 402 });
    const out = await structure();
    expect(h.structure).toHaveBeenCalledTimes(1);
    expect(out.degradedReason).toBe("is_invalid_response");
    expect(out.degradedDetail).toEqual({
      cause: "http",
      status: 402,
      attempts: 1,
      failureClass: "quota",
    });
  });

  it("the IS envelope outranks the bare status", async () => {
    failWith({
      cause: "http",
      status: 503,
      failure: { code: "llm_budget_exceeded", retryable: false },
    });
    const out = await structure();
    expect(h.structure).toHaveBeenCalledTimes(1);
    expect(out.degradedDetail).toEqual({
      cause: "http",
      status: 503,
      attempts: 1,
      failureClass: "budget",
    });
  });

  it("a 400 is not retried and reads as bad_request", async () => {
    failWith({ cause: "http", status: 400 });
    const out = await structure();
    expect(h.structure).toHaveBeenCalledTimes(1);
    expect(out.degradedDetail).toEqual({
      cause: "http",
      status: 400,
      attempts: 1,
      failureClass: "bad_request",
    });
  });

  it("a cut stream is retried, and the attempts are counted", async () => {
    failWith({ cause: "stream" });
    const out = await structure();
    expect(h.structure).toHaveBeenCalledTimes(3);
    expect(out.degradedReason).toBe("is_invalid_response");
    expect(out.degradedDetail).toEqual({
      cause: "stream",
      attempts: 3,
      failureClass: "unknown",
    });
  });

  it("no answer at all reads as upstream, from the transport's own words", async () => {
    failWith({ cause: "network", message: "fetch failed" });
    expect((await structure()).degradedDetail).toEqual({
      cause: "network",
      attempts: 3,
      failureClass: "upstream",
    });
  });

  it("a null with no reported cause says unknown, never a guess", async () => {
    h.structure.mockResolvedValue(null);
    expect((await structure()).degradedDetail).toEqual({
      cause: "unknown",
      attempts: 3,
      failureClass: "unknown",
    });
  });

  it("an auth refusal: is_auth_error, cause http with its status, class auth", async () => {
    h.structure.mockRejectedValue(new IntelligenceAuthError(401));
    const out = await structure();
    expect(out.degradedReason).toBe("is_auth_error");
    expect(out.degradedDetail).toEqual({
      cause: "http",
      status: 401,
      attempts: 1,
      failureClass: "auth",
    });
  });

  it("an empty answer: is_empty_result, cause empty, class invalid_response", async () => {
    h.structure.mockResolvedValue({
      entities: [],
      relations: [],
      followUp: null,
    });
    const out = await structure();
    expect(out.degradedReason).toBe("is_empty_result");
    expect(out.degradedDetail).toEqual({
      cause: "empty",
      attempts: 1,
      failureClass: "invalid_response",
    });
  });

  it("an empty answer the IS called a spent budget reads as budget", async () => {
    h.structure.mockResolvedValue({
      entities: [],
      relations: [],
      followUp: null,
      degradedReason: "llm_budget_exceeded",
    });
    const out = await structure();
    expect(out.degradedReason).toBe("llm_budget_exceeded");
    expect(out.degradedDetail).toMatchObject({
      cause: "empty",
      failureClass: "budget",
    });
  });
});
