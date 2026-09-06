import { describe, it, expect } from "vitest";
import {
  computeWorkspaceOverlap,
  duplicateWorkspaceNames,
  summarizeWorkspaceLandscape,
  NEAR_DUPLICATE_JACCARD,
  type WorkspaceLandscapeRow,
} from "./workspace.js";

/**
 * The PURE tier of the workspace landscape.
 *
 * These are deliberately DB-free. The rest of this surface loads rows from
 * Postgres, and every DB-backed test in this package is unrunnable locally —
 * so the logic that actually decides "do these two workspaces overlap" would
 * otherwise ship with no executable coverage at all. Splitting the pure
 * functions out is what makes them provable here; keep them pure.
 *
 * WHY THIS SURFACE EXISTS: an external reviewer had to SSH into Postgres and
 * write raw SQL to answer "do these two workspaces overlap, and by how much?"
 * — comparing profile slugs by hand to find zero intersection across 5 kinds
 * vs 27. `computeWorkspaceOverlap` is that query, made a product feature.
 */

const row = (
  over: Partial<WorkspaceLandscapeRow> & { id: string; name: string }
): WorkspaceLandscapeRow => ({
  domain: null,
  workspaceType: null,
  description: null,
  onboardingGoal: null,
  hasOnboarding: false,
  entityCount: 0,
  profileSlugs: [],
  lastActivityAt: null,
  archived: false,
  ...over,
});

describe("computeWorkspaceOverlap", () => {
  it("reports NOTHING for workspaces that share no kinds — the real finding", () => {
    // The measured live case: two workspaces, 5 kinds vs 27, zero intersection.
    // An empty result is the SIGNAL (these are genuinely different lenses), not
    // an absence of data, so it must not be conflated with "not computed".
    const pairs = computeWorkspaceOverlap([
      row({ id: "a", name: "Builder", profileSlugs: ["task", "decision"] }),
      row({ id: "b", name: "CRM", profileSlugs: ["person", "company"] }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("computes jaccard over the UNION, not over either side", () => {
    // A ∩ B = {task}; A ∪ B = {task, decision, person} ⇒ 1/3.
    // Dividing by |A| or |B| instead would make a small workspace look like a
    // near-duplicate of every large one it touches.
    const [pair] = computeWorkspaceOverlap([
      row({ id: "a", name: "A", profileSlugs: ["task", "decision"] }),
      row({ id: "b", name: "B", profileSlugs: ["task", "person"] }),
    ]);
    expect(pair!.shared).toEqual(["task"]);
    expect(pair!.sharedCount).toBe(1);
    expect(pair!.jaccard).toBeCloseTo(0.3333, 3);
  });

  it("flags an identical pair at jaccard 1 — above the near-duplicate line", () => {
    const [pair] = computeWorkspaceOverlap([
      row({
        id: "a",
        name: "Foundation",
        profileSlugs: ["mission", "audience"],
      }),
      row({
        id: "b",
        name: "Foundation",
        profileSlugs: ["audience", "mission"],
      }),
    ]);
    expect(pair!.jaccard).toBe(1);
    expect(pair!.jaccard).toBeGreaterThanOrEqual(NEAR_DUPLICATE_JACCARD);
    // Order-insensitive: slug order is a query artifact, not a difference.
    expect(pair!.shared).toEqual(["audience", "mission"]);
  });

  it("ranks by shared COUNT first, then jaccard", () => {
    // The consolidation question is "how much do these two duplicate each
    // other", so a 3-slug overlap outranks a 1-slug overlap even when the
    // smaller pair scores a higher ratio.
    const pairs = computeWorkspaceOverlap([
      row({ id: "a", name: "A", profileSlugs: ["t", "d", "p", "x", "y"] }),
      row({ id: "b", name: "B", profileSlugs: ["t", "d", "p", "z", "w"] }),
      row({ id: "c", name: "C", profileSlugs: ["q"] }),
      row({ id: "e", name: "E", profileSlugs: ["q"] }),
    ]);
    expect(pairs[0]!.sharedCount).toBe(3);
    expect(pairs[1]!.sharedCount).toBe(1);
    expect(pairs[1]!.jaccard).toBe(1);
  });

  it("never pairs a workspace with itself, and emits each pair ONCE", () => {
    const pairs = computeWorkspaceOverlap([
      row({ id: "a", name: "A", profileSlugs: ["t"] }),
      row({ id: "b", name: "B", profileSlugs: ["t"] }),
      row({ id: "c", name: "C", profileSlugs: ["t"] }),
    ]);
    // 3 choose 2 = 3, not 9 and not 6.
    expect(pairs).toHaveLength(3);
    expect(pairs.every((p) => p.aId !== p.bId)).toBe(true);
    const keys = pairs.map((p) => [p.aId, p.bId].sort().join("|"));
    expect(new Set(keys).size).toBe(3);
  });

  it("is empty for an empty landscape and for a single workspace", () => {
    expect(computeWorkspaceOverlap([])).toEqual([]);
    expect(
      computeWorkspaceOverlap([
        row({ id: "a", name: "A", profileSlugs: ["t"] }),
      ])
    ).toEqual([]);
  });
});

describe("duplicateWorkspaceNames", () => {
  it("finds the live case: two workspaces sharing one name", () => {
    // Measured on the pod: two "Foundation" and two "CRM". This is not
    // cosmetic — `synap_set_workspace_focus` matched exact names with `.find()`
    // and silently pinned whichever row came back first, so an agent told
    // "use Foundation" wrote into a workspace nobody chose.
    const dupes = duplicateWorkspaceNames([
      row({ id: "f1", name: "Foundation" }),
      row({ id: "f2", name: "Foundation" }),
      row({ id: "b1", name: "Builder" }),
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.name).toBe("Foundation");
    expect(dupes[0]!.ids.sort()).toEqual(["f1", "f2"]);
  });

  it("matches case- and whitespace-insensitively — they are equally ambiguous", () => {
    // Name resolution lowercases before comparing, so "crm" and " CRM " collide
    // there too. Reporting only exact-byte duplicates would under-report the
    // ambiguity the resolver actually faces.
    const dupes = duplicateWorkspaceNames([
      row({ id: "a", name: "CRM" }),
      row({ id: "b", name: " crm " }),
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.ids.sort()).toEqual(["a", "b"]);
  });

  it("reports nothing when every name is unique", () => {
    expect(
      duplicateWorkspaceNames([
        row({ id: "a", name: "Builder" }),
        row({ id: "b", name: "CRM" }),
      ])
    ).toEqual([]);
  });

  it("groups THREE same-named workspaces into one entry, not two pairs", () => {
    const dupes = duplicateWorkspaceNames([
      row({ id: "a", name: "Inbox" }),
      row({ id: "b", name: "Inbox" }),
      row({ id: "c", name: "Inbox" }),
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.ids).toHaveLength(3);
  });
});

describe("summarizeWorkspaceLandscape", () => {
  const landscape = (
    rows: WorkspaceLandscapeRow[],
    over: Partial<Parameters<typeof summarizeWorkspaceLandscape>[0]> = {}
  ) =>
    summarizeWorkspaceLandscape({
      rows,
      podScoped: { entityCount: 0, profileSlugs: [] },
      overlaps: computeWorkspaceOverlap(rows),
      pairsSkipped: false,
      scopedToOne: false,
      ...over,
    });

  it("is HONESTLY EMPTY — a healthy landscape says so instead of returning a bare shape", () => {
    // The house style for a diagnose summary: when nothing is wrong it must SAY
    // nothing is wrong. A summary that only ever lists problems reads as broken
    // when the answer is "you are fine".
    const report = landscape([
      row({
        id: "a",
        name: "Builder",
        entityCount: 9,
        profileSlugs: ["task"],
        description: "Ship the product",
      }),
      row({
        id: "b",
        name: "CRM",
        entityCount: 4,
        profileSlugs: ["person"],
        description: "Client pipeline",
      }),
    ]);
    expect(report.summary).toMatch(/nothing suggests consolidation/);
    expect(report.summary).toMatch(/No two share a single entity kind/);
  });

  it("names DUPLICATE NAMES as an ambiguity, not a cosmetic nit", () => {
    // This is the live case (two "Foundation", two "CRM") and it is a
    // correctness problem: focusing by name silently picked one of them.
    const report = landscape([
      row({
        id: "a",
        name: "Foundation",
        entityCount: 3,
        profileSlugs: ["mission"],
        description: "x",
      }),
      row({
        id: "b",
        name: "Foundation",
        entityCount: 1,
        profileSlugs: ["mission"],
        description: "y",
      }),
    ]);
    expect(report.summary).toMatch(/used twice/);
    expect(report.summary).toMatch(/ambiguous/);
    expect(report.detail.duplicateNames).toHaveLength(1);
  });

  it("reports the POD-SCOPED bucket as a lens-weakening fact", () => {
    // A workspace whose visible content is mostly pod-scoped is barely a lens.
    // The number has to reach the summary or nobody learns it.
    const report = landscape(
      [
        row({
          id: "a",
          name: "Builder",
          entityCount: 2,
          profileSlugs: ["task"],
          description: "x",
        }),
      ],
      { podScoped: { entityCount: 453, profileSlugs: ["knowledge"] } }
    );
    expect(report.summary).toMatch(/453 entity\(ies\) are pod-scoped/);
    expect(report.summary).toMatch(/visible in EVERY workspace/);
  });

  it("says overlap was SKIPPED rather than implying there is none", () => {
    // The dangerous failure: a skipped computation rendering as "no overlap".
    // Absence of evidence must not print as evidence of absence.
    const report = landscape(
      [
        row({
          id: "a",
          name: "A",
          entityCount: 1,
          profileSlugs: ["task"],
          description: "x",
        }),
      ],
      { pairsSkipped: true, overlaps: [] }
    );
    expect(report.summary).toMatch(/not computed/);
    expect(report.summary).not.toMatch(/lenses are disjoint/);
    expect(report.detail.overlapPairsSkipped).toBe(true);
  });

  it("flags a workspace with no authored identity", () => {
    const report = landscape([
      row({
        id: "a",
        name: "New Workspace",
        entityCount: 5,
        profileSlugs: ["task"],
      }),
    ]);
    expect(report.summary).toMatch(
      /no authored description or onboarding spec/
    );
    expect(report.detail.withoutAuthoredIdentity).toHaveLength(1);
  });
});
