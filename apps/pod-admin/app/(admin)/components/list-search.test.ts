import { describe, expect, it } from "vitest";
import { filterBySearch } from "./list-search";

const rows = [
  { name: "Café opening", space: "Ops" },
  { name: "Weekly digest", space: "Content" },
  { name: "Digest of leads", space: "CRM" },
];
const text = (r: (typeof rows)[number]) => [r.name, r.space];

describe("filterBySearch", () => {
  it("keeps everything for an empty or blank query", () => {
    expect(filterBySearch(rows, "", text)).toEqual(rows);
    expect(filterBySearch(rows, "   ", text)).toEqual(rows);
  });

  it("ignores case and accents", () => {
    expect(filterBySearch(rows, "CAFE", text)).toEqual([rows[0]]);
  });

  it("needs every word, in any order, across the fields", () => {
    expect(filterBySearch(rows, "digest crm", text)).toEqual([rows[2]]);
    expect(filterBySearch(rows, "leads digest", text)).toEqual([rows[2]]);
  });

  it("returns nothing when no row matches", () => {
    expect(filterBySearch(rows, "zzz", text)).toEqual([]);
  });

  it("skips empty fields without matching the word 'null'", () => {
    expect(filterBySearch([{ n: null }], "null", (r) => [r.n])).toEqual([]);
  });
});
