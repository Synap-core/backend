import { describe, it, expect } from "vitest";
import { labelFromOperations, withRemainder } from "./composite-summary.js";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";

/**
 * These pin the THREE live rows that were unreadable on the founder's pod, by
 * their real payload shapes, plus the failure directions that matter.
 *
 * Pure by construction — this file imports the leaf module and the vocabulary
 * door, nothing that reaches config or a database, so it collects in a bare
 * environment. A sibling test lost that property to a single import and could
 * not even load.
 */
describe("composite proposal labels", () => {
  it("names the single created object (row b214b80e)", () => {
    const l = labelFromOperations([
      {
        op: "create_entity",
        profileSlug: "note",
        title: "Research brief (2026-09-07)",
      },
    ]);
    expect(l).toEqual({
      objectKind: "note",
      objectName: "Research brief (2026-09-07)",
      extraCount: 0,
    });
  });

  it("names the first and DISCLOSES the rest (rows a6b10bfb / 122571d0)", () => {
    const l = labelFromOperations([
      {
        op: "create_entity",
        profileSlug: "knowledge",
        title: "Raycast V1 focus lens",
      },
      { op: "create_entity", profileSlug: "person", title: "Antoine Servant" },
      { op: "create_relation", type: "created_by" },
    ]);
    expect(l?.objectKind).toBe("knowledge");
    expect(l?.objectName).toBe("Raycast V1 focus lens");
    // Two further operations exist. Silence about them would be a true
    // sentence that misleads.
    expect(l?.extraCount).toBe(2);
  });

  it("end-to-end: the reviewer sees a readable sentence, not a bare verb", () => {
    const l = labelFromOperations([
      {
        op: "create_entity",
        profileSlug: "note",
        title: "Research brief (2026-09-07)",
      },
    ]);
    const title = withRemainder(
      buildObjectActionTitle({
        action: "create",
        objectKind: l!.objectKind,
        objectName: l!.objectName,
      }),
      l!.extraCount
    );
    expect(title).toBe('Create Note "Research brief (2026-09-07)"');
    // What the same row rendered as before the fallback existed:
    expect(
      buildObjectActionTitle({ action: "create", objectKind: "entity" })
    ).toBe("Create");
  });

  it("returns null rather than inventing a name it cannot justify", () => {
    // A plan of pure relation ops creates no named object. `null` keeps the
    // caller on its existing behaviour instead of fabricating a kind.
    expect(
      labelFromOperations([{ op: "create_relation", type: "created_by" }])
    ).toBeNull();
    expect(labelFromOperations([])).toBeNull();
    expect(labelFromOperations(undefined)).toBeNull();
    expect(labelFromOperations(null)).toBeNull();
    expect(labelFromOperations("not an array")).toBeNull();
    expect(labelFromOperations([null, 42, "x"])).toBeNull();
  });

  it("skips unnamed leading ops to find the one that names a kind", () => {
    const l = labelFromOperations([
      { op: "create_relation" },
      { op: "create_entity", profileSlug: "task", title: "Ship it" },
    ]);
    expect(l?.objectKind).toBe("task");
    expect(l?.objectName).toBe("Ship it");
  });

  it("treats a blank title as absent, never as an empty name", () => {
    const l = labelFromOperations([
      { op: "create_entity", profileSlug: "note", title: "   " },
    ]);
    expect(l?.objectName).toBeUndefined();
    // The vocabulary door then renders the kind alone rather than empty quotes.
    expect(
      buildObjectActionTitle({
        action: "create",
        objectKind: l!.objectKind,
        objectName: l!.objectName,
      })
    ).toBe("Create Note");
  });

  it("withRemainder appends only when there IS a remainder", () => {
    expect(withRemainder("Create Note", 0)).toBe("Create Note");
    expect(withRemainder("Create Note", 1)).toBe("Create Note + 1 more");
    expect(withRemainder("Create Note", 2)).toBe("Create Note + 2 more");
  });
});
