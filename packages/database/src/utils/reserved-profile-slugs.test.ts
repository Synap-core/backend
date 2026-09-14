import { describe, it, expect } from "vitest";
import {
  excludeReservedProfiles,
  isReservedProfileSlug,
} from "./reserved-profile-slugs.js";

/**
 * `excludeReservedProfiles` is the ONE filter every CREATE/CLASSIFY-facing
 * listing door shares (applied inside `ProfileRepository.getAccessibleProfiles`,
 * the read floor `profiles.list` / `synap_list_profiles` / `/discover` /
 * `GET /profiles` all route through). See
 * `packages/api/src/__tripwires__/project-not-advertised-in-listings.test.ts`
 * for the door-coverage side of this guard.
 */
describe("excludeReservedProfiles", () => {
  it("drops a reserved-slug row and keeps ordinary kinds", () => {
    const rows = [
      { slug: "project", displayName: "Project" },
      { slug: "task", displayName: "Task" },
      { slug: "projects", displayName: "Projects (plural near-miss)" },
      { slug: "decision", displayName: "Decision" },
    ];
    const kept = excludeReservedProfiles(rows);
    expect(kept.map((r) => r.slug)).toEqual(["task", "decision"]);
  });

  it("is case/whitespace-insensitive, matching isReservedProfileSlug", () => {
    const rows = [{ slug: "  Project " }, { slug: "PROJECTS" }];
    expect(excludeReservedProfiles(rows)).toEqual([]);
  });

  it("does not over-reach onto near-miss slugs", () => {
    const rows = [
      { slug: "project-note" },
      { slug: "projection" },
      { slug: "subproject" },
    ];
    expect(excludeReservedProfiles(rows)).toEqual(rows);
    for (const r of rows) expect(isReservedProfileSlug(r.slug)).toBe(false);
  });

  it("returns a new array and never mutates the input", () => {
    const rows = [{ slug: "project" }, { slug: "task" }];
    const kept = excludeReservedProfiles(rows);
    expect(kept).not.toBe(rows);
    expect(rows).toHaveLength(2); // input untouched
  });

  it("non-vacuity: the fixture actually contains a reserved row", () => {
    // Guards against a fixture drifting to contain no reserved slug, which
    // would make every assertion above pass vacuously.
    const rows = [{ slug: "project" }, { slug: "task" }];
    expect(rows.some((r) => isReservedProfileSlug(r.slug))).toBe(true);
  });
});
