/**
 * The space brief — what an agent reads when it pins a space. Driven through
 * the REAL `buildSpaceBrief` with only its read seams stubbed (the lens-ranked
 * listing, the overlay read, the playbook door).
 *
 * The defect it exists for (2026-09-28): an agent pinned to Brand Library
 * filed brand assets as generic `file` entities because nothing it read named
 * `brand-asset`. So the assertions are about VALUES ARRIVING:
 *   - a kind this space OWNS reaches `keyKinds` even with zero entities;
 *   - a pod-wide kind with no rows here does NOT (it is not this space's);
 *   - a kind this space OVERLAYS, or holds entities of, does;
 *   - onboarding (framing, expertise, collect) reaches the brief;
 *   - only THIS space's playbooks, capped with a total;
 *   - empty sections are omitted, failed reads are `unavailable`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ranked: [] as unknown[],
  rankedThrows: false,
  overlayRows: [] as Array<{ profileId: string | null }>,
  playbooks: [] as Array<Record<string, unknown>>,
  playbooksThrow: false,
  playbookInput: null as null | Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = (rows: () => unknown[]) => {
    const self: Record<string, unknown> = {
      from: () => self,
      where: () => self,
      limit: () => self,
      then: (r: (v: unknown[]) => unknown, j?: (e: unknown) => unknown) =>
        Promise.resolve(rows()).then(r, j),
    };
    return self;
  };
  return {
    ...actual,
    db: {
      selectDistinct: () => chain(() => h.overlayRows),
      select: () => chain(() => []),
    },
  };
});

vi.mock("./start-here.js", () => ({
  readRankedLensProfiles: async () => {
    if (h.rankedThrows) throw new Error("listProfiles down");
    return h.ranked;
  },
}));

vi.mock("../../routers/hub-protocol/playbook-doors.js", () => ({
  listPlaybooksDoor: async (_id: unknown, input: Record<string, unknown>) => {
    h.playbookInput = input;
    if (h.playbooksThrow) throw new Error("playbooks down");
    return { playbooks: h.playbooks, nextCursor: null };
  },
}));

import {
  buildSpaceBrief,
  briefBytes,
  BRIEF_BUDGET_BYTES,
  BRIEF_PLAYBOOK_CAP,
  resolveSpacePurpose,
  type BuiltSpaceBrief,
} from "./space-brief.js";

const WS = "f001a1a7-56d1-4734-8b9a-cbbe9c28bb01";
const OTHER = "0000aaaa-0000-4000-8000-000000000000";

let rank = 0;
const row = (
  slug: string,
  opts: {
    workspaceId?: string | null;
    entityCount?: number;
    profileKind?: "kind" | "role";
    id?: string;
    description?: string;
  } = {}
) => ({
  profile: {
    id: opts.id ?? `id-${slug}`,
    slug,
    displayName: slug.replace(/-/g, " "),
    profileKind: opts.profileKind ?? "kind",
    workspaceId: opts.workspaceId ?? null,
    uiHints: opts.description ? { description: opts.description } : {},
  },
  rank: ++rank,
  score: opts.entityCount ? 1 : 0,
  entityCount: opts.entityCount ?? 0,
  lastActivityAt: null,
  origin: { origin: "core", group: "core" },
});

const brandLibrary = {
  id: WS,
  name: "Brand Library",
  description:
    "Reusable source of truth for brand identity, colors, typography, assets, tokens, templates, and generation rules.",
  settings: {
    onboarding: {
      goal: "Capture the brand's expressive DNA.",
      framing:
        "THE BRAND STRATEGIST: Act as a seasoned brand strategist.\n  Draw out how the brand sounds.",
      expertise: {
        starters: ["Propose voice as DO / DON'T pairs."],
        blindSpots: ["Brand = logo is the classic trap."],
        bar: "A stranger could write a paragraph that reads as THIS brand.",
      },
      collect: [
        {
          profileSlug: "brand-identity",
          what: "The core identity.",
          cardinality: "one",
        },
        {
          profileSlug: "brand-color",
          what: "Core colors.",
          cardinality: "few",
        },
      ],
    },
  },
};

const build = (workspace: Record<string, unknown> = brandLibrary) =>
  buildSpaceBrief({
    caller: {} as never,
    userId: "u1",
    scopes: ["mcp.read"],
    workspaceId: WS,
    workspace: workspace as never,
  }) as Promise<BuiltSpaceBrief>;

beforeEach(() => {
  rank = 0;
  h.ranked = [
    // Pod-wide, busy pod-wide but NOTHING here — not this space's kind.
    row("knowledge", { entityCount: 0 }),
    row("file", { entityCount: 0 }),
    // Owned by this space, still empty — the one the agent missed.
    row("brand-asset", {
      workspaceId: WS,
      description: "Reusable visual or media asset: logo, image, font, icon.",
    }),
    row("brand-color", { workspaceId: WS, entityCount: 3 }),
    row("brand-identity", { workspaceId: WS, entityCount: 1 }),
    // Owned by ANOTHER workspace, no rows here.
    row("deal", { workspaceId: OTHER }),
    // Global kind this space OVERLAYS (adds fields) — belongs.
    row("person", { id: "id-person" }),
    // Global kind this space HOLDS rows of — belongs.
    row("note", { entityCount: 2 }),
    // A role owned here — the brief lists KINDS.
    row("team-member", { workspaceId: WS, profileKind: "role" }),
  ];
  h.rankedThrows = false;
  h.overlayRows = [{ profileId: "id-person" }, { profileId: null }];
  h.playbooks = [
    {
      id: "pb-own",
      name: "Build the brand kit",
      description: "Walk\n the kit.",
      workspaceId: WS,
    },
    {
      id: "pb-pod",
      name: "Pod-wide review",
      description: null,
      workspaceId: null,
    },
    {
      id: "pb-other",
      name: "Other space",
      description: null,
      workspaceId: OTHER,
    },
  ];
  h.playbooksThrow = false;
  h.playbookInput = null;
});

describe("buildSpaceBrief", () => {
  it("names the kinds that live in THIS space — owned (even empty), overlaid, or holding rows — root first", async () => {
    const brief = await build();
    const kinds = brief.keyKinds as Array<{
      slug: string;
      entityCount: number;
      description?: string;
    }>;
    expect(kinds.map((k) => k.slug)).toEqual([
      "brand-identity", // collect[0] — the root the template declares first
      "brand-color", // collect[1]
      "note", // then by rows held here
      "brand-asset",
      "person",
    ]);
    const asset = kinds.find((k) => k.slug === "brand-asset")!;
    expect(asset.entityCount).toBe(0);
    expect(asset.description).toMatch(/^Reusable visual or media asset/);
    expect(brief.keyKindsTotal).toBeUndefined();
  });

  it("carries the template's onboarding: purpose, persona, expertise, collect", async () => {
    const brief = await build();
    expect(brief.purpose).toMatch(/^Reusable source of truth for brand/);
    // Whitespace-collapsed: YAML folded prose arrives as one line.
    expect(brief.persona).toBe(
      "THE BRAND STRATEGIST: Act as a seasoned brand strategist. Draw out how the brand sounds."
    );
    expect(brief.expertise).toEqual({
      starters: ["Propose voice as DO / DON'T pairs."],
      blindSpots: ["Brand = logo is the classic trap."],
      bar: "A stranger could write a paragraph that reads as THIS brand.",
    });
    expect(brief.collect).toEqual([
      {
        kind: "brand-identity",
        what: "The core identity.",
        cardinality: "one",
      },
      { kind: "brand-color", what: "Core colors.", cardinality: "few" },
    ]);
    expect(brief.more).toMatch(/list_playbooks/);
  });

  it("purpose falls back to the onboarding goal when no description is authored", async () => {
    const brief = await build({ ...brandLibrary, description: null });
    expect(brief.purpose).toBe("Capture the brand's expressive DNA.");
  });

  it("lists only THIS space's active playbooks, capped with a total", async () => {
    let brief = await build();
    expect(h.playbookInput).toMatchObject({
      workspaceId: WS,
      status: "active",
    });
    expect(brief.playbooks).toEqual({
      total: 1,
      items: [
        {
          id: "pb-own",
          name: "Build the brand kit",
          description: "Walk the kit.",
        },
      ],
    });
    h.playbooks = Array.from({ length: 11 }, (_, i) => ({
      id: `pb-${i}`,
      name: `P${i}`,
      description: null,
      workspaceId: WS,
    }));
    brief = await build();
    const pbs = brief.playbooks as { items: unknown[]; total: number };
    expect(pbs.total).toBe(11);
    expect(pbs.items).toHaveLength(BRIEF_PLAYBOOK_CAP);
  });

  it("omits empty sections entirely — no nulls, no empty arrays", async () => {
    h.ranked = [row("knowledge"), row("deal", { workspaceId: OTHER })];
    h.overlayRows = [];
    h.playbooks = [];
    const brief = await build({
      id: WS,
      name: "Bare",
      description: null,
      settings: {},
    });
    expect(brief).toEqual({
      workspaceId: WS,
      name: "Bare",
      more: expect.any(String),
    });
  });

  it("a failed read is `unavailable`, never folded into 'none'", async () => {
    h.rankedThrows = true;
    h.playbooksThrow = true;
    const brief = await build();
    expect(brief.keyKinds).toEqual({ status: "unavailable" });
    expect(brief.playbooks).toEqual({ status: "unavailable" });
    // The authored half still arrives.
    expect(brief.persona).toBeDefined();
  });

  it("a template-sized brief fits the HARD byte budget, keeps every kind's slug, and names what it shed", async () => {
    const prose = (n: number) => "x".repeat(n);
    h.ranked = Array.from({ length: 11 }, (_, i) =>
      row(`brand-kind-${i}`, {
        workspaceId: WS,
        entityCount: i,
        description: prose(118),
      })
    );
    h.playbooks = Array.from({ length: 8 }, (_, i) => ({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      name: `Playbook ${i}`,
      description: prose(118),
      workspaceId: WS,
    }));
    const big = {
      ...brandLibrary,
      settings: {
        onboarding: {
          ...brandLibrary.settings.onboarding,
          framing: prose(600),
          expertise: {
            starters: [prose(300), prose(300), prose(300)],
            blindSpots: [prose(300), prose(300), prose(300)],
            bar: prose(300),
          },
        },
      },
    };
    const brief = await build(big);
    expect(briefBytes(brief)).toBeLessThanOrEqual(BRIEF_BUDGET_BYTES);
    // Non-vacuity: the untrimmed input really was over budget.
    expect(brief.trimmed?.[0]).toBe("expertise.starters");
    // The kinds are the reason the brief exists — every slug survives.
    expect(
      (brief.keyKinds as Array<{ slug: string }>).map((k) => k.slug)
    ).toHaveLength(11);
    expect(brief.keyKindsTotal).toBeUndefined();
    // Totals stay true even when a list tail is dropped.
    const pbs = brief.playbooks as { total: number };
    expect(pbs.total).toBe(8);
    expect(Object.keys(brief).at(-1)).toBe("more");
  });

  it("a Brand-Library-shaped brief keeps its persona and every kind inside the 2 KB cap", async () => {
    // Field LENGTHS measured from synap-app `brand-library.yaml` (2026-09-28):
    // framing 372, starters 280/300/297, blindSpots 272/275/241, bar 238,
    // 5 collect rows (what 68/87/64/24/46), 10 owned kinds (desc 77–109).
    // Built through the real assembly from the real YAML it lands at 1987 B
    // and keeps the persona; at the old 1536 B cap it shed the persona AND
    // every kind description — the voice the template declares never arrived.
    const prose = (n: number) => "y".repeat(n);
    const kindDesc = [89, 77, 79, 109, 91, 101, 92, 90, 96, 99];
    const slugs = [
      "brand-identity",
      "brand-color",
      "brand-font",
      "brand-asset",
      "brand-reference",
      "brand-token-set",
      "brand-voice-guide",
      "brand-rule",
      "brand-template",
      "brand-component",
    ];
    h.ranked = slugs.map((slug, i) =>
      row(slug, {
        workspaceId: WS,
        entityCount: 4,
        description: prose(kindDesc[i]!),
      })
    );
    h.playbooks = [];
    const brief = await build({
      ...brandLibrary,
      settings: {
        onboarding: {
          goal: prose(180),
          framing: prose(372),
          expertise: {
            starters: [prose(280), prose(300), prose(297)],
            blindSpots: [prose(272), prose(275), prose(241)],
            bar: prose(238),
          },
          collect: [
            ["brand-identity", 68],
            ["brand-voice-guide", 87],
            ["brand-rule", 64],
            ["brand-color", 24],
            ["brand-font", 46],
          ].map(([profileSlug, n]) => ({
            profileSlug,
            what: prose(n as number),
            cardinality: "few",
          })),
        },
      },
    });
    expect(briefBytes(brief)).toBeLessThanOrEqual(BRIEF_BUDGET_BYTES);
    // Non-vacuity: it WAS over budget, so the ladder ran — and stopped
    // before the persona.
    expect(brief.trimmed).toEqual([
      "expertise.starters",
      "expertise.blindSpots",
      "collect.what",
      "expertise",
      "collect",
      "keyKinds.description:60",
    ]);
    // The persona arrives (capped at the prose cap), and every kind keeps prose.
    expect(brief.persona).toHaveLength(240);
    const kinds = brief.keyKinds as Array<{
      slug: string;
      description?: string;
    }>;
    expect(kinds.every((k) => (k.description?.length ?? 0) === 60)).toBe(true);
    expect((brief.keyKinds as unknown[]).length).toBe(10);
    expect(BRIEF_BUDGET_BYTES).toBe(2048);
  });

  it("the playbook LIST is shed before purpose, persona, the root anchor and the kinds", async () => {
    const prose = (n: number) => "z".repeat(n);
    h.ranked = Array.from({ length: 8 }, (_, i) =>
      row(`kind-${i}`, { workspaceId: WS, entityCount: 1, description: prose(90) })
    );
    h.playbooks = Array.from({ length: 8 }, (_, i) => ({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      name: `A long playbook name number ${i} ${prose(60)}`,
      description: prose(118),
      workspaceId: WS,
    }));
    const brief = await build({
      ...brandLibrary,
      settings: {
        onboarding: {
          purpose: prose(230),
          framing: prose(372),
          anchors: [
            { profileSlug: "kind-0", role: "root", entityId: "e-root" },
            { profileSlug: "kind-1", role: "context", limit: 5 },
          ],
          rules: [{ key: "rule-a", ruleId: "r1" }, { key: "rule-b" }],
        },
      },
    });
    expect(briefBytes(brief)).toBeLessThanOrEqual(BRIEF_BUDGET_BYTES);
    // Non-vacuity: the list really was shed, its total kept.
    expect(brief.trimmed).toContain("playbooks.items");
    // Emptied, never removed: published CLIs read `items.length`.
    expect(brief.playbooks).toEqual({ items: [], total: 8 });
    expect(brief.purpose).toHaveLength(230);
    expect(brief.persona).toBeDefined();
    expect(brief.anchors?.root).toEqual({ kind: "kind-0", entityId: "e-root" });
    const kinds = brief.keyKinds as Array<{ description?: string }>;
    expect(kinds).toHaveLength(8);
    // Kind prose was not touched: the list went first.
    expect(kinds.every((k) => k.description?.length === 90)).toBe(true);
  });

  it("W3 steady-state fields arrive: purpose outranks the description, anchors, rule keys", async () => {
    const brief = await build({
      ...brandLibrary,
      settings: {
        onboarding: {
          ...brandLibrary.settings.onboarding,
          purpose: "Read the brand before generating anything.",
          anchors: [
            { profileSlug: "brand-identity", role: "root", entityId: "e1" },
            { profileSlug: "brand-rule", role: "context" },
            { profileSlug: "brand-rule", role: "context" },
            { profileSlug: "", role: "root" },
          ],
          rules: [{ key: "brand-store-typed", ruleId: "r1" }, { nokey: 1 }],
        },
      },
    });
    expect(brief.purpose).toBe("Read the brand before generating anything.");
    expect(brief.anchors).toEqual({
      root: { kind: "brand-identity", entityId: "e1" },
      context: ["brand-rule"],
    });
    expect(brief.rules).toEqual(["brand-store-typed"]);
  });

  it("a small brief is untrimmed, and a name that only restates the slug is omitted", async () => {
    const brief = await build();
    expect(brief.trimmed).toBeUndefined();
    const kinds = brief.keyKinds as Array<{ slug: string; name?: string }>;
    expect(kinds.find((k) => k.slug === "brand-asset")).not.toHaveProperty(
      "name"
    );
    expect(briefBytes(brief)).toBeLessThanOrEqual(BRIEF_BUDGET_BYTES);
  });
});

describe("resolveSpacePurpose — one rule for orient, the brief and diagnose", () => {
  it("prefers an authored description, skips a `Domain: x` placeholder, falls back to the goal", () => {
    expect(resolveSpacePurpose("  Real purpose. ", { goal: "g" })).toBe(
      "Real purpose."
    );
    expect(resolveSpacePurpose("Domain: personal", { goal: "The goal." })).toBe(
      "The goal."
    );
    expect(resolveSpacePurpose(null, undefined)).toBeNull();
    // The brief's steady-state purpose precedes the interview goal.
    expect(
      resolveSpacePurpose(null, { purpose: " The purpose. ", goal: "g" })
    ).toBe("The purpose.");
  });
});
