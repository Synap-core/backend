import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The bare `/open/:id` probe (`app.get("/open/:id", ...)` in `index.ts`) has
 * no DB-free seam: it opens a real Drizzle connection inline via a dynamic
 * `import("@synap/database")`, so there is no existing unit-test harness for
 * it and building one would mean wiring a live/mocked Postgres — out of scope
 * here (WRITTEN-BUT-UNPROVEN at the integration level; see report).
 *
 * What CAN be verified without a DB is the one thing this fix is actually
 * about: PROBE ORDER. Migration 0151 copied `projects` rows into their own
 * table, preserving ids, and left the pre-0151 `entities` row for the same id
 * live. Both tables can therefore claim the same id, and whichever branch of
 * the if/else-if chain runs FIRST wins — an `entities`-first check would keep
 * resolving a project id to the stale entity copy no matter what the
 * `projects` branch does. So the source-scan below pins the one fact that
 * matters: `type = "project"` appears BEFORE `type = "entity"` in the
 * handler body. This is the same source-scan idiom `open-kinds.lock.tripwire
 * .test.ts` already uses for this same file, for the same reason (no DB seam
 * reachable from a unit test).
 */

const INDEX_SRC = readFileSync(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
  "utf8"
);

const HANDLER_START = INDEX_SRC.indexOf('app.get("/open/:id"');
const HANDLER_END = INDEX_SRC.indexOf("// Ory Kratos routes", HANDLER_START);
const HANDLER_BODY = INDEX_SRC.slice(HANDLER_START, HANDLER_END);

describe("bare /open/:id probe order", () => {
  it("found the handler (non-vacuity: both anchors resolved)", () => {
    expect(HANDLER_START).toBeGreaterThan(-1);
    expect(HANDLER_END).toBeGreaterThan(HANDLER_START);
    // Sanity: the slice actually contains probe branches, not an empty gap.
    expect(HANDLER_BODY).toContain('type = "entity"');
  });

  // The project probe is a GUARD, not a type: a project id goes on untyped
  // (the route owns no type list), so what is pinned is that the `projects`
  // lookup runs BEFORE the `entities` one and short-circuits it. (These two
  // assertions replace ones that looked for a `type = "project"` assignment
  // the handler stopped making when it dropped its private type list — they
  // had been failing since.)
  it("probes `projects` before `entities`", () => {
    const projectIdx = HANDLER_BODY.indexOf(".from(projects)");
    const entityIdx = HANDLER_BODY.indexOf(".from(entities)");
    expect(projectIdx).toBeGreaterThan(-1);
    expect(entityIdx).toBeGreaterThan(-1);
    expect(projectIdx).toBeLessThan(entityIdx);
  });

  it("the entity probe only runs when the projects probe MISSED", () => {
    const guard = HANDLER_BODY.slice(
      HANDLER_BODY.indexOf(".from(projects)") - 300,
      HANDLER_BODY.indexOf(".from(projects)")
    );
    expect(guard).toMatch(/!\(await hit\(/);
  });
});

describe("bare /open/:id owns no type list", () => {
  // The public route may only type what changes its HTTP answer. Anything
  // else is resolved user-floored behind a sign-in (pod-admin `/open/<id>` →
  // `diagnose.resolveOpen`, or the app). A new `type = "<kind>"` here is a
  // second, unfloored probe list — the thing this route was cleaned of.
  it("assigns only proposal / entity / view", () => {
    const assigned = [...HANDLER_BODY.matchAll(/\btype = "([a-z_]+)"/g)].map(
      (m) => m[1]
    );
    expect(assigned.length).toBeGreaterThan(0);
    expect([...new Set(assigned)].sort()).toEqual([
      "entity",
      "proposal",
      "view",
    ]);
  });
});
