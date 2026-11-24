/**
 * Which projects a question is about (ticket 8e2c7018): the lens, then each
 * semantic hit of a reserved project kind, through the write paths' own
 * `isReservedProfileSlug` (no second list of slugs). The read itself is the
 * find door's floor and is exercised by the twin's PGlite test in diagnose.
 */
import { describe, it, expect } from "vitest";
import { projectIdsForAsk } from "./project-lane.js";

describe("projectIdsForAsk", () => {
  it("takes the lens, then project-kind hits, once each; other kinds never", () => {
    expect(
      projectIdsForAsk("p-lens", [
        { id: "p-twin", type: "project" },
        { id: "p-lens", type: "project" },
        { id: "n1", type: "note" },
        { id: "p-plural", type: "Projects " },
        { type: "project" },
      ])
    ).toEqual(["p-lens", "p-twin", "p-plural"]);
  });

  it("no lens and no project hit reads nothing", () => {
    expect(projectIdsForAsk(null, [{ id: "n1", type: "note" }])).toEqual([]);
  });
});
