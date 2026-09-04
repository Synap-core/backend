import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * TRIPWIRE — `focus_sessions.agentIds` has ONE append door, reachable from
 * every write door that claims to append.
 *
 * TWO failures, one file:
 *
 * (1) THE SEVERANCE. Every writer of the column assigns it WHOLESALE at create
 *     time (`create-session.ts`, `open-run-session.ts`, `playbook-lifecycle.ts`,
 *     `run-playbook.ts`, the `focus_session/create` executor) and the two update
 *     doors assign wholesale too. NOTHING appended, so an agent joining a session
 *     already in flight could never be recorded — the column was an invite list
 *     that only the first instant could write. `attachSessionAgent` is that
 *     append door.
 *
 * (2) THE DOOR ASYMMETRY. Synap's recurring defect: a verb built on one door and
 *     silently absent from the others, indistinguishable from a verb deliberately
 *     withheld. `addAgentId` must be reachable from all three write doors, and —
 *     because two of them are GOVERNED — the proposal executor must re-apply it
 *     on approval, or the proposed path is a silent no-op that reports success.
 *
 * SOURCE-SCAN, not behavioural: both failures are ABSENCES, and only a scan of
 * the source can see an absence.
 *
 * Do NOT satisfy this by writing `set.agentIds = [...existing, x]` at a call
 * site. That is a second append implementation with no row lock, and the
 * lost-update race it reintroduces is exactly what the door owns.
 */

const API_SRC = join(__dirname, "..");
const DOOR = "services/focus-sessions/attach-session-agent.ts";

const read = (rel: string) => readFileSync(join(API_SRC, rel), "utf8");

function tsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
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

describe("tripwire: session roster append has one door, on every door", () => {
  it("the door exists and locks the row it read-modify-writes", () => {
    const door = read(DOOR);
    expect(door).toMatch(/export async function attachSessionAgent/);
    // Without the lock, two concurrent attaches both read the pre-state and one
    // is lost — the exact hazard a wholesale assignment already had.
    expect(door).toMatch(/\.for\("update"\)/);
    // Owner floor: `focus_sessions` is owner-private and carries no
    // VisibilityRule, so the predicate IS the access control.
    expect(door).toMatch(/eq\(focusSessions\.userId, userId\)/);
  });

  it("all three write doors reach it", () => {
    // tRPC — a dedicated append mutation, not a widened `update`.
    const trpc = read("routers/focus-sessions.ts");
    expect(trpc).toMatch(/attachAgent: protectedProcedure/);
    expect(trpc).toMatch(/attachSessionAgent\(\{/);

    // Hub REST — `addAgentId` on the PATCH body, distinct from wholesale
    // `agentIds`.
    const rest = read("routers/hub-protocol/rest/focus-sessions.ts");
    expect(rest).toMatch(/addAgentId: z\.string\(\)/);
    expect(rest).toMatch(/attachSessionAgent\(\{/);

    // MCP — `addAgentId` declared on the tool, threaded by the handler, applied
    // by the shared service.
    const tools = read("routers/mcp/tools/index.ts");
    expect(tools).toMatch(/addAgentId: \{/);
    const handler = read("routers/mcp/handlers/session.ts");
    expect(handler).toMatch(/addAgentId: args\.addAgentId/);
    const service = read("services/focus-sessions/update-session.ts");
    expect(service).toMatch(/addAgentId\?: string/);
    expect(service).toMatch(/attachSessionAgent\(\{/);
  });

  it("the GOVERNED doors carry addAgentId into the gate, so approval can apply it", () => {
    // A field that reaches the gate but not the proposal data is applied on the
    // auto path and dropped on the proposed one — success reported, nothing
    // written.
    for (const rel of [
      "services/focus-sessions/update-session.ts",
      "routers/hub-protocol/rest/focus-sessions.ts",
    ]) {
      expect(read(rel), rel).toMatch(
        /\{ addAgentId: (params|patch)\.addAgentId \}/
      );
    }
    // ...and the executor re-applies it through the SAME door on approval.
    const executor = read("routers/proposals/executors/focus-session.ts");
    expect(executor).toMatch(/innerData\.addAgentId/);
    expect(executor).toMatch(/attachSessionAgent\(\{/);
  });

  it("nothing else appends to agentIds behind the door's back", () => {
    // A spread of the column's PRIOR state back into it is a second append
    // implementation — no row lock, no idempotency, and it will lose writes
    // under any concurrency. A wholesale assignment from a literal or a caller
    // param is fine: that is the documented create-time shape.
    //
    // Both column-write forms count: the object-literal `agentIds: [...x]` and
    // the property assignment `set.agentIds = [...x]`. A LOCAL `const agentIds
    // = [...]` is deliberately NOT matched — `routers/proposals.ts` has one that
    // has nothing to do with this column.
    const APPEND_SHAPE =
      /(?:\bagentIds:|\.agentIds\s*=)\s*\[\s*\.\.\.[A-Za-z_$]/;
    const offenders: string[] = [];
    let scanned = 0;
    for (const f of tsFiles(API_SRC)) {
      if (f.endsWith("attach-session-agent.ts")) continue;
      const src = readFileSync(f, "utf8");
      // Only files that touch the sessions table can be writing this column.
      if (!src.includes("focusSessions")) continue;
      scanned += 1;
      if (APPEND_SHAPE.test(src)) offenders.push(relative(API_SRC, f));
    }
    // Self-guard: a scan that reads nothing would pass vacuously forever.
    expect(
      scanned,
      "the focusSessions corpus is suspiciously small — the scan is broken, not the codebase clean"
    ).toBeGreaterThan(20);
    expect(offenders.sort()).toEqual([]);
  });

  it("the derived participant roster includes DECLARED agents, not only proposers", () => {
    // The union is the point: an agent attached but not yet productive is on the
    // session, and the roster surface must say so.
    const trpc = read("routers/focus-sessions.ts");
    expect(trpc).toMatch(/row\.agentIds as string\[\] \| null/);
  });
});
