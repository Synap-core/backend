import { describe, expect, it } from "vitest";
import { mergeText3 } from "./merge.js";

const lines = (...l: string[]) => l.join("\n");

describe("mergeText3: a line-level 3-way merge", () => {
  it("takes the only side that changed", () => {
    const base = lines("a", "b", "c");
    const edit = lines("a", "B", "c");
    expect(mergeText3(base, base, edit)).toEqual({
      merged: edit,
      conflicts: [],
    });
    expect(mergeText3(base, edit, base)).toEqual({
      merged: edit,
      conflicts: [],
    });
  });

  it("combines edits of different lines", () => {
    const r = mergeText3(
      lines("a", "b", "c", "d", "e"),
      lines("a", "B", "c", "d", "e"),
      lines("a", "b", "c", "D", "e")
    );
    expect(r).toEqual({
      merged: lines("a", "B", "c", "D", "e"),
      conflicts: [],
    });
  });

  it("combines insertions at both ends", () => {
    const r = mergeText3(
      lines("a", "b"),
      lines("a", "b", "mine"),
      lines("theirs", "a", "b")
    );
    expect(r.merged).toBe(lines("theirs", "a", "b", "mine"));
  });

  it("an identical change on both sides is taken once", () => {
    const r = mergeText3(
      lines("a", "b", "c"),
      lines("a", "new", "b", "c"),
      lines("a", "new", "b", "C")
    );
    expect(r).toEqual({ merged: lines("a", "new", "b", "C"), conflicts: [] });
  });

  it("two different edits of one line conflict, and nothing is merged", () => {
    const r = mergeText3(
      lines("a", "b", "c"),
      lines("a", "X", "c"),
      lines("a", "Y", "c")
    );
    expect(r.merged).toBeNull();
    expect(r.conflicts).toEqual([
      { baseLine: 1, base: "b", ours: "X", theirs: "Y" },
    ]);
  });

  it("edits that abut each other are one region: they conflict", () => {
    const r = mergeText3(
      lines("a", "b", "c", "d"),
      lines("a", "B", "c", "d"),
      lines("a", "b", "C", "d")
    );
    expect(r.merged).toBeNull();
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ base: lines("b", "c") });
  });

  it("a deletion on one side and an edit of the same line conflict", () => {
    const r = mergeText3(
      lines("a", "b", "c"),
      lines("a", "c"),
      lines("a", "B", "c")
    );
    expect(r.merged).toBeNull();
  });
});
