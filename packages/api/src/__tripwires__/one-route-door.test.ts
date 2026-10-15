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
 *   3. An AI handing a SESSION to another agent asks the route first: the
 *      hand-off gate (`agent-hand-off.ts`) calls `route()` with
 *      `HAND_OFF_ACCEPT` BEFORE governance, the approval executor re-asks it
 *      before the roster write, and the roster an AI reads to choose
 *      (`agents-for-handoff.ts`) answers with the same accept through
 *      `namedVerdicts` (the selector rung `route()` itself uses).
 *
 * What it does NOT see: a door that re-implements a pick from raw SQL without
 * these helpers, and pickers outside api/src. `agentsOperatedBy` is not pinned:
 * it also answers "who can see this roster" for display (give-to-agent's line,
 * the agent-users router, the answer loop), which is not a pick. For (3): a
 * staffing door that writes the roster without `gateAgentHandOff` — the
 * person's own doors (tRPC `attachAgent`, relay) do that on purpose and are
 * not routed.
 */

const ROUTE = "services/agent-dispatch/route.ts";
/** Where the floors are DEFINED (the definition line is not a call). */
const DEFINITIONS = "services/agent-dispatch/agent-binding.ts";

const HAND_OFF_GATE = "services/focus-sessions/agent-hand-off.ts";
const HAND_OFF_ROSTER = "services/agent-dispatch/agents-for-handoff.ts";

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

describe("tripwire: handing a session to an agent asks the route", () => {
  const src = (rel: string) => {
    const f = files.find((x) => x.rel === rel);
    expect(f, `${rel} is missing`).toBeDefined();
    return f!.src;
  };

  it("the gate asks route() with the hand-off reaches, before governance", () => {
    const gate = src(HAND_OFF_GATE);
    const refusal = gate.slice(
      gate.indexOf("export async function handOffRefusal")
    );
    expect(refusal).toMatch(/^export async function handOffRefusal/);
    expect(refusal).toMatch(/await route\(\{[^}]*accept: HAND_OFF_ACCEPT/);
    const body = gate.slice(
      gate.indexOf("export async function gateAgentHandOff")
    );
    expect(body).toMatch(/^export async function gateAgentHandOff/);
    const asked = body.indexOf("handOffRefusal(");
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(body.indexOf("checkPermissionOrPropose("));
  });

  it("approving a hand-off re-asks it before the roster write", () => {
    // Derived: every executor registered for the hand-off proposal.
    const approvers = files.filter((f) =>
      /key:\s*"focus_session\/assign_agent"/.test(f.src)
    );
    expect(approvers.map((f) => f.rel)).toHaveLength(1);
    const body = approvers[0]!.src.slice(
      approvers[0]!.src.search(/key:\s*"focus_session\/assign_agent"/)
    );
    const asked = body.indexOf("handOffRefusal(");
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(body.indexOf("attachSessionAgent("));
  });

  it("the roster an AI chooses from answers with the same accept and rung", () => {
    expect(src(HAND_OFF_ROSTER)).toMatch(
      /namedVerdicts\(\s*\{[^}]*accept: HAND_OFF_ACCEPT/
    );
    // The selector rung of route() IS namedVerdicts.
    expect(src(ROUTE)).toMatch(
      /await namedVerdicts\(work, \[id\], roomMembers\)/
    );
  });
});
