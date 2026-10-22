/**
 * `buildImportTitle` — the import proposal's title, counted by kind through
 * the vocabulary door. Rows chosen to rule out wrong rules:
 *  - curated plurals ("people", "companies"), never "persons"/"companys";
 *  - singular at exactly 1 ("1 company");
 *  - en-US grouping ("1,489");
 *  - an op that links an EXISTING entity is not counted as created;
 *  - past three kinds the rest is folded and counted, never dropped;
 *  - one file names it, several are counted, none is omitted.
 */
import { describe, it, expect } from "vitest";
import { buildImportTitle, type ImportTitleOperation } from "./import-title.js";

const ents = (kind: string, n: number): ImportTitleOperation[] =>
  Array.from({ length: n }, () => ({ op: "create_entity", profileSlug: kind }));
const rels = (n: number): ImportTitleOperation[] =>
  Array.from({ length: n }, () => ({ op: "create_relation" }));

describe("buildImportTitle", () => {
  it("names the live contacts import by its counts", () => {
    expect(
      buildImportTitle(
        [...ents("person", 1489), ...ents("company", 1338), ...rels(1462)],
        ["Connections.csv"]
      )
    ).toBe(
      "Import 1,489 people, 1,338 companies and 1,462 links from Connections.csv"
    );
  });

  it("is singular at one and skips an entity it only links", () => {
    expect(
      buildImportTitle(
        [
          ...ents("person", 1),
          ...ents("company", 1),
          {
            op: "create_entity",
            profileSlug: "company",
            existingEntityId: "x",
          },
          ...rels(1),
        ],
        ["a/b/c.csv"]
      )
    ).toBe("Import 1 person, 1 company and 1 link from c.csv");
  });

  it("folds kinds past three into a counted remainder and counts files", () => {
    expect(
      buildImportTitle(
        [
          ...ents("note", 5),
          ...ents("task", 4),
          ...ents("person", 3),
          ...ents("company", 2),
          ...ents("event", 1),
        ],
        ["a.md", "b.md"]
      )
    ).toBe("Import 5 notes, 4 tasks, 3 people and 3 other items from 2 files");
  });

  it("with no file and nothing created it still says what it is", () => {
    expect(buildImportTitle([], [])).toBe("Import");
  });
});
