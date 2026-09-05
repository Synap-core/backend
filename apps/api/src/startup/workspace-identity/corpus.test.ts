/**
 * The matcher against the REAL bundled corpus, driven by FIXTURES — never the
 * pod. Each fixture is a workspace observation shaped like one of the live
 * orphans; the assertions pin what the diagnostic would say about it.
 */

import { describe, it, expect } from "vitest";
import {
  buildTemplateFingerprints,
  existingTemplateIdentity,
  matchWorkspaceIdentity,
  type WorkspaceObservation,
} from "./fingerprint.js";
import { bundledTemplateFingerprints } from "./corpus.js";

const corpus = buildTemplateFingerprints(bundledTemplateFingerprints());

const ws = (o: Partial<WorkspaceObservation>): WorkspaceObservation => ({
  id: "00000000-0000-0000-0000-0000000000ff",
  name: "Untitled",
  profileSlugs: [],
  ...o,
});

describe("bundled corpus", () => {
  it("excludes zero-profile templates (base is an overlay, not an identity)", () => {
    expect(corpus.fingerprints.map((f) => f.slug)).not.toContain("base");
    expect(corpus.fingerprints.length).toBeGreaterThan(20);
  });

  it("keys candidates by meta.slug and carries the template's own subtype separately", () => {
    const builder = corpus.fingerprints.find(
      (f) => f.slug === "builder-workspace"
    )!;
    expect(builder.subtype).toBe("builder");
  });

  it("devplane_* is corpus-unique — the near-unique signal the primary evidence relies on", () => {
    expect(corpus.distinctiveSlugs.has("devplane_app")).toBe(true);
    expect(corpus.distinctiveSlugs.has("devplane_deployment")).toBe(true);
  });
});

describe("fixture: the live Builder workspace (901 entities, devplane_* profiles)", () => {
  // A realistic PARTIAL binding — a live workspace rarely holds every profile
  // its template declares, which is exactly why the bar is coverage-based and
  // not equality-based.
  const builderish = ws({
    name: "Builder",
    entityCount: 901,
    profileSlugs: [
      "devplane_app",
      "devplane_feature",
      "devplane_story",
      "devplane_service",
      "devplane_package",
      "devplane_environment",
      "devplane_deployment",
      "devplane_recipe",
      "devplane_decision_record",
      "devplane_incident",
      "devplane_cron",
      "devplane_agent_run",
      "devplane_best_practice",
      "devplane_codebase_map",
      "devplane_system_component",
      "devplane_workflow",
      "devplane_capability",
      "deployment_target",
      "project",
      "task",
      "skill",
      "provider",
      // Noise a real workspace also carries.
      "note",
      "person",
    ],
  });

  it("is identified UNAMBIGUOUSLY as builder-workspace", () => {
    const r = matchWorkspaceIdentity(builderish, corpus);
    expect(r.verdict).toBe("UNAMBIGUOUS");
    expect(r.match?.slug).toBe("builder-workspace");
  });

  it("stamps the SLUG as packageSlug and the template's own subtype separately", () => {
    const r = matchWorkspaceIdentity(builderish, corpus);
    // The distinction that makes the stamp resolvable: `resolveWorkspaceTemplate`
    // and `cp_catalog_cache` are keyed by "builder-workspace", never "builder".
    expect(r.match).toEqual({ slug: "builder-workspace", subtype: "builder" });
  });
});

describe("fixture: workspaces that must NOT be stamped", () => {
  it("a bare CRM-shaped workspace is not stamped — crm has no corpus-unique profile", () => {
    const r = matchWorkspaceIdentity(
      ws({ name: "Sales", profileSlugs: ["company", "contact", "deal"] }),
      corpus
    );
    expect(r.match).toBeUndefined();
  });

  it("a generic personal workspace is UNKNOWN", () => {
    const r = matchWorkspaceIdentity(
      ws({ name: "Personal", profileSlugs: ["note", "task"] }),
      corpus
    );
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.match).toBeUndefined();
  });

  it("pod-admin is never stamped", () => {
    const r = matchWorkspaceIdentity(
      ws({
        name: "Pod Admin",
        systemSlug: "pod-admin",
        profileSlugs: ["task"],
      }),
      corpus
    );
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.match).toBeUndefined();
  });

  it("a handful of devplane profiles is NOT enough — coverage floor, not signal count", () => {
    const r = matchWorkspaceIdentity(
      // 3 corpus-unique slugs (clears MIN_DISTINCTIVE) but 3/25 coverage.
      ws({
        name: "Scratch",
        profileSlugs: ["devplane_app", "devplane_cron", "devplane_incident"],
      }),
      corpus
    );
    const builder = r.candidates.find((c) => c.slug === "builder-workspace")!;
    expect(builder.distinctiveMatched.length).toBeGreaterThanOrEqual(3);
    expect(builder.strong).toBe(false);
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

  it("an empty workspace is UNKNOWN with zero candidates", () => {
    const r = matchWorkspaceIdentity(ws({ name: "New workspace" }), corpus);
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.candidates).toHaveLength(0);
  });
});

describe("never-overwrite / idempotency guard", () => {
  it("skips a workspace already carrying settings.packageSlug", () => {
    expect(existingTemplateIdentity({ settings: { packageSlug: "crm" } })).toBe(
      "crm"
    );
  });

  it("skips one carrying only the promoted package_slug column", () => {
    expect(existingTemplateIdentity({ packageSlug: "foundation" })).toBe(
      "foundation"
    );
  });

  it("skips one carrying only settings.workspaceSubtype", () => {
    expect(
      existingTemplateIdentity({ settings: { workspaceSubtype: "builder" } })
    ).toBe("builder");
  });

  it("returns undefined for a true orphan — the only shape the backfill scores", () => {
    expect(existingTemplateIdentity({ settings: {} })).toBeUndefined();
    expect(existingTemplateIdentity({ settings: null })).toBeUndefined();
    expect(existingTemplateIdentity({})).toBeUndefined();
  });

  it("a stamped row fails the predicate — so a SECOND run scores and writes nothing", () => {
    const orphan = {
      settings: {} as Record<string, string>,
      packageSlug: null,
    };
    expect(existingTemplateIdentity(orphan)).toBeUndefined();
    // What run 1 writes (mergeSettings dual-writes JSONB + the column):
    const afterRun1 = {
      settings: {
        packageSlug: "builder-workspace",
        workspaceSubtype: "builder",
      },
      packageSlug: "builder-workspace",
    };
    expect(existingTemplateIdentity(afterRun1)).toBe("builder-workspace");
  });
});
