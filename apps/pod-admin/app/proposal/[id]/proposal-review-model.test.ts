import { describe, expect, it } from "vitest";
import {
  approveConsequence,
  fieldChangeRows,
  governanceMark,
  initials,
} from "./proposal-review-model";

describe("fieldChangeRows", () => {
  it("reads a kind change as Kind: Finding → Issue, never ProfileSlug", () => {
    expect(
      fieldChangeRows([
        {
          path: "profileSlug",
          label: "ProfileSlug",
          operation: "update",
          before: "finding",
          after: "issue",
          drift: "unchanged",
        },
      ])
    ).toEqual([
      {
        key: "profileSlug",
        label: "Kind",
        op: "change",
        before: "Finding",
        after: "Issue",
        stale: false,
      },
    ]);
  });

  it("an added field draws no before; a removed one draws no after", () => {
    const [added, removed] = fieldChangeRows([
      { path: "title", label: "Title", operation: "set", after: "Hello" },
      { path: "note", label: "Note", operation: "delete", before: "Bye" },
    ]);
    expect(added).toMatchObject({
      op: "add",
      before: undefined,
      after: "Hello",
    });
    expect(removed).toMatchObject({
      op: "remove",
      before: "Bye",
      after: undefined,
    });
  });

  it("a field edited since it was proposed is marked stale", () => {
    const [row] = fieldChangeRows([
      {
        path: "title",
        label: "Title",
        operation: "update",
        before: "A",
        after: "B",
        drift: "changed_since",
      },
    ]);
    expect(row!.stale).toBe(true);
  });

  it("no diff from the pod draws no rows", () => {
    expect(fieldChangeRows(undefined)).toEqual([]);
    expect(fieldChangeRows(null)).toEqual([]);
  });
});

describe("governanceMark", () => {
  it("a floor code always asks a person", () => {
    expect(governanceMark("SCOPE_IDENTITY_CHANGE")).toEqual({
      tone: "warning",
      label: "Always asks a person",
    });
  });

  it("an ambiguous code fails closed, like the ladder", () => {
    expect(governanceMark("CHANNEL_PROPOSE")?.label).toBe(
      "Always asks a person"
    );
  });

  it("a rule code and the default read as such", () => {
    expect(governanceMark("GOVERNANCE_RULE")?.label).toBe("Your rule");
    expect(governanceMark("WRITES_REQUIRE_PROPOSAL")?.label).toBe(
      "Asks by default"
    );
  });

  it("an unknown or absent code draws no mark", () => {
    expect(governanceMark("toString")).toBeNull();
    expect(governanceMark(null)).toBeNull();
  });
});

describe("approveConsequence", () => {
  it("says undoable only on the pod's own answer", () => {
    expect(approveConsequence(true).mark?.label).toBe("Can be undone");
    expect(approveConsequence(false).mark?.label).toBe("Can't be undone");
    expect(approveConsequence(undefined).mark).toBeNull();
  });
});

describe("initials", () => {
  it("first and last word, or the first two letters of one", () => {
    expect(initials("Ada King Lovelace")).toBe("AL");
    expect(initials("claude")).toBe("CL");
    expect(initials("  ")).toBe("?");
  });
});
