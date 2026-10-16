/**
 * "Capture reads for real": capturing an article URL hands the
 * page's TEXT to the structurer, through the one url-reader door.
 *
 * Driven through the REAL `capture.structure` procedure → the real `readUrl`
 * (real `listCapabilities` over an empty registry, real catalog-cache read) →
 * the real built-in ladder (`readBuiltin` → article extraction). Only the
 * network (`safePublicFetch`) answers from a fixture, and the IS client records
 * the input it is handed. Before, the read was only echoed back to the client
 * as `reader`; the structurer saw the bare URL.
 *
 * Stubbed at module boundaries otherwise (same harness as
 * `capture.degraded-kind-hint.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const structureCalls: Array<Record<string, unknown>> = [];

vi.mock("@synap/shared-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/shared-utils")>();
  return { ...actual, safePublicFetch: vi.fn() };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const emptyChain = (): unknown =>
    new Proxy(() => {}, {
      get: (_t, prop) =>
        prop === "then"
          ? (resolve: (rows: unknown[]) => void) => resolve([])
          : () => emptyChain(),
    });
  const db = { select: () => emptyChain(), selectDistinct: () => emptyChain() };
  return {
    ...actual,
    db,
    getDb: async () => db,
    ProfileResolutionService: class {
      async getAccessibleProfiles() {
        return [
          {
            id: "p-note",
            slug: "note",
            displayName: "Note",
            profileKind: "kind",
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

vi.mock("@synap/intelligence-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The registry's IS-native manifest degrades to [] without an IS.
  getDefaultActiveService: async () => {
    throw new Error("no IS in test");
  },
}));

vi.mock("../../utils/intelligence-routing.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntelligenceService: async () => ({
    client: {
      structure: async (input: Record<string, unknown>) => {
        structureCalls.push(input);
        return null;
      },
    },
  }),
}));
vi.mock("../../utils/is-structure-retry.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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

import { safePublicFetch } from "@synap/shared-utils";
import { captureRouter } from "../capture.js";
import { invalidateUrlReaderCache } from "../../services/capabilities/url-readers.js";
import {
  ARTICLE_HTML,
  respond,
} from "../../services/capabilities/web-read/__tests__/fixtures.js";

const ARTICLE = "https://example.com/blog/monolith";
const publicFetch = vi.mocked(safePublicFetch);

const caller = captureRouter.createCaller({
  authenticated: true,
  userId: "u-link-read",
  workspaceId: null,
  sessionId: null,
  agentUserId: null,
} as never);

beforeEach(() => {
  structureCalls.length = 0;
  publicFetch.mockReset();
  invalidateUrlReaderCache();
});

describe("capture.structure feeds a captured link's page to the structurer", () => {
  it("the article's body text reaches the structurer as quoted page content", async () => {
    publicFetch.mockResolvedValue(
      respond(ARTICLE_HTML, { contentType: "text/html; charset=utf-8" })
    );
    const out = (await caller.structure({ text: ARTICLE })) as {
      reader?: { status: string; title?: string };
    };

    // The page was fetched through the SSRF door (reachability, not shape).
    expect(publicFetch).toHaveBeenCalled();
    expect(publicFetch.mock.calls[0]![0]).toBe(ARTICLE);

    expect(structureCalls).toHaveLength(1);
    const context = String(structureCalls[0]!.context ?? "");
    expect(context, "the structurer never saw the page").toContain(
      "Paragraph 12 of the real article body"
    );
    expect(context).toContain("Title: Migrating to a monolith");
    expect(context).toContain("QUOTED PAGE CONTENT");
    // The input text itself is untouched: the AI capture door's contract.
    expect(structureCalls[0]!.text).toBe(ARTICLE);

    // The client echo is still there.
    expect(out.reader?.status).toBe("enriched");
    expect(out.reader?.title).toBe("Migrating to a monolith");
  });

  it("a caller's own context is kept alongside the page", async () => {
    publicFetch.mockResolvedValue(
      respond(ARTICLE_HTML, { contentType: "text/html; charset=utf-8" })
    );
    await caller.structure({ text: ARTICLE, context: "from my reading list" });
    const context = String(structureCalls[0]!.context ?? "");
    expect(context.startsWith("from my reading list")).toBe(true);
    expect(context).toContain("Paragraph 1 of the real article body");
  });

  it("plain text is not read and the structurer context is unchanged", async () => {
    await caller.structure({ text: "Call the accountant about the Q3 filing" });
    expect(publicFetch).not.toHaveBeenCalled();
    expect(structureCalls[0]!.context).toBeUndefined();
  });
});
