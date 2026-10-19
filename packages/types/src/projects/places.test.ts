import { describe, it, expect } from "vitest";
import {
  ALL_PROJECTS,
  NOT_IN_A_PROJECT,
  isPlaceProject,
  isStalePlaceLens,
  placeProjects,
} from "./places.js";

describe("place words", () => {
  it("names the two places that are no project", () => {
    expect(ALL_PROJECTS).toBe("All projects");
    expect(NOT_IN_A_PROJECT).toBe("Unfiled");
  });
});

describe("isPlaceProject", () => {
  it("an active project is a place; completed and archived ones are not", () => {
    expect(isPlaceProject({ status: "active" })).toBe(true);
    expect(isPlaceProject({ status: "completed" })).toBe(false);
    expect(isPlaceProject({ status: "archived" })).toBe(false);
    expect(isPlaceProject({ status: null })).toBe(false);
    expect(isPlaceProject({})).toBe(false);
  });
});

describe("placeProjects", () => {
  it("keeps the places only, oldest first, ties by id", () => {
    const rows = [
      { id: "new", status: "active", createdAt: "2026-10-03T00:00:00Z" },
      { id: "done", status: "completed", createdAt: "2026-10-01T00:00:00Z" },
      { id: "b", status: "active", createdAt: "2026-10-02T00:00:00Z" },
      { id: "a", status: "active", createdAt: "2026-10-02T00:00:00Z" },
      { id: "old", status: "active", createdAt: new Date("2026-09-01") },
      { id: "gone", status: "archived", createdAt: "2026-08-01T00:00:00Z" },
      { id: "undated", status: "active" },
    ];
    expect(placeProjects(rows).map((r) => r.id)).toEqual([
      "old",
      "a",
      "b",
      "new",
      "undated",
    ]);
  });
});

describe("isStalePlaceLens", () => {
  const rows = [
    { id: "live", status: "active" },
    { id: "done", status: "completed" },
    { id: "shelved", status: "archived" },
  ];
  const ok = { settled: true, mayBeCut: false };

  it("a settled read proves a completed, archived or missing project stale", () => {
    expect(isStalePlaceLens("live", rows, ok)).toBe(false);
    expect(isStalePlaceLens("done", rows, ok)).toBe(true);
    expect(isStalePlaceLens("shelved", rows, ok)).toBe(true);
    expect(isStalePlaceLens("missing", rows, ok)).toBe(true);
  });

  it("a read in flight or failed proves nothing", () => {
    const unsettled = { settled: false, mayBeCut: false };
    expect(isStalePlaceLens("shelved", rows, unsettled)).toBe(false);
    expect(isStalePlaceLens("missing", [], unsettled)).toBe(false);
  });

  it("a cut list proves nothing about a missing project, but a listed one still counts", () => {
    const cut = { settled: true, mayBeCut: true };
    expect(isStalePlaceLens("missing", rows, cut)).toBe(false);
    expect(isStalePlaceLens("shelved", rows, cut)).toBe(true);
  });
});
