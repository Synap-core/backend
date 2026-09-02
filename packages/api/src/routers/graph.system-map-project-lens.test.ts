/**
 * System Map — the PROJECT rung.
 *
 * The three `getSystemMap*` procedures gained a `projectId` narrow. Two things
 * must hold and neither can be checked with a live database here (local
 * Postgres is down), so both are proven the way `services/tools/visibility.test.ts`
 * proves its rule: by RENDERING the real predicate, plus a source tripwire that
 * reads the router's own composition — never by restating the rule in JS.
 *
 *   1. ADDITIVE — with no `projectId` the predicate is byte-for-byte what it was.
 *      Drizzle's `and()` drops `undefined` arms, so `and(floor, undefined)` must
 *      render identically to `and(floor)`. That is the whole guarantee.
 *   2. COMPOSED, NOT SUBSTITUTED — the project narrow is ANDed *with* the
 *      workspace/pod floor (`systemMapEntityScope`), never in place of it. A
 *      lens that replaced the floor would widen visibility past the workspace
 *      boundary: an access-control bug. The tripwire below fails if the two
 *      ever stop sharing one `and(...)`.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, isNull } from "@synap/database";
import { entities } from "@synap/database/schema";
import { projectLensWhere } from "../utils/project-scope.js";

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const render = (q: unknown) =>
  new PgDialect().sqlToQuery(q as never) as { sql: string; params: unknown[] };

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "graph.ts"),
  "utf8"
);

const SYSTEM_MAP_PROCEDURES = [
  "getSystemMapOverview",
  "getSystemMapKindDrilldown",
  "getSystemMapEntityGraph",
] as const;

/** The slice of graph.ts belonging to one procedure (up to the next one). */
function procedureSource(name: string): string {
  const start = SOURCE.indexOf(`${name}: podProcedure`);
  if (start < 0) throw new Error(`procedure ${name} not found in graph.ts`);
  const nextStarts = SYSTEM_MAP_PROCEDURES.map((p) =>
    SOURCE.indexOf(`${p}: podProcedure`)
  )
    .concat(SOURCE.indexOf("getObjectGraph: podProcedure"))
    .filter((i) => i > start);
  return SOURCE.slice(start, Math.min(...nextStarts));
}

/**
 * The TOP-LEVEL arguments of the `and(...)` call that encloses `needle`. Walks
 * back to the nearest `and(`, paren-matches forward, then splits on depth-0
 * commas — so "the floor and the lens are two separate arms of one AND" is
 * decided by the code's real structure. Splitting matters: a ternary that
 * SUBSTITUTES the lens for the floor keeps both names inside the same `and(`,
 * and would pass a mere substring check while widening visibility past the
 * workspace boundary.
 */
function enclosingAndArgs(src: string, needle: string): string[] {
  const call = enclosingAndCall(src, needle);
  const inner = call.slice(4, -1);
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return args.filter((a) => a.length > 0);
}

function enclosingAndCall(src: string, needle: string): string {
  const at = src.indexOf(needle);
  if (at < 0) throw new Error(`"${needle}" not present`);
  const open = src.lastIndexOf("and(", at);
  if (open < 0) throw new Error(`"${needle}" is not inside an and(...)`);
  let depth = 0;
  for (let i = open + 3; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced and(...)");
}

describe("System Map project lens — the predicate", () => {
  it("narrows on entities.id via the belongs_to_project exposure edge", () => {
    const { sql, params } = render(projectLensWhere(entities.id, PROJECT_ID));
    // Filters the ENTITY id column (the anchor itself, or anything exposed to it).
    expect(sql).toContain('"entities"."id"');
    // ...through the project membership edge, over `relations` — not some new rule.
    expect(sql).toContain('"relations"."target_entity_id"');
    expect(params).toContain("belongs_to_project");
    // The project id is a BOUND parameter, never interpolated.
    expect(params).toContain(PROJECT_ID);
    expect(sql).not.toContain(PROJECT_ID);
  });
});

describe("System Map project lens — additive when absent", () => {
  it("and(floor, undefined) renders exactly as and(floor)", () => {
    const floor = isNull(entities.deletedAt);
    const without = render(and(floor));
    const withAbsentLens = render(and(floor, undefined));
    expect(withAbsentLens.sql).toBe(without.sql);
    expect(withAbsentLens.params).toEqual(without.params);
  });

  it("and(floor, lens) is strictly MORE constrained than the floor alone", () => {
    const floor = isNull(entities.deletedAt);
    const narrowed = render(
      and(floor, projectLensWhere(entities.id, PROJECT_ID))
    );
    const floorOnly = render(and(floor));
    // The floor survives verbatim inside the narrowed predicate (AND, not
    // replacement), and the lens is additional text on top of it.
    expect(narrowed.sql).toContain(floorOnly.sql);
    expect(narrowed.sql.length).toBeGreaterThan(floorOnly.sql.length);
    expect(narrowed.params).toContain(PROJECT_ID);
  });
});

describe.each(SYSTEM_MAP_PROCEDURES)("%s", (name) => {
  const src = procedureSource(name);

  it("accepts an optional uuid projectId", () => {
    expect(src).toContain("projectId: z.string().uuid().optional()");
  });

  it("ANDs the project narrow WITH the workspace floor, never instead of it", () => {
    const args = enclosingAndArgs(src, "systemMapEntityScope(");
    // Two SEPARATE arms of one and(...): the floor always applies, and the
    // project lens is layered on top of it — never chosen instead of it.
    expect(args.some((a) => a.startsWith("systemMapEntityScope("))).toBe(true);
    expect(args).toContain("systemMapProjectScope(input.projectId)");
  });
});

describe("systemMapProjectScope", () => {
  it("delegates to the existing projectLensWhere preset and is a no-op when absent", () => {
    const body = SOURCE.slice(
      SOURCE.indexOf("function systemMapProjectScope("),
      SOURCE.indexOf("function assertSystemMapWorkspaceLensAccess(")
    );
    expect(body).toContain("projectLensWhere(entities.id, projectId)");
    expect(body).toContain("undefined");
    // No hand-rolled second predicate.
    expect(body).not.toContain("belongs_to_project");
  });
});
