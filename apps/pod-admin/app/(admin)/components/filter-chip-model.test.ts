import { describe, expect, it } from "vitest";
import {
  FILTER_ALL_KEY,
  filterChipFace,
  filterMenuItems,
  filterSelectedKeys,
  filterSelectionFromKeys,
  writeFilterParam,
  type FilterOption,
} from "./filter-chip-model";

const OPTIONS: FilterOption[] = [
  { id: "active", label: "Active", count: 4 },
  { id: "failing", label: "Failing", count: 2 },
  { id: "paused", label: "Paused", count: null },
];

describe("filterChipFace", () => {
  it("unset: the neutral word, the All count when measured, not set", () => {
    expect(
      filterChipFace({
        options: OPTIONS,
        selected: [],
        allLabel: "All rules",
        allCount: 6,
      })
    ).toEqual({ text: "All rules", count: 6, isSet: false, mark: null });
  });

  it("an unmeasured count shows no number, never 0", () => {
    expect(
      filterChipFace({ options: OPTIONS, selected: [], allLabel: "All" }).count
    ).toBeNull();
    expect(
      filterChipFace({
        options: OPTIONS,
        selected: ["paused"],
        allLabel: "All",
      }).count
    ).toBeNull();
  });

  it("one value: its label and count, set", () => {
    expect(
      filterChipFace({
        options: OPTIONS,
        selected: ["failing"],
        allLabel: "All",
      })
    ).toEqual({ text: "Failing", count: 2, isSet: true, mark: null });
  });

  it("a filter with no All is not 'set' on its default value", () => {
    const face = filterChipFace({
      options: OPTIONS,
      selected: ["active"],
      allLabel: null,
      defaultSelected: ["active"],
    });
    expect(face).toEqual({
      text: "Active",
      count: 4,
      isSet: false,
      mark: null,
    });
    expect(
      filterChipFace({
        options: OPTIONS,
        selected: ["failing"],
        allLabel: null,
        defaultSelected: ["active"],
      }).isSet
    ).toBe(true);
  });

  it("a value the options no longer list still shows, never as All", () => {
    const face = filterChipFace({
      options: OPTIONS,
      selected: ["gone"],
      allLabel: "All",
    });
    expect(face.text).toBe("gone");
    expect(face.isSet).toBe(true);
  });

  it("several values: 'n selected', counts summed only when all measured", () => {
    expect(
      filterChipFace({
        options: OPTIONS,
        selected: ["active", "failing"],
        allLabel: "All",
      })
    ).toEqual({ text: "2 selected", count: 6, isSet: true, mark: null });
    expect(
      filterChipFace({
        options: OPTIONS,
        selected: ["active", "paused"],
        allLabel: "All",
      }).count
    ).toBeNull();
  });

  it("showCount off draws no number", () => {
    expect(
      filterChipFace({
        options: OPTIONS,
        selected: ["active"],
        allLabel: "All",
        showCount: false,
      }).count
    ).toBeNull();
  });
});

describe("filterMenuItems", () => {
  it("a single filter leads with its All item", () => {
    const items = filterMenuItems({
      options: OPTIONS,
      mode: "single",
      allLabel: "All rules",
      allCount: 6,
    });
    expect(items.map((i) => i.id)).toEqual([
      FILTER_ALL_KEY,
      "active",
      "failing",
      "paused",
    ]);
    expect(items[0]).toMatchObject({ label: "All rules", count: 6 });
    expect(items[3]!.count).toBeNull();
  });

  it("no All item for a filter without one, nor for a multiple filter", () => {
    for (const input of [
      { mode: "single" as const, allLabel: null },
      { mode: "multiple" as const, allLabel: "All" },
    ])
      expect(
        filterMenuItems({ options: OPTIONS, ...input }).map((i) => i.id)
      ).toEqual(["active", "failing", "paused"]);
  });
});

describe("selection", () => {
  it("single: the value is checked, or All when nothing is chosen", () => {
    expect(filterSelectedKeys("single", ["failing"])).toEqual(["failing"]);
    expect(filterSelectedKeys("single", [])).toEqual([FILTER_ALL_KEY]);
    expect(filterSelectedKeys("multiple", [])).toEqual([]);
  });

  it("picking All clears the filter; All is never a value", () => {
    expect(
      filterSelectionFromKeys("single", new Set([FILTER_ALL_KEY]), OPTIONS)
    ).toEqual([]);
    expect(
      filterSelectionFromKeys("single", new Set(["paused"]), OPTIONS)
    ).toEqual(["paused"]);
  });

  it("multiple keeps the options' order, whatever the click order", () => {
    expect(
      filterSelectionFromKeys(
        "multiple",
        new Set(["paused", "active"]),
        OPTIONS
      )
    ).toEqual(["active", "paused"]);
  });
});

describe("writeFilterParam", () => {
  it("the default is the bare address; a pick sets the param and drops ?focus=", () => {
    const p = new URLSearchParams("filter=failing&focus=abc&q=x");
    writeFilterParam(p, "filter", []);
    expect(p.toString()).toBe("q=x");

    const q = new URLSearchParams("focus=abc");
    writeFilterParam(q, "filter", ["failing"]);
    expect(q.toString()).toBe("filter=failing");
  });

  it("a filter with a default value omits the param on it", () => {
    const p = new URLSearchParams("filter=failing");
    writeFilterParam(p, "filter", ["active"], ["active"]);
    expect(p.toString()).toBe("");
  });

  it("several values are comma-joined", () => {
    const p = new URLSearchParams();
    writeFilterParam(p, "kind", ["a", "b"]);
    expect(p.get("kind")).toBe("a,b");
  });
});
