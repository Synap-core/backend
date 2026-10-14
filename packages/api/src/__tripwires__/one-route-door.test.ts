import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — "which agent takes this work" has ONE door: `route()`
 * (`services/agent-dispatch/route.ts`).
 *
 * Before it, three doors each had their own picker and they disagreed: the run
 * executor's `chooseRunAgent`, give-to-agent's reach/ownership branches, and
 * the chat room's IS `routeTeammate` (an AI choosing who answers — retired by
 * founder decision 2026-10-13: when several agents fit, the PERSON chooses).
 *
 * What this pins, over every non-test `.ts` file in api/src (the set is
 * globbed, so a new file joins the scan by existing):
 *   1. The pick floors — `listDispatchableAgentIds(` (the owner's pool) and
 *      `ownedAgentIds(` (the dispatch ownership floor) — are CALLED only in
 *      route.ts. A door that calls them is re-deriving the pick.
 *   2. Nothing calls `.routeTeammate(` — the AI picker stays gone.
 *
 * What it does NOT see: a door that re-implements a pick from raw SQL without
 * these helpers, and pickers outside api/src. `agentsOperatedBy` is not pinned:
 * it also answers "who can see this roster" for display (give-to-agent's line,
 * the agent-users router, the answer loop), which is not a pick.
 */

const ROUTE = "services/agent-dispatch/route.ts";
/** Where the floors are DEFINED (the definition line is not a call). */
const DEFINITIONS = "services/agent-dispatch/agent-binding.ts";

const PICK_CALL = /\b(listDispatchableAgentIds|ownedAgentIds)\s*\(/g;
const DEFINITION = /\bfunction\s+(listDispatchableAgentIds|ownedAgentIds)\s*\(/g;
const AI_PICKER = /\.routeTeammate\s*\(/;

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, acc);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

/** Calls, not definitions: count matches minus the `function name(` lines. */
function pickCalls(src: string): number {
  return (
    (src.match(PICK_CALL)?.length ?? 0) - (src.match(DEFINITION)?.length ?? 0)
  );
}

const srcRoot = join(process.cwd(), "src");
const files = tsFiles(srcRoot).map((f) => ({
  rel: relative(srcRoot, f),
  src: readFileSync(f, "utf8"),
}));

describe("tripwire: one route door", () => {
  it("the scan is real (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(500);
    // The patterns still see what they hunt.
    expect(pickCalls("await ownedAgentIds(owner, ids)")).toBe(1);
    expect(pickCalls("export async function ownedAgentIds(\n")).toBe(0);
    expect(AI_PICKER.test("client.routeTeammate({")).toBe(true);
    // The door itself is seen calling both floors.
    const route = files.find((f) => f.rel === ROUTE);
    expect(route).toBeDefined();
    expect(route!.src).toMatch(/listDispatchableAgentIds\s*\(/);
    expect(route!.src).toMatch(/ownedAgentIds\s*\(/);
    expect(files.some((f) => f.rel === DEFINITIONS)).toBe(true);
  });

  it("only route() calls the pick floors", () => {
    const offenders = files
      .filter((f) => f.rel !== ROUTE && pickCalls(f.src) > 0)
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("no door asks an AI to pick the agent", () => {
    const offenders = files
      .filter((f) => AI_PICKER.test(f.src))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
