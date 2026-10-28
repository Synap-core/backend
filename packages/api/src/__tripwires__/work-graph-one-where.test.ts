/**
 * TRIPWIRE — the work graph reads through the list's ONE WHERE, never its own.
 *
 * `focusSessions.graph` exists beside `focusSessions.list` by founder decision
 * (1 A, 2026-10-26). The comment it overruled named the risk exactly: "a
 * second door would be a second shape to keep in lockstep". The answer is by
 * construction — `services/focus-sessions/work-graph.ts` selects sessions only
 * through `queryUserSessions` / `countUserSessions`
 * (`session-list-rows.ts`), whose WHERE is `sessionListConditions` — and this
 * file pins it, so a graph that grows a hand-written predicate (the defect MCP
 * `synap_list_sessions` still carries) reads red at the point of edit.
 *
 * Source scan, comments stripped. What it proves: the service file names no
 * query builder and no table column, and the two readers it calls build their
 * WHERE from `sessionListConditions`. What it does NOT prove: that the
 * arguments passed are the right ones (the PGlite suite
 * `work-graph.pglite.test.ts` drives the real read for that).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const SERVICES = join(__dirname, "..", "services", "focus-sessions");
const GRAPH = join(SERVICES, "work-graph.ts");
const ROWS = join(SERVICES, "session-list-rows.ts");

/** What a hand-written session predicate or query is made of (scanned with strings blanked). */
const OWN_QUERY =
  /\.(?:from|where|select|innerJoin|leftJoin)\s*\(|\bfocusSessions\s*\.|\bdrizzleSql\b|\bdb\s*\./;
/** The query builder itself (scanned on the import specifiers). */
const DB_IMPORT = /from\s+["']@synap\/database["']/;

/** Blank string literals, so a log label like "focusSessions.graph" is not code. */
const blankStrings = (src: string) =>
  src.replace(
    /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    '""'
  );

/** The body of `export (async) function <name>(…) { … }` — up to the next top-level function. */
function fnBody(src: string, name: string): string {
  const start = src.search(
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`)
  );
  if (start < 0) return "";
  const rest = src.slice(start + 1);
  const end = rest.search(/\nexport\s+(?:async\s+)?function\s/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("the work graph reads through the list's WHERE", () => {
  const graph = stripComments(readFileSync(GRAPH, "utf8"), "ts");
  const rows = stripComments(readFileSync(ROWS, "utf8"), "ts");

  it("the scan can see what it hunts (self-check)", () => {
    expect(OWN_QUERY.test("db.select().from(focusSessions).where(x)")).toBe(
      true
    );
    expect(DB_IMPORT.test('import { eq } from "@synap/database";')).toBe(true);
    expect(OWN_QUERY.test(blankStrings('log("focusSessions.graph")'))).toBe(
      false
    );
    expect(OWN_QUERY.test("const x = focusSessions.status;")).toBe(true);
    // Non-vacuity: the service is non-trivial and is the one that builds the graph.
    expect(graph).toMatch(/export\s+async\s+function\s+buildWorkGraph\b/);
    expect(graph.length).toBeGreaterThan(2_000);
  });

  it("work-graph.ts holds no query and no table column of its own", () => {
    const hit = OWN_QUERY.exec(blankStrings(graph)) ?? DB_IMPORT.exec(graph);
    expect(
      hit?.[0] ?? null,
      "work-graph.ts builds its own query — read sessions through queryUserSessions / countUserSessions (session-list-rows.ts), and add any new narrowing to sessionListConditions."
    ).toBeNull();
  });

  it("it selects sessions only through the shared readers", () => {
    expect(graph).toMatch(
      /import\s*\{[^}]*\bqueryUserSessions\b[^}]*\}\s*from\s*["']\.\/session-list-rows\.js["']/
    );
    expect(graph).toMatch(/\bqueryUserSessions\s*\(/);
    expect(graph).toMatch(/\bcountUserSessions\s*\(/);
    expect(graph).toMatch(/\bprojectSessionRows\s*\(/);
  });

  it("the shared readers build their WHERE from sessionListConditions", () => {
    for (const name of ["queryUserSessions", "countUserSessions"]) {
      const body = fnBody(rows, name);
      expect(body.length, `${name} moved — update this pin`).toBeGreaterThan(0);
      expect(body, `${name} must read through sessionListConditions`).toMatch(
        /\.where\(\s*and\(\s*\.\.\.sessionListConditions\(/
      );
    }
  });
});
