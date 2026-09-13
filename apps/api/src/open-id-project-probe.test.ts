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

  it("probes `projects` before `entities`", () => {
    const projectIdx = HANDLER_BODY.indexOf('type = "project"');
    const entityIdx = HANDLER_BODY.indexOf('type = "entity"');
    expect(projectIdx).toBeGreaterThan(-1);
    expect(entityIdx).toBeGreaterThan(-1);
    expect(projectIdx).toBeLessThan(entityIdx);
  });

  it("queries the `projects` table (not just a renamed entity check)", () => {
    const projectBranch = HANDLER_BODY.slice(
      HANDLER_BODY.indexOf('type = "project"') - 400,
      HANDLER_BODY.indexOf('type = "project"')
    );
    expect(projectBranch).toContain(".from(projects)");
  });
});
