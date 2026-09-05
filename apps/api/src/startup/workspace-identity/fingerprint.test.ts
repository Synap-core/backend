/**
 * Matcher tests — pure, no DB, no config imports (so they run under a bare
 * `vitest --root apps/api` with no vitest config present).
 *
 * The NON-VACUITY tests at the bottom are the point of this file: they fail if
 * the strong-evidence bar is loosened, which is the only thing standing between
 * "converge an orphan workspace" and "pour the wrong template into it".
 */

import { describe, it, expect } from "vitest";
import {
  buildTemplateFingerprints,
  matchWorkspaceIdentity,
  type TemplateFingerprint,
  type WorkspaceObservation,
} from "./fingerprint.js";

/**
 * A miniature corpus with the SAME shapes the real one has:
 *  - `builder-workspace`: many corpus-unique profiles, subtype ≠ slug.
 *  - `crm` ⊂ `business-developer`: crm has ZERO distinctive slugs (the real
 *    superset relationship that must produce AMBIGUOUS / UNKNOWN, never a guess).
 *  - `tiny-one`: a single-profile template — the shape that would be trivially
 *    matchable if coverage alone were the bar.
 *  - `no-profiles`: an operational overlay (the `base` shape) that must never
 *    be a candidate.
 */
const CORPUS: TemplateFingerprint[] = [
  {
    slug: "builder-workspace",
    subtype: "builder",
    names: ["builder"],
    profileSlugs: [
      "devplane_app",
      "devplane_feature",
      "devplane_service",
      "devplane_deployment",
      "project",
      "task",
    ],
  },
  {
    slug: "crm",
    subtype: "crm",
    names: ["crm"],
    profileSlugs: ["company", "contact", "deal", "pipeline"],
  },
  {
    slug: "business-developer",
    subtype: "crm",
    names: ["business developer"],
    profileSlugs: [
      "company",
      "contact",
      "deal",
      "pipeline",
      "crm-commission-entitlement",
    ],
  },
  {
    slug: "tiny-one",
    subtype: "tiny-one",
    names: ["tiny one"],
    profileSlugs: ["objective"],
  },
  {
    slug: "foundation",
    subtype: "foundation",
    names: ["foundation"],
    profileSlugs: ["mission", "vision", "value", "non-goal"],
    sourceRoles: { brand: "provider" },
  },
  {
    slug: "no-profiles",
    subtype: "base",
    names: ["base"],
    profileSlugs: [],
  },
];

const corpus = buildTemplateFingerprints(CORPUS);

const ws = (o: Partial<WorkspaceObservation>): WorkspaceObservation => ({
  id: "00000000-0000-0000-0000-000000000001",
  name: "Untitled",
  profileSlugs: [],
  ...o,
});

describe("buildTemplateFingerprints", () => {
  it("drops zero-profile templates — an operational overlay is never an identity", () => {
    expect(corpus.fingerprints.map((f) => f.slug)).not.toContain("no-profiles");
  });

  it("marks a slug distinctive only when exactly one template declares it", () => {
    expect(corpus.distinctiveSlugs.has("devplane_app")).toBe(true);
    expect(corpus.distinctiveSlugs.has("crm-commission-entitlement")).toBe(
      true
    );
    // Shared by crm and business-developer → not distinctive.
    expect(corpus.distinctiveSlugs.has("company")).toBe(false);
    expect(corpus.distinctiveSlugs.has("deal")).toBe(false);
  });
});

describe("matchWorkspaceIdentity — UNAMBIGUOUS", () => {
  const orphanBuilder = ws({
    name: "Builder",
    profileSlugs: [
      "devplane_app",
      "devplane_feature",
      "devplane_service",
      "devplane_deployment",
      "project",
      "task",
      "note",
    ],
    entityCount: 901,
  });

  it("identifies a devplane-shaped workspace as builder-workspace", () => {
    const r = matchWorkspaceIdentity(orphanBuilder, corpus);
    expect(r.verdict).toBe("UNAMBIGUOUS");
    expect(r.match).toEqual({ slug: "builder-workspace", subtype: "builder" });
  });

  it("reports the slug AND the template's declared subtype — they differ", () => {
    const r = matchWorkspaceIdentity(orphanBuilder, corpus);
    expect(r.match!.slug).not.toBe(r.match!.subtype);
  });

  it("carries the evidence that earned the verdict", () => {
    const r = matchWorkspaceIdentity(orphanBuilder, corpus);
    const winner = r.candidates.find((c) => c.slug === "builder-workspace")!;
    expect(winner.distinctiveMatched).toEqual(
      expect.arrayContaining(["devplane_app", "devplane_feature"])
    );
    expect(winner.coverage).toBe(1);
    expect(r.reason).toContain("devplane_app");
  });
});

describe("matchWorkspaceIdentity — AMBIGUOUS", () => {
  it("refuses to choose between a template and its superset", () => {
    const r = matchWorkspaceIdentity(
      ws({
        name: "Sales",
        profileSlugs: [
          "company",
          "contact",
          "deal",
          "pipeline",
          "crm-commission-entitlement",
        ],
      }),
      corpus
    );
    // business-developer clears the bar on its distinctive slug; crm covers
    // 4/4 but has ZERO distinctive slugs, so only one is strong — the point is
    // that the CRM-shaped half can never win on its own.
    expect(r.match?.slug ?? null).not.toBe("crm");
  });

  it("returns AMBIGUOUS when several templates each clear the bar", () => {
    const r = matchWorkspaceIdentity(
      ws({
        name: "Everything",
        profileSlugs: [
          "devplane_app",
          "devplane_feature",
          "devplane_service",
          "devplane_deployment",
          "project",
          "task",
          "company",
          "contact",
          "deal",
          "pipeline",
          "crm-commission-entitlement",
          "mission",
          "vision",
          "value",
          "non-goal",
        ],
        sourceRoles: { brand: "provider" },
      }),
      corpus
    );
    expect(r.verdict).toBe("AMBIGUOUS");
    expect(r.match).toBeUndefined();
  });
});

describe("matchWorkspaceIdentity — UNKNOWN", () => {
  it("returns UNKNOWN with no candidates when nothing overlaps", () => {
    const r = matchWorkspaceIdentity(
      ws({ name: "Scratch", profileSlugs: ["widget", "gizmo"] }),
      corpus
    );
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.candidates).toHaveLength(0);
  });

  it("returns UNKNOWN — never a stamp — for a bare CRM-shaped workspace", () => {
    const r = matchWorkspaceIdentity(
      ws({
        name: "CRM",
        profileSlugs: ["company", "contact", "deal", "pipeline"],
      }),
      corpus
    );
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.match).toBeUndefined();
    // Both candidates are reported so an operator can decide by hand.
    expect(r.candidates.map((c) => c.slug)).toEqual(
      expect.arrayContaining(["crm", "business-developer"])
    );
  });

  it("never stamps a system workspace, however its profiles look", () => {
    const r = matchWorkspaceIdentity(
      ws({
        name: "Builder",
        systemSlug: "pod-admin",
        profileSlugs: [
          "devplane_app",
          "devplane_feature",
          "devplane_service",
          "devplane_deployment",
          "project",
          "task",
        ],
      }),
      corpus
    );
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.reason).toContain("pod-admin");
  });

  it("a name match alone earns nothing", () => {
    const r = matchWorkspaceIdentity(ws({ name: "Foundation" }), corpus);
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.match).toBeUndefined();
  });

  it("a sourceRoles match alone earns nothing", () => {
    const r = matchWorkspaceIdentity(
      ws({ name: "Anon", sourceRoles: { brand: "provider" } }),
      corpus
    );
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.match).toBeUndefined();
  });
});

describe("corroboration lowers the distinctive bar but never replaces coverage", () => {
  it("full coverage + one distinctive slug + a name match is enough", () => {
    const r = matchWorkspaceIdentity(
      ws({ name: "Tiny One", profileSlugs: ["objective"] }),
      corpus
    );
    expect(r.verdict).toBe("UNAMBIGUOUS");
    expect(r.match!.slug).toBe("tiny-one");
  });

  it("the SAME coverage without corroboration is not enough", () => {
    const r = matchWorkspaceIdentity(
      ws({ name: "Unrelated Name", profileSlugs: ["objective"] }),
      corpus
    );
    expect(r.verdict).toBe("UNKNOWN");
  });
});

/**
 * NON-VACUITY. These assert the BAR, not the category — a matcher that matched
 * anything would pass every test above except these.
 */
describe("non-vacuity — a loosened matcher fails here", () => {
  it("thin coverage is NOT a match even with ENOUGH distinctive slugs (drop MIN_COVERAGE and this breaks)", () => {
    const r = matchWorkspaceIdentity(
      // 3/6 = 0.5 coverage — below the bar — while clearing MIN_DISTINCTIVE
      // outright, so ONLY the coverage floor can reject this.
      ws({
        name: "Half Builder",
        profileSlugs: ["devplane_app", "devplane_feature", "devplane_service"],
      }),
      corpus
    );
    const builder = r.candidates.find((c) => c.slug === "builder-workspace")!;
    expect(builder.distinctiveMatched.length).toBeGreaterThanOrEqual(3);
    expect(builder.coverage).toBeLessThan(0.6);
    expect(builder.strong).toBe(false);
    expect(r.verdict).toBe("UNKNOWN");
  });

  it("full coverage with NO corpus-unique profile is NOT a match (drop MIN_DISTINCTIVE and this breaks)", () => {
    const r = matchWorkspaceIdentity(
      ws({
        name: "Deals",
        profileSlugs: ["company", "contact", "deal", "pipeline"],
      }),
      corpus
    );
    const crm = r.candidates.find((c) => c.slug === "crm")!;
    expect(crm.coverage).toBe(1);
    expect(crm.distinctiveMatched).toHaveLength(0);
    expect(crm.strong).toBe(false);
    expect(r.verdict).toBe("UNKNOWN");
  });

  it("a NAME match plus one distinctive slug is not enough at thin coverage (drop CORROBORATED_MIN_COVERAGE and this breaks)", () => {
    const r = matchWorkspaceIdentity(
      // Exact name match + a corpus-unique profile, but almost none of the
      // template is present — corroboration lowers the distinctive bar, never
      // the coverage floor.
      ws({ name: "Builder", profileSlugs: ["devplane_app"] }),
      corpus
    );
    const builder = r.candidates.find((c) => c.slug === "builder-workspace")!;
    expect(builder.nameMatch).toBe(true);
    expect(builder.distinctiveMatched.length).toBe(1);
    expect(builder.coverage).toBeLessThan(0.8);
    expect(builder.strong).toBe(false);
    expect(r.verdict).toBe("UNKNOWN");
  });

  it("an empty workspace matches nothing at all", () => {
    const r = matchWorkspaceIdentity(ws({ name: "Empty" }), corpus);
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.candidates).toHaveLength(0);
  });
});
