import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — a lifecycle status is moved through ONE door (work model L2).
 *
 * The lifecycle COLUMNS (`entities.status|status_category`,
 * `entity_facets.status|status_category`) are the truth; `properties[<slug>]`
 * is their READ PROJECTION, written through only by `applyStatusMove`. The
 * repositories refuse a generic write that would move the key
 * (`LifecycleWriteOutsideDoorError`), but a RAW drizzle
 * `.update(entities|entityFacets).set({ properties … })` never meets that
 * guard — it can rewrite the projection and leave the columns behind.
 *
 * So every raw `.set({…})` on those two tables that writes `properties` must
 * be CLASSIFIED below, with the reason it cannot move a status. A new raw
 * writer joins the scan by existing (the file set is DERIVED by walking the
 * three packages) and fails here until someone routes it through the door
 * (`moveStatus` / `applyStatusMove`) or classifies it honestly.
 *
 * WHAT IT CANNOT SEE (measured by reading the scan, stated so nobody assumes
 * more): a `.set(variable)` whose object is built elsewhere, a write through
 * `sql\`UPDATE …\`` text, and a table imported under another alias. Granularity
 * is the FILE: a second raw writer added to a classified file stays green.
 */

const CLASSIFIED: Record<string, string> = {
  // The door itself — writes the columns and the projection in one statement.
  "database/src/services/lifecycle/apply-status-move.ts": "the door",
  // Raw writes that set the lifecycle columns in the SAME statement.
  "api/src/services/reversibility/safe-revert.ts":
    "undo restores status + status_category with the projection",
  "database/src/services/entity-merge-service.ts":
    "merge/unmerge derive the columns from the merged projection",
  // Repositories carrying the guard (assertNoLifecycleMove) or born columns.
  "database/src/repositories/entity-repository.ts":
    "guarded (assertNoLifecycleMove); re-type re-derives the columns",
  "database/src/repositories/facet-repository.ts":
    "guarded (assertNoLifecycleMove); attach derives the born columns",
  // Raw writes whose keys can never be a lifecycle property.
  "api/src/routers/webhooks-inbound.ts":
    "the event's lifecycle key is split out to moveStatus before the patch",
  "api/src/services/event-sync/run-gcal-import.ts":
    "VOLATILE_EVENT_PROPERTIES only (dates, location, links, description)",
  "api/src/routers/devplane.ts": "a vault reference (secret) property",
  "database/src/services/team-person-bridge.ts": "linkedUserId only",
  "api/src/services/entity-body/promote-property-to-body.ts":
    "moves a TEXT property into the body; a lifecycle is a select",
};

const ROOT = join(__dirname, "../../..");
const PACKAGES = ["api/src", "jobs/src", "database/src"];

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, acc);
    else if (
      p.endsWith(".ts") &&
      !p.endsWith(".d.ts") &&
      !/\.(test|spec)\.ts$/.test(p) &&
      !p.includes("__tests__") &&
      !p.includes("__tripwires__")
    )
      acc.push(p);
  }
  return acc;
}

/** Raw `.update(entities|entityFacets)` whose `.set({…})` names `properties`. */
export function rawPropertyWriters(src: string): number {
  // `}` then an optional `as Partial<…>` cast, then `)` and the next call.
  const re =
    /\.update\((entities|entityFacets)\)\s*\.set\(\{([\s\S]*?)\}(?:\s+as\s+[\w<>.]+)?\)\s*\./g;
  let n = 0;
  for (const m of src.matchAll(re)) {
    if (/\bproperties\s*[:,]/.test(m[2]!)) n++;
  }
  return n;
}

describe("lifecycle one door", () => {
  const hits: string[] = [];
  let scanned = 0;
  let rawUpdates = 0;
  for (const pkg of PACKAGES) {
    for (const file of tsFiles(join(ROOT, pkg))) {
      scanned++;
      const src = readFileSync(file, "utf8");
      rawUpdates += (src.match(/\.update\((entities|entityFacets)\)/g) ?? [])
        .length;
      if (rawPropertyWriters(src) > 0) hits.push(relative(ROOT, file));
    }
  }

  it("non-vacuity: the scan sees the packages and real raw writers", () => {
    expect(scanned).toBeGreaterThan(500);
    expect(rawUpdates).toBeGreaterThan(15);
    expect(hits.length).toBeGreaterThan(4);
    // self-check: the regex still sees a literal sample of what it hunts
    expect(
      rawPropertyWriters(
        "await db.update(entities).set({ properties: next, updatedAt }).where(x)"
      )
    ).toBe(1);
    expect(
      rawPropertyWriters(
        "await db.update(entities).set({ deletedAt: now }).where(x)"
      )
    ).toBe(0);
    expect(
      rawPropertyWriters(
        "await this.db.update(entities).set({ properties: p } as Partial<NewEntity>).where(x)"
      )
    ).toBe(1);
  });

  it("every raw properties writer on entities / entity_facets is classified", () => {
    const unclassified = hits.filter((f) => !(f in CLASSIFIED));
    expect(
      unclassified,
      "route the write through moveStatus/applyStatusMove, or classify it with the reason it cannot move a status"
    ).toEqual([]);
  });

  it("no stale classification (a classified file still writes)", () => {
    const stale = Object.keys(CLASSIFIED).filter((f) => !hits.includes(f));
    expect(stale).toEqual([]);
  });
});
