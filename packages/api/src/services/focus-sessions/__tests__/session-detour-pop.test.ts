/**
 * POP does not close the PARENT.
 *
 * `session --spawned_from--> session` (the detour stack) gives a session a
 * parent for the first time. The failure mode a stack invites is a cascade:
 * closing the detour also closing the thing you were pushed away from, which
 * would silently end work the operator never finished.
 *
 * The invariant: NO CLOSE PATH reads the `spawned_from` edge, and every
 * `focus_sessions` status write in a close path is keyed on the session id the
 * caller named. A parent is closed only by closing the parent.
 *
 * Scoped to close PATHS, not to whole FILES, on purpose. The file-level form of
 * this test matched one symbol name (`getParentSessionId(`) and went green the
 * moment the same lookup arrived in `routers/focus-sessions.ts` under a wrapper
 * with a different name — `list`/`get` legitimately project a parent id from
 * that very file. A rule a rename satisfies is not a rule, so the assertion now
 * names the property (close paths reach no parent) rather than a spelling, and
 * matches EVERY door into the lineage module.
 *
 * Source-parsed on purpose — it must fail in CI without a database, and at the
 * point of EDIT rather than when someone loses an afternoon of work. It proves
 * the ABSENCE of a cascade; it does not exercise the runtime close.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICES = join(__dirname, "..");
const API_SRC = join(SERVICES, "../..");

const ROUTER = join(API_SRC, "routers/focus-sessions.ts");
const HUB_REST = join(API_SRC, "routers/hub-protocol/rest/focus-sessions.ts");
const COMPLETE = join(SERVICES, "complete-session.ts");

/**
 * EVERY door into the lineage projection, not one spelling of it. The read
 * lives in `@synap/database` (`getParentSessionId`/`getParentSessionIds`) and
 * is wrapped by `services/focus-sessions/parent-lineage.ts`
 * (`withParentSessionId`/`attachParentSessionIds`); reaching a parent row
 * requires naming one of them, or the edge itself.
 */
const LINEAGE =
  /getParentSessionIds?\s*\(|withParentSessionId\s*\(|attachParentSessionIds\s*\(|parent-lineage|spawned_from/;

/**
 * Slice one tRPC procedure's body out of a router. Procedures are top-level
 * entries of the `router({ … })` object literal, so a body runs from its own
 * `  name: <x>Procedure` header to the next one (or to end of file).
 */
function procedureBody(src: string, name: string): string {
  const header = new RegExp(
    `^  ${name}: (?:protected|workspace|public|admin)Procedure$`,
    "m"
  );
  const start = src.search(header);
  expect(
    start,
    `procedure '${name}' not found — the extractor is stale`
  ).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const next = rest.search(
    /^ {2}\w+: (?:protected|workspace|public|admin)Procedure$/m
  );
  // A body also ENDS at the first column-0 line — the router's closing `});`.
  // Procedure lines are always indented. Without this stop, the LAST procedure
  // in a router ran to end of FILE and swallowed every top-level function
  // declared below the router; a fixture caught it, the real router was spared
  // only because `close` is not its final entry.
  const routerEnd = rest.search(/^\S/m);
  const cuts = [next, routerEnd].filter((i) => i !== -1);
  return cuts.length === 0 ? rest : rest.slice(0, Math.min(...cuts));
}

/**
 * Every top-level function in a router file, by name → its source text. A body
 * runs from its declaration to the next top-level declaration of any kind.
 */
function localFunctions(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const decl = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/gm;
  const boundary =
    /^(?:export\s+)?(?:async\s+function|function|const|let|type|interface|class)\s/gm;
  for (const m of src.matchAll(decl)) {
    boundary.lastIndex = m.index! + 1;
    const next = boundary.exec(src);
    map.set(m[1]!, src.slice(m.index!, next ? next.index : src.length));
  }
  return map;
}

/**
 * A procedure's body PLUS the source of every LOCAL function it reaches,
 * transitively.
 *
 * WHY THE HOP. `procedureBody` alone reads only the procedure's own lines, so
 * it was blind to code a procedure reaches through a helper in the same file.
 * That cut both ways, and one of them was a hole this file exists to close:
 *   - when `browse` arrived, `attachParentSessionIds` moved from `list`'s body
 *     into the shared `projectSessionRows` helper, and the self-check below
 *     went red on correct code;
 *   - worse, a CLOSE procedure could reach a parent through such a helper while
 *     "the close PROCEDURES reach no parent" stayed green — the cascade this
 *     tripwire is named for, hidden one function away.
 *
 * Boundary, stated: it follows functions DECLARED IN THE ROUTER FILE only.
 * Imported services are out of reach, which is why `complete-session.ts` is
 * checked as a whole file below.
 */
function reachableSource(src: string, name: string): string {
  const fns = localFunctions(src);
  const seen = new Set<string>();
  let out = procedureBody(src, name);
  const queue = [out];
  while (queue.length > 0) {
    const chunk = queue.pop()!;
    for (const m of chunk.matchAll(/\b(\w+)\s*\(/g)) {
      const callee = m[1]!;
      if (seen.has(callee) || !fns.has(callee)) continue;
      seen.add(callee);
      const body = fns.get(callee)!;
      out += "\n" + body;
      queue.push(body);
    }
  }
  return out;
}

describe("detour pop", () => {
  it("the close PROCEDURES of the tRPC router reach no parent", () => {
    const src = readFileSync(ROUTER, "utf8");
    // Both doors that flip a session to a terminal status: the status-closed
    // funnel inside `update`, and the canonical `close`.
    for (const name of ["update", "close"]) {
      expect(reachableSource(src, name), name).not.toMatch(LINEAGE);
    }
  });

  it("the extractor FOLLOWS a procedure into the local helpers it calls", () => {
    // Proves the hop on a fixture, so the check cannot quietly stop following
    // and still pass: the direct slice must be blind, the reachable source
    // must see through the helper, and a procedure that reaches no helper must
    // stay clean.
    const fixture = [
      "export const r = router({",
      "  list: protectedProcedure",
      "    .query(async () => { return project(rows); }),",
      "  close: protectedProcedure",
      "    .mutation(async () => { return tidy(); }),",
      "});",
      "",
      "async function project(rows) {",
      "  return attachParentSessionIds(rows);",
      "}",
      "",
      "function tidy() {",
      "  return 1;",
      "}",
    ].join("\n");
    expect(procedureBody(fixture, "list")).not.toMatch(LINEAGE);
    expect(reachableSource(fixture, "list")).toMatch(LINEAGE);
    expect(reachableSource(fixture, "close")).not.toMatch(LINEAGE);
  });

  it("the extractor actually sees lineage where lineage exists", () => {
    // Self-check. Without it, a renamed/moved procedure would make the slices
    // above empty and the tripwire would pass by finding nothing at all —
    // exactly the failure this rewrite exists to close. `list`/`get` are
    // read-only projections and are SUPPOSED to match.
    const src = readFileSync(ROUTER, "utf8");
    for (const name of ["list", "get"]) {
      expect(reachableSource(src, name), name).toMatch(LINEAGE);
    }
  });

  it("every focus_sessions status write in the router is keyed on the caller's id", () => {
    const src = readFileSync(ROUTER, "utf8");
    const updates = [
      ...src.matchAll(/\.update\(focusSessions\)[\s\S]*?\.where\(([^)]*\))/g),
    ];
    expect(updates.length, "no focusSessions update found").toBeGreaterThan(0);
    for (const m of updates) {
      // A parent lookup could only cause a cascade by reaching an update. The
      // only accepted predicate is the id the caller named.
      expect(m[1].replace(/\s+/g, "")).toBe("eq(focusSessions.id,input.id)");
    }
  });

  it("the close service mentions the detour edge nowhere at all", () => {
    // `complete-session.ts` is a close door end to end — no read-only half to
    // carve out, so the whole file is the unit.
    expect(readFileSync(COMPLETE, "utf8")).not.toMatch(LINEAGE);
  });

  it("the Hub REST door ACCEPTS a parent on create but never RESOLVES one", () => {
    // Accepting a `parentSessionId` on the CREATE body is not resolving one —
    // it is handed to the producer, which owns the owner floor. What must not
    // appear is a lookup.
    const src = readFileSync(HUB_REST, "utf8");
    expect(src).not.toMatch(
      /getParentSessionIds?\s*\(|withParentSessionId\s*\(|attachParentSessionIds\s*\(|parent-lineage/
    );
    expect(src).not.toMatch(/linkType[^\n]*spawned_from/);
  });

  it("complete-session updates exactly the session it was given", () => {
    const src = readFileSync(COMPLETE, "utf8");
    const updates = [
      ...src.matchAll(/\.update\(focusSessions\)[\s\S]*?\.where\(([^)]*\))/g),
    ];
    expect(updates.length, "no focusSessions update found").toBeGreaterThan(0);
    for (const m of updates) {
      expect(m[1].replace(/\s+/g, "")).toBe("eq(focusSessions.id,sessionId)");
    }
  });

  it("the spawn producer never writes a status onto either session", () => {
    const src = readFileSync(
      join(API_SRC, "../../database/src/utils/session-spawn.ts"),
      "utf8"
    );
    expect(src).not.toMatch(/status/);
    expect(src).not.toMatch(/closedAt/);
  });
});
