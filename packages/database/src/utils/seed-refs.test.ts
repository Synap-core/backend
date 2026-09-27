/**
 * The ONE seed ref ladder (RV1 S6). Templates write relation refs as the
 * seed's bare TITLE; the fresh-create loop resolved `kind:title` only, so every
 * such edge was dropped on a fresh install while the overlay door
 * (`applyDefinitionSeeds`) landed it.
 *
 * LIMITATION (stated, measured): the fresh-create door itself needs a live
 * Postgres to drive (`__tests__/reconcile-workspace-from-definition.test.ts`),
 * which this environment does not have. The second block is therefore a SEAM
 * scan of `create-workspace-from-definition.ts` — it proves the relation map is
 * fed through the shared ladder on BOTH the create and the resume branch, not
 * that the edge row is inserted.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seedRefAliasIndex } from "./seed-refs.js";

describe("seedRefAliasIndex", () => {
  const seeds = [
    { profileSlug: "question", title: "Who pays?" },
    { profileSlug: "hypothesis", title: "SMBs pay", refKey: "h1" },
    { profileSlug: "note", title: "Dup" },
    { profileSlug: "task", title: "Dup" },
  ];
  const aliasesFor = seedRefAliasIndex(seeds);

  it("a unique bare title resolves (what templates write)", () => {
    expect(aliasesFor(seeds[0]!)).toEqual(["question:Who pays?", "Who pays?"]);
  });

  it("refKey and kind:title still resolve", () => {
    expect(aliasesFor(seeds[1]!)).toEqual([
      "h1",
      "hypothesis:SMBs pay",
      "SMBs pay",
    ]);
  });

  it("an AMBIGUOUS title never binds (kind:title only)", () => {
    expect(aliasesFor(seeds[2]!)).toEqual(["note:Dup"]);
    expect(aliasesFor(seeds[3]!)).toEqual(["task:Dup"]);
  });
});

describe("seam: fresh create feeds the relation map through the shared ladder", () => {
  const src = readFileSync(
    join(__dirname, "create-workspace-from-definition.ts"),
    "utf8"
  );
  it("the ladder is built from the definition's seeds", () => {
    expect(src).toMatch(
      /seedRefAliasIndex\(\s*definition\.suggestedEntities \?\? \[\]\s*\)/
    );
  });
  it("the create branch AND the resume branch register every alias", () => {
    const uses = src.match(
      /for \(const k of seedAliasesFor\(\w+\)\) entityRefMap\[k\] = \w+;/g
    );
    expect(uses ?? []).toHaveLength(2);
  });
});
