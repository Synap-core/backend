/**
 * TRIPWIRE — every door the session verb table names EXISTS.
 *
 * `SESSION_VERB_DECLARATION` (`@synap-core/types/focus-sessions`) is what the
 * apps render their session ⋯ menu from, and it names, per verb, the door that
 * runs it on each surface: a tRPC procedure on `focusSessions`, an MCP tool and
 * the argument that carries the verb, a Hub REST route. A door renamed or
 * removed here would leave every surface offering a verb that cannot run, with
 * every type still checking. This test reads the REAL doors:
 *   - tRPC: `focusSessionsRouter._def.procedures` (the router `root.ts` mounts
 *     at `focusSessions`);
 *   - MCP: `tools.list()` — the tool exists and its input schema declares the
 *     argument;
 *   - Hub REST: the route is registered (`app.<method>("<path>"`) in a file
 *     under `routers/hub-protocol/rest/`.
 * A door declared `null` must be ABSENT too, so a door added later forces the
 * table to name it (self-cleaning, like cross-door-verb-parity).
 *
 * WHAT IT CANNOT SEE: that a door actually performs the verb's effect (status
 * move, cancel, edge) for a given caller — that is each door's own tests. The
 * Hub check is a source scan of route registrations: a route built from a
 * variable path would not be seen (none is today; the non-vacuity floor below
 * counts what it sees).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SESSION_VERBS,
  SESSION_VERB_DECLARATION,
  type SessionVerbDeclaration,
} from "@synap-core/types/focus-sessions";
import { focusSessionsRouter } from "../routers/focus-sessions.js";
import { tools } from "../routers/mcp/tools/index.js";

const HUB_REST = resolve(import.meta.dirname, "../routers/hub-protocol/rest");

/** Every `app.<method>("<path>"` registration under the Hub REST folder. */
function hubRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const file of readdirSync(HUB_REST)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(join(HUB_REST, file), "utf8");
    for (const m of src.matchAll(
      /\bapp\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g
    )) {
      routes.add(`${m[1]!.toUpperCase()} ${m[2]!}`);
    }
  }
  return routes;
}

const declarations = SESSION_VERBS.map(
  (verb) =>
    [verb, SESSION_VERB_DECLARATION[verb] as SessionVerbDeclaration] as const
);

describe("session verb doors — the table names real doors", () => {
  const procedures = focusSessionsRouter._def.procedures as Record<
    string,
    unknown
  >;
  const routes = hubRoutes();

  it("the scans see what they hunt (non-vacuity)", () => {
    expect(Object.keys(procedures).length).toBeGreaterThan(30);
    expect(procedures.update).toBeDefined();
    expect(routes.size).toBeGreaterThan(100);
    expect(routes.has("PATCH /focus-sessions/:id")).toBe(true);
  });

  it.each(declarations)("%s: its tRPC procedure exists", (_verb, decl) => {
    if (decl.doors.trpc === null) return;
    expect(Object.keys(procedures)).toContain(decl.doors.trpc);
  });

  it.each(declarations)(
    "%s: its MCP tool exists and declares the argument",
    async (_verb, decl) => {
      if (decl.doors.mcp === null) return;
      const list = await tools.list();
      const tool = list.find((t) => t.name === decl.doors.mcp!.tool);
      expect(tool, `MCP tool ${decl.doors.mcp.tool}`).toBeDefined();
      const props = Object.keys(
        (tool!.inputSchema as { properties?: Record<string, unknown> })
          .properties ?? {}
      );
      expect(props).toContain(decl.doors.mcp.arg);
    }
  );

  it.each(declarations)(
    "%s: its Hub REST route is registered",
    (_verb, decl) => {
      if (decl.doors.hub === null) return;
      expect([...routes]).toContain(decl.doors.hub);
    }
  );

  // A `null` hub door is a claim that the surface has no door for the verb.
  // `release` drops a `blocked_by` edge: Hub REST has no edge delete today.
  // When one is added, this fails and the table must name it.
  it("a door declared missing is really missing", () => {
    for (const [verb, decl] of declarations) {
      if (decl.doors.hub !== null) continue;
      expect(verb).toBe("release");
      expect(
        [...routes].filter((r) => r.startsWith("DELETE /links")),
        "an edge delete exists now: name it on `release`"
      ).toEqual([]);
    }
  });
});
