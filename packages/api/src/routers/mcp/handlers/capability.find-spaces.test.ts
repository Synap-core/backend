/**
 * `synap_find` searches SPACES — driven through the REAL handler.
 *
 * The defect (2026-09-28): an agent asked to store brand assets filed generic
 * `file` entities. Nothing it searched named Brand Library or its `brand-*`
 * kinds — `find` looked at verbs, intents and playbooks, never at the spaces
 * the pod is organised into.
 *
 * WHAT IS REAL: the handler, `findByIntent`, `listSpaceCandidates`
 * (`space-catalog.ts`), `spacePurposeLine` / `resolveSpacePurpose`, and
 * `rankByTerms`. WHAT IS STUBBED: the I/O boundaries — the membership read
 * (`getUserMemberWorkspaceIds`), the two table reads (`workspaces`,
 * `profiles`, dispatched on table identity), and the other three catalogs'
 * reads (empty, so the spaces block is what is under test).
 *
 * NOT COVERED: the SQL predicates themselves (membership join, archived
 * filter) — this file proves the floor's ids are the ones read and that an
 * empty membership reads nothing; the live SQL needs a real database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  memberIds: [] as string[],
  memberThrows: false,
  memberCalls: [] as string[],
  workspaceRows: [] as Array<Record<string, unknown>>,
  profileRows: [] as Array<Record<string, unknown>>,
  tablesRead: [] as string[],
}));

vi.mock("@synap/database", async (orig) => {
  const actual = await orig<typeof import("@synap/database")>();
  const rowsFor = (table: unknown) => {
    if (table === actual.workspaces) {
      h.tablesRead.push("workspaces");
      return h.workspaceRows;
    }
    if (table === actual.profiles) {
      h.tablesRead.push("profiles");
      return h.profileRows;
    }
    return [];
  };
  return {
    ...actual,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => Promise.resolve(rowsFor(table)),
        }),
      }),
    },
  };
});

vi.mock("../../hub-protocol/rest/_shared.js", async (orig) => {
  const actual =
    await orig<typeof import("../../hub-protocol/rest/_shared.js")>();
  return {
    ...actual,
    verifyWorkspaceAccess: async () => true,
    getUserMemberWorkspaceIds: async (userId: string) => {
      h.memberCalls.push(userId);
      if (h.memberThrows) throw new Error("workspace_members down");
      return h.memberIds;
    },
  };
});

vi.mock(
  "../../../services/capabilities/capability-registry.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    listCapabilities: async () => [],
  })
);
vi.mock("../../../services/capabilities/intent-registry.js", () => ({
  listIntentSlugs: async () => [],
}));
vi.mock(
  "../../../services/focus-sessions/match-session-template.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    matchSessionTemplate: async () => ({ candidates: [], optOut: {} }),
  })
);

const { capabilityHandlers } = await import("./capability.js");

const BRAND = "f001a1a7-56d1-4734-8b9a-cbbe9c28bb01";
const CRM = "f73f40f0-c023-4f2e-b55a-10d3f7539b1f";
const MARKETING = "0000aaaa-0000-4000-8000-000000000001";
const CONTENT = "0000aaaa-0000-4000-8000-000000000002";
const FOUNDATION = "0000aaaa-0000-4000-8000-000000000003";

/** Rows shaped as the workspace table holds them — prose from the real templates. */
const WORKSPACES = [
  {
    id: CRM,
    name: "CRM",
    description:
      "A focused pre-sale workspace for contacts, companies, and deals.",
    settings: {
      onboarding: {
        goal: "Turn the user's real commercial motion into a usable pipeline.",
        framing:
          "THE REVENUE OPERATOR: Act as a pragmatic sales lead setting up a CRM people will actually maintain.",
        collect: [{ profileSlug: "deal" }, { profileSlug: "company" }],
      },
    },
  },
  {
    id: MARKETING,
    name: "Marketing",
    description: "Campaigns, channels and brand awareness experiments.",
    settings: {},
  },
  {
    id: CONTENT,
    name: "Content Studio",
    description: "Produce posts, images and video assets for every channel.",
    settings: {},
  },
  {
    id: BRAND,
    name: "Brand Library",
    description:
      "Reusable source of truth for brand identity, colors, typography, assets, tokens, templates, and generation rules.",
    settings: {
      onboarding: {
        goal: "Capture the brand's expressive DNA.",
        framing:
          "THE BRAND STRATEGIST: Act as a seasoned brand strategist.\n Draw out how the brand sounds and looks.",
        collect: [
          { profileSlug: "brand-identity" },
          { profileSlug: "brand-voice-guide" },
          { profileSlug: "brand-rule" },
          { profileSlug: "brand-color" },
          { profileSlug: "brand-font" },
        ],
      },
    },
  },
  {
    id: FOUNDATION,
    name: "Foundation",
    description: "Domain: personal",
    settings: {
      onboarding: { goal: "Capture mission, audience and positioning." },
    },
  },
];

const PROFILES = [
  ...[
    "brand-asset",
    "brand-color",
    "brand-component",
    "brand-font",
    "brand-identity",
    "brand-reference",
    "brand-rule",
    "brand-template",
    "brand-token-set",
    "brand-voice-guide",
  ].map((slug) => ({ workspaceId: BRAND, slug })),
  { workspaceId: CONTENT, slug: "content-piece" },
  { workspaceId: MARKETING, slug: "campaign" },
];

async function find(
  args: Record<string, unknown>
): Promise<Record<string, any>> {
  const res = (await capabilityHandlers.synap_find!({
    toolName: "synap_find",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    agentUserId: "agent-1",
  } as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

beforeEach(() => {
  h.memberIds = WORKSPACES.map((w) => w.id);
  h.memberThrows = false;
  h.memberCalls = [];
  h.workspaceRows = WORKSPACES;
  h.profileRows = PROFILES;
  h.tablesRead = [];
});

describe("synap_find — the spaces catalog", () => {
  it("routes 'store brand assets logo colors fonts' to Brand Library, with the brand-* kinds to write", async () => {
    const out = await find({ intent: "store brand assets logo colors fonts" });
    const matches = out.spaces.matches as Array<Record<string, any>>;
    // Non-vacuity: more than one space matched, so Brand Library won on merit.
    expect(matches.length).toBeGreaterThan(1);
    expect(matches[0]!.workspaceId).toBe(BRAND);
    expect(matches[0]!.name).toBe("Brand Library");
    expect(matches[0]!.confidence).toBe(1);
    expect(matches[1]!.confidence).toBeLessThan(1);
    // The kinds the query named, ranked over THIS space's own kinds.
    expect(matches[0]!.kinds).toEqual(
      expect.arrayContaining(["brand-asset", "brand-color", "brand-font"])
    );
    expect(matches[0]!.kinds).toHaveLength(3);
    // Purpose is the one-line resolveSpacePurpose.
    expect(matches[0]!.purpose).toMatch(/^Reusable source of truth for brand/);
    expect(matches[0]!.termCoverage.hit).toBeGreaterThanOrEqual(4);
    expect(out.scoring.spaces.scale).toMatch(/best space score/);
  });

  it("is searched by default (no catalogs arg) and alone when named", async () => {
    const all = await find({ intent: "log a deal with a company" });
    expect(all.spaces.matches[0].workspaceId).toBe(CRM);
    expect(all.capabilities).toBeDefined();

    const only = await find({ intent: "deal", catalogs: ["spaces"] });
    expect(only.spaces.matches[0].workspaceId).toBe(CRM);
    expect(only.capabilities).toBeUndefined();
    expect(only.playbooks).toBeUndefined();
  });

  it("a placeholder description never reaches the wire — the goal is the purpose", async () => {
    const out = await find({ intent: "mission audience positioning" });
    const foundation = out.spaces.matches.find(
      (m: { workspaceId: string }) => m.workspaceId === FOUNDATION
    );
    expect(foundation.purpose).toBe(
      "Capture mission, audience and positioning."
    );
  });

  it("reads ONLY the caller's member spaces — the membership floor synap_find applies", async () => {
    h.memberIds = [];
    const out = await find({ intent: "store brand assets" });
    expect(h.memberCalls).toEqual(["user-1"]);
    // No membership, no read: nothing to rank, and it says it searched.
    expect(h.tablesRead).toEqual([]);
    expect(out.spaces).toEqual({ matches: [] });
  });

  it("a failed read is spaces.error — never folded into 'no space fits'", async () => {
    h.memberThrows = true;
    const out = await find({ intent: "store brand assets" });
    expect(out.spaces).toEqual({ error: "workspace_members down" });
    expect("matches" in out.spaces).toBe(false);
    // The rest of the find still answers.
    expect(out.capabilities).toEqual({ matches: [] });
  });
});
