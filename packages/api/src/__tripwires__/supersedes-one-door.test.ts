import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — `supersedes` has ONE door, shared by MCP and Hub REST (plan
 * 8032a127 D3).
 *
 * A filing that replaces a failed proposal is checked (same person, failed,
 * no partly-applied plan: `supersedesProblem`) and run under the slot the
 * insert door claims (`runWithSupersedes`) by `fileSuperseding`
 * (`services/proposals/supersedes-door.ts`). The MCP adapter and the Hub REST
 * wrapper (the Intelligence Service's door) both call it. A door that called
 * the two primitives itself would be a second copy of the rule, free to
 * drift.
 *
 * If this fails: call `fileSuperseding` from your door. Do NOT add your file
 * to the allowlist. Reachability of the Hub door is pinned by
 * `hub-protocol/_middleware/supersedes.reach.test.ts`, of the MCP door by
 * `routers/mcp/__tests__/supersedes-adapter.pglite.test.ts`.
 */

const ONE_DOOR = "services/proposals/supersedes-door.ts";
const PRIMITIVES = ["runWithSupersedes(", "supersedesProblem("];
const DOORS = [
  "routers/mcp/adapter.ts",
  "routers/hub-protocol/_middleware/supersedes.ts",
];

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

describe("tripwire: supersedes has one door (fileSuperseding)", () => {
  const srcRoot = join(process.cwd(), "src");

  it("only the door calls the supersedes primitives in api/src", () => {
    const callers = tsFiles(srcRoot)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return PRIMITIVES.some((token) => src.includes(token));
      })
      .map((f) => relative(srcRoot, f));
    // Non-vacuity: the door itself is found by the same scan.
    expect(callers).toContain(ONE_DOOR);
    expect(callers.filter((rel) => rel !== ONE_DOOR)).toEqual([]);
  });

  it("the MCP and Hub REST doors both file through it", () => {
    for (const door of DOORS) {
      const src = readFileSync(join(srcRoot, door), "utf8");
      expect(src, door).toContain("fileSuperseding(");
    }
  });
});
