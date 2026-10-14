import { describe, it, expect } from "vitest";
import { IMPORT_LIMITS, type ImportGroup } from "@synap-core/types/imports";
import {
  applyImportCurateOps,
  deriveImportPhase,
  ImportCurateError,
  type CurateState,
} from "../curate.js";
import { mergeGroupProposals, parseGroupingAnswer } from "../group.js";

const g = (key: string, over: Partial<ImportGroup> = {}): ImportGroup => ({
  key,
  name: key,
  origin: "ai",
  outputs: ["things"],
  ...over,
});

function state(): CurateState {
  return {
    groups: [g("films", { note: "watch list" }), g("books")],
    items: new Map([
      ["a", { decision: "keep", groupKeys: ["films"] }],
      ["b", { decision: "keep", groupKeys: ["films", "books"] }],
      ["c", { decision: "keep", groupKeys: [] }],
    ]),
  };
}

describe("applyImportCurateOps", () => {
  it("merges a group into another: members move, no duplicate key, note kept", () => {
    const { state: s, changedItemIds } = applyImportCurateOps(state(), [
      { op: "mergeGroups", fromKey: "books", intoKey: "films" },
    ]);
    expect(s.groups.map((x) => x.key)).toEqual(["films"]);
    expect(s.items.get("b")!.groupKeys).toEqual(["films"]);
    expect([...changedItemIds]).toEqual(["b"]);
  });

  it("deleting a group frees its items and never touches the input", () => {
    const input = state();
    const { state: s } = applyImportCurateOps(input, [
      { op: "deleteGroup", groupKey: "films" },
    ]);
    expect(s.items.get("a")!.groupKeys).toEqual([]);
    expect(input.items.get("a")!.groupKeys).toEqual(["films"]);
  });

  it("refuses an unknown item, an over-long note and a group past the cap", () => {
    expect(() =>
      applyImportCurateOps(state(), [
        { op: "setDecision", itemIds: ["zz"], decision: "later" },
      ])
    ).toThrow(ImportCurateError);
    expect(() =>
      applyImportCurateOps(state(), [
        {
          op: "setGroupNote",
          groupKey: "films",
          note: "x".repeat(IMPORT_LIMITS.groupNoteMax + 1),
        },
      ])
    ).toThrow(/at most/);
    const full: CurateState = {
      groups: Array.from({ length: IMPORT_LIMITS.groupsMax }, (_, i) =>
        g(`g${i}`)
      ),
      items: new Map(),
    };
    expect(() =>
      applyImportCurateOps(full, [{ op: "createGroup", name: "One more" }])
    ).toThrow(/at most/);
  });

  it("an empty note clears it", () => {
    const { state: s } = applyImportCurateOps(state(), [
      { op: "setGroupNote", groupKey: "films", note: "   " },
    ]);
    expect(s.groups[0]!.note).toBeUndefined();
  });
});

describe("deriveImportPhase", () => {
  it("is done only when every group WITH members was built", () => {
    const s = state();
    expect(deriveImportPhase([], new Map())).toBe("collecting");
    expect(deriveImportPhase(s.groups, s.items)).toBe("curating");
    const oneBuilt = [g("films", { builtAt: "t" }), g("books")];
    expect(deriveImportPhase(oneBuilt, s.items)).toBe("building");
    const emptyUnbuilt = [
      g("films", { builtAt: "t" }),
      g("books", { builtAt: "t" }),
      g("empty"),
    ];
    expect(deriveImportPhase(emptyUnbuilt, s.items)).toBe("done");
  });
});

describe("parseGroupingAnswer / mergeGroupProposals", () => {
  const items = ["a", "b"].map((id) => ({
    id,
    title: id,
    source: { kind: "url" as const },
    contentStatus: "readable" as const,
    decision: "keep" as const,
    groupKeys: [],
    stagedAt: "",
  }));

  it("drops indices it never showed and groups with no items", () => {
    const parsed = parseGroupingAnswer(
      {
        groups: [
          { name: "X", items: [0, 7, -1, "1"] },
          { name: "Empty", items: [9] },
          { items: [0] },
        ],
      },
      items
    );
    expect(parsed).toEqual([{ name: "X", kind: "other", itemIds: ["a"] }]);
    expect(parseGroupingAnswer("nonsense", items)).toEqual([]);
  });

  it("regrouping keeps the person's groups and replaces untouched AI ones", () => {
    const merged = mergeGroupProposals({
      groups: [
        g("mine", { origin: "user" }),
        g("old-ai"),
        g("noted", { note: "keep me" }),
      ],
      items: new Map([
        ["a", { decision: "keep", groupKeys: ["mine", "old-ai"] }],
        ["b", { decision: "keep", groupKeys: ["old-ai"] }],
      ]),
      proposals: [{ name: "Fresh", kind: "films", itemIds: ["b"] }],
      origin: "ai",
    });
    expect(merged.groups.map((x) => x.key)).toEqual(["mine", "noted", "fresh"]);
    expect(merged.items.get("a")!.groupKeys).toEqual(["mine"]);
    expect(merged.items.get("b")!.groupKeys).toEqual(["fresh"]);
  });
});
