/**
 * TRIPWIRE: both agent-start doors ask `createFocusSession` to bind on facts.
 *
 * `bind-on-facts.pglite.test.ts` calls `createFocusSession` directly, so
 * deleting `bindOnFacts` from either door would leave it green while an
 * agent's start silently stops binding. Textual on purpose (the doors need a
 * full request context to drive): each door's `createFocusSession(...)` call
 * must carry the flag, and the Hub door must key it on the agent's own key
 * (a person's start never binds).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) =>
  readFileSync(resolve(import.meta.dirname, rel), "utf8");

/** The argument object of every `createFocusSession(...)` call in a source. */
function createCalls(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/createFocusSession\(\{/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    out.push(src.slice(start, i));
  }
  return out;
}

describe("tripwire: the agent start doors bind on facts", () => {
  it("MCP synap_start_session passes bindOnFacts: true", () => {
    const calls = createCalls(read("../routers/mcp/handlers/session.ts"));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => /\bbindOnFacts:\s*true\b/.test(c))).toBe(true);
  });

  it("Hub POST focus-sessions passes bindOnFacts keyed on the agent's key", () => {
    const calls = createCalls(
      read("../routers/hub-protocol/rest/focus-sessions.ts")
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(
      calls.some((c) => /\bbindOnFacts:\s*!!ctxAgentUserId\b/.test(c))
    ).toBe(true);
  });
});
