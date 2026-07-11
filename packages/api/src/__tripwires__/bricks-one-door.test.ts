import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — entity + facet WRITES go through their one door.
 *
 * Kind+Facets invariant: `entities` are truth written by exactly the canonical
 * command path, and `entity_facets` are written only through `FacetRepository`
 * (the backend rule: never insert into entity_facets directly). A stray
 * `.insert(entities)` / `.insert(entityFacets)` — or the raw-SQL equivalent —
 * forks the write path and skips the provenance stamping, identity-signal
 * registration, and facet-visibility invariants those doors own.
 *
 * This freezes the door set. The ONLY files permitted to insert entities are
 * `EntityRepository` (the create door) and the sync-materializer (the CQRS
 * push/pull replay path — it materializes remote events, the second legitimate
 * writer). The ONLY files permitted to insert entity_facets are
 * `FacetRepository` (the runtime door) and the conversion engine (the one-shot
 * manifest-driven data cutover, which writes facets in bulk raw SQL by design —
 * a migration, not a runtime write).
 *
 * If this fails: route your write through EntityRepository.create /
 * FacetRepository.attach — do NOT add your file to the allowlist.
 *
 * SCOPE: scans every `packages/<pkg>/src` in the backend monorepo (the data
 * layer and its callers), skipping tests / .d.ts / dist. Manual dev scripts
 * (a package's `scripts/` dir) are out of scope — they are not runtime writers.
 */

// cwd is packages/api; the backend repo root is two levels up.
const REPO_ROOT = join(process.cwd(), "..", "..");
const PACKAGES = join(REPO_ROOT, "packages");

function tsFilesUnderSrc(pkgRoot: string, acc: string[]): void {
  let src: string;
  try {
    src = join(pkgRoot, "src");
    readdirSync(src);
  } catch {
    return; // package has no src/
  }
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      )
        acc.push(p);
    }
  };
  walk(src);
}

function allBackendSrcFiles(): string[] {
  const acc: string[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    tsFilesUnderSrc(join(PACKAGES, pkg.name), acc);
  }
  return acc;
}

/** Files that match `pattern`, as repo-root-relative paths, minus the allowlist. */
function offenders(pattern: RegExp, allowlist: Set<string>): string[] {
  return allBackendSrcFiles()
    .filter((f) => pattern.test(readFileSync(f, "utf8")))
    .map((f) => relative(REPO_ROOT, f))
    .filter((rel) => !allowlist.has(rel));
}

describe("tripwire: entity + facet writes have one door", () => {
  it("no file inserts entities outside EntityRepository + the sync-materializer", () => {
    const ENTITY_INSERT = /\.insert\(\s*entities\s*\)|insert\s+into\s+"?entities"?\b/i;
    const ALLOW = new Set<string>([
      "packages/database/src/repositories/entity-repository.ts", // the create door
      "packages/database/src/utils/sync-materializer.ts", // CQRS push/pull replay
    ]);
    expect(offenders(ENTITY_INSERT, ALLOW)).toEqual([]);
  });

  it("no file inserts entity_facets outside FacetRepository + the conversion engine", () => {
    const FACET_INSERT =
      /\.insert\(\s*entityFacets\s*\)|insert\s+into\s+"?entity_facets"?\b/i;
    const ALLOW = new Set<string>([
      "packages/database/src/repositories/facet-repository.ts", // the runtime door
      "packages/database/src/conversions/engine.ts", // one-shot manifest cutover
    ]);
    expect(offenders(FACET_INSERT, ALLOW)).toEqual([]);
  });
});
