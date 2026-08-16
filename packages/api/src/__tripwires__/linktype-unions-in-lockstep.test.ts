import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `LinkType` is declared TWICE and the two copies must stay identical.
 *
 * `packages/database/src/schema/links.ts` owns the storage union;
 * `packages/playbooks/src/index.ts` re-declares it for the domain layer, and its
 * own comment claims the two are "in lock-step".
 *
 * They were not. `provides_credential` shipped in the schema union and never
 * reached the playbooks copy — so the domain layer's type simply did not know
 * about an edge the database happily stores. Nothing failed: both files
 * typecheck perfectly in isolation, which is exactly why a duplicated union
 * drifts silently.
 *
 * That is this repo's most repeated defect — a vocabulary declared in two places
 * where only one gets updated. It has now bitten three times in a single day
 * (an event-pattern constant, a run flow-type enum, and this). The structural
 * fix is a test that compares the two declarations, because no compiler can.
 *
 * Parsed from source rather than imported: these are TYPE-only unions, erased
 * at runtime, so there is nothing to import and compare.
 */

/** `src/__tripwires__` → `src` → `api` → `packages`. */
const PACKAGES = join(__dirname, "..", "..", "..");

const SOURCES = {
  schema: join(PACKAGES, "database", "src", "schema", "links.ts"),
  domain: join(PACKAGES, "playbooks", "src", "index.ts"),
} as const;

/**
 * Members of an `export type X = "a" | "b" | …;` union.
 *
 * Comments are stripped from the WHOLE FILE before the union is located, not
 * from the captured body afterwards. That ordering matters: these unions carry
 * long explanatory comments between members, and a comment containing a
 * semicolon (`The UI says "forked from"; it never draws a graph.`) terminates a
 * non-greedy `…;` capture early — the parser then reads prose as members and
 * reports a drift that does not exist. Normalise first, match second.
 */
function unionMembers(file: string, typeName: string): string[] {
  const src = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const decl = new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`).exec(
    src
  );
  expect(
    decl,
    `could not find \`export type ${typeName}\` in ${file}`
  ).not.toBeNull();
  return [...decl![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
}

describe("tripwire: the two LinkType unions stay in lock-step", () => {
  it("parses a non-trivial member list from both files", () => {
    // Guards the guard: a regex matching nothing would make the comparison
    // below vacuously pass.
    expect(unionMembers(SOURCES.schema, "LinkType").length).toBeGreaterThan(10);
    expect(unionMembers(SOURCES.domain, "LinkType").length).toBeGreaterThan(10);
  });

  it("declares exactly the same members in both places", () => {
    const schema = unionMembers(SOURCES.schema, "LinkType");
    const domain = unionMembers(SOURCES.domain, "LinkType");

    const missingFromDomain = schema.filter((m) => !domain.includes(m));
    const missingFromSchema = domain.filter((m) => !schema.includes(m));

    expect(
      { missingFromDomain, missingFromSchema },
      "LinkType drifted. Add the member to BOTH database/src/schema/links.ts and playbooks/src/index.ts in the same change — the compiler cannot catch this."
    ).toEqual({ missingFromDomain: [], missingFromSchema: [] });
  });

  it("carries the session-lineage edge and no merge twin", () => {
    const schema = unionMembers(SOURCES.schema, "LinkType");
    expect(schema).toContain("spawned_from");
    // Asserting an ABSENCE on purpose: work units are never merged. The shipped
    // pattern elsewhere is a coordinator with siblings, where fan-in is a
    // summary. If a `merged_into` ever appears, it should be a deliberate
    // decision that deletes this line, not an accident.
    expect(schema).not.toContain("merged_into");
  });
});
