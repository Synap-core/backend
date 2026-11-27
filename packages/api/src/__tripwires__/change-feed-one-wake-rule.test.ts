import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SESSION_CHANGE_KINDS as TYPES_KINDS,
  SESSION_CHANGE_WAKE,
} from "@synap-core/types/focus-sessions";
import { SESSION_CHANGE_KINDS } from "../services/focus-sessions/session-changes.js";
import { wireTools } from "../routers/mcp/define-tool.js";

/**
 * TRIPWIRE — the session change feed has ONE kind list and ONE wake rule
 * (plan 07f8a997 "Agents wait on anything", W1 part A).
 *
 * Before: five clients each decided which feed events ring (inventory
 * 8f64de57 §4.1), and the bridge stayed silent on `blocker_ended` and a hold's
 * resume while the CLI hook and the worker rang on other sets. Now the kinds
 * and `isWakeWorthy` live in `@synap-core/types/focus-sessions`
 * (`change-feed.ts`), the feed stamps `wake` on every event it serves, and the
 * clients ring on `wake === true`.
 *
 * This pins, in this repo:
 *  1. the api's `SESSION_CHANGE_KINDS` IS the types list (a re-export, not a twin);
 *  2. no other source file declares a copy of the list (a literal run of
 *     adjacent kind names);
 *  3. `listSessionChanges` stamps `wake` through `isWakeWorthy`, and the
 *     MCP wait tool's `events` input, AS ADVERTISED on `tools/list`
 *     (`wireTools()`, derived from its zod input), names every kind, tells
 *     the agent to act on `wake`, and offers exactly the kind list plus
 *     "all" as its values (an enum spread from the list: a re-typed literal
 *     copy in tools/index.ts is what check 2 refuses).
 */
const API_SRC = join(__dirname, "..");
const ROOTS = [
  API_SRC,
  join(__dirname, "..", "..", "..", "jobs", "src"),
  join(__dirname, "..", "..", "..", "database", "src"),
];
const FEED = "services/focus-sessions/session-changes.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "__tripwires__")
      continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Three kind names quoted side by side, in the list's order: a copy of the
 * kind list. Two are not: session-changes.ts reads `["pr_merged",
 * "pr_closed"]` as the pair of PR kinds it handles.
 */
const quoted = (k: string) => `["']${k}["']`;
const LIST_COPY = new RegExp(
  SESSION_CHANGE_KINDS.slice(0, -2)
    .map((k, i) =>
      [k, SESSION_CHANGE_KINDS[i + 1]!, SESSION_CHANGE_KINDS[i + 2]!]
        .map(quoted)
        .join("\\s*,\\s*")
    )
    .join("|")
);

describe("the change feed's one kind list and one wake rule", () => {
  it("the api's kind list is the types list itself", () => {
    expect(SESSION_CHANGE_KINDS).toBe(TYPES_KINDS);
    expect(Object.keys(SESSION_CHANGE_WAKE).sort()).toEqual(
      [...SESSION_CHANGE_KINDS].sort()
    );
  });

  it("no source file in api, jobs or database declares its own copy of the list", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        scanned++;
        if (LIST_COPY.test(readFileSync(file, "utf8"))) {
          offenders.push(relative(root, file));
        }
      }
    }
    expect(scanned).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });

  it("the feed stamps wake with the one rule, and the wait tool tells agents to act on it", () => {
    const feed = readFileSync(join(API_SRC, FEED), "utf8");
    expect(feed).toMatch(/wake:\s*isWakeWorthy\(e,\s*viewer\)/);
    // The wire entry, not the source text: what an agent is actually shown.
    const waits = wireTools().filter((t) =>
      Object.values(
        (t.inputSchema.properties ?? {}) as Record<
          string,
          { description?: string }
        >
      ).some((p) => p.description?.startsWith("Wait for session CHANGES"))
    );
    // The wait tool and nothing else (an old name of it would be listed too).
    expect(waits.map((t) => t.name)).toEqual(["synap_wait_for_answer"]);
    const events = (
      waits[0]!.inputSchema.properties as Record<
        string,
        { description: string; items?: { enum?: string[] } }
      >
    ).events!;
    const text = events.description;
    for (const kind of SESSION_CHANGE_KINDS) expect(text).toContain(kind);
    expect(text).toMatch(/EVERY event carries `wake`/);
    expect(events.items?.enum).toEqual([...SESSION_CHANGE_KINDS, "all"]);
  });
});
