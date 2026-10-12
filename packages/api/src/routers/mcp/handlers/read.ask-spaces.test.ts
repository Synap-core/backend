/**
 * `synap_ask` suggests SPACES — driven through the REAL MCP handler and the
 * REAL `ask()`.
 *
 * WHY: an agent asked about brand assets must learn WHERE they live (Brand
 * Library and its `brand-*` kinds), not only what recall matched. `ask()`
 * maps the kinds its semantic engine understood to the member spaces holding
 * entities of them — through THE usage aggregate — and the handler forwards
 * that hint.
 *
 * WHAT IS REAL: the handler, `ask()`, `classifySubstrates`,
 * `suggestSpacesForKinds` (`services/discover/space-catalog.ts`),
 * `spacePurposeLine`. WHAT IS STUBBED: I/O only — the lens resolver, the
 * semantic engine (it hands back `understanding.profileTypes`, the seam this
 * feature reads), synthesis, the pending scan, the membership read, the usage
 * aggregate and the workspace-row read.
 *
 * NOT COVERED: the usage aggregate's SQL floor (its own pglite test) — this
 * file proves the hint reads it with the caller's MEMBER ids and ranks what
 * comes back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const BRAND = "f001a1a7-56d1-4734-8b9a-cbbe9c28bb01";
const CRM = "f73f40f0-c023-4f2e-b55a-10d3f7539b1f";
const CONTENT = "0000aaaa-0000-4000-8000-000000000002";

const h = vi.hoisted(() => ({
  profileTypes: [] as string[],
  memberIds: [] as string[],
  usage: [] as Array<Record<string, unknown>>,
  usageThrows: false,
  usageCalls: [] as Array<Record<string, unknown>>,
  workspaceRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../services/knowledge/resolve-lens.js", () => ({
  resolveKnowledgeLens: async () => ({ workspaceId: null, catalog: [] }),
}));

vi.mock("../../../services/retrieval/retrieve.js", () => ({
  retrieve: async () => ({
    entities: [],
    understanding: {
      profileTypes: h.profileTypes,
      propertyHints: [],
      temporal: false,
      confidence: 1,
      cleanedQuery: "",
    },
    source: "typesense",
    vectorDown: false,
    verdict: "empty",
  }),
}));

vi.mock("../../../services/knowledge/synthesize.js", () => ({
  synthesizeAnswer: async () => ({ answer: "ok", sources: [], routedTo: [] }),
}));

vi.mock("../../../utils/pending-capture-dedup.js", () => ({
  findPendingTextMatches: async () => [],
}));

vi.mock("../../hub-protocol/rest/_shared.js", async (orig) => ({
  ...(await orig<typeof import("../../hub-protocol/rest/_shared.js")>()),
  getUserMemberWorkspaceIds: async () => h.memberIds,
}));

vi.mock("../../../services/discover/usage-aggregate.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/discover/usage-aggregate.js")
  >()),
  loadEntityUsage: async (p: Record<string, unknown>) => {
    h.usageCalls.push(p);
    if (h.usageThrows) throw new Error("entities GROUP BY down");
    return h.usage;
  },
}));

vi.mock("@synap/database", async (orig) => {
  const actual = await orig<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            Promise.resolve(table === actual.workspaces ? h.workspaceRows : []),
        }),
      }),
    },
  };
});

const { readHandlers } = await import("./read.js");

const usageRow = (workspaceId: string | null, type: string, count: number) => ({
  workspaceId,
  profileId: `p-${type}`,
  type,
  count,
  lastActivityAt: null,
  openCount: 0,
  lastOpenedAt: null,
  pinnedCount: 0,
});

async function askMcp(query: string): Promise<Record<string, any>> {
  const res = (await readHandlers.synap_ask!({
    toolName: "synap_ask",
    args: { query },
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {} as never,
    lensCaller: {} as never,
    workspaceAccessible: false,
  } as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

beforeEach(() => {
  h.profileTypes = ["brand-color", "brand-font"];
  h.memberIds = [BRAND, CRM, CONTENT];
  h.usageThrows = false;
  h.usageCalls = [];
  h.usage = [
    usageRow(BRAND, "brand-color", 6),
    usageRow(BRAND, "brand-font", 2),
    usageRow(BRAND, "brand-identity", 1), // not asked about
    usageRow(CONTENT, "brand-color", 1),
    usageRow(CRM, "deal", 40), // busiest space, holds none of these kinds
    usageRow(null, "brand-font", 3), // pod-scoped bucket — no space to route to
  ];
  h.workspaceRows = [
    {
      id: BRAND,
      name: "Brand Library",
      description: "Domain: personal",
      settings: {
        onboarding: { goal: "Capture the brand's expressive DNA." },
      },
    },
    {
      id: CONTENT,
      name: "Content Studio",
      description: "Produce posts, images and video assets.",
      settings: {},
    },
  ];
});

describe("synap_ask — the spaces hint", () => {
  it("names the spaces HOLDING the understood kinds, busiest first, with their own counts", async () => {
    const out = await askMcp("what are our brand colors and fonts");
    expect(out.spaces.matches).toEqual([
      {
        workspaceId: BRAND,
        name: "Brand Library",
        // The one purpose rule: a `Domain: x` placeholder falls to the goal.
        purpose: "Capture the brand's expressive DNA.",
        kinds: [
          { slug: "brand-color", count: 6 },
          { slug: "brand-font", count: 2 },
        ],
      },
      {
        workspaceId: CONTENT,
        name: "Content Studio",
        purpose: "Produce posts, images and video assets.",
        kinds: [{ slug: "brand-color", count: 1 }],
      },
    ]);
    // Read through THE usage aggregate, floored to the caller's member spaces.
    expect(h.usageCalls).toEqual([
      { userId: "user-1", workspaceIds: [BRAND, CRM, CONTENT] },
    ]);
  });

  it("a failed read arrives as `unavailable` — never dropped, never 'no space'", async () => {
    h.usageThrows = true;
    const out = await askMcp("what are our brand colors");
    expect(out.spaces).toEqual({ status: "unavailable" });
    // Recall itself still answers.
    expect(out.answer).toBe("ok");
  });

  it("read, and nothing holds those kinds: `matches: []`", async () => {
    h.profileTypes = ["invoice"];
    const out = await askMcp("show the invoices");
    expect(out.spaces).toEqual({ matches: [] });
  });

  it("no kind understood: no hint at all (nothing to route)", async () => {
    h.profileTypes = [];
    const out = await askMcp("what happened yesterday");
    expect("spaces" in out).toBe(false);
    expect(h.usageCalls).toEqual([]);
  });
});
