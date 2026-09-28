/**
 * TRIPWIRE — every writer that mints an agent USER stamps `createdVia`
 * (`users.created_via`, migration 0225).
 *
 * WHY. `agentUsers.list` decides `builtIn` from the origin (`withAgentOrigin`)
 * and Settings › Agents folds or lists an agent on it. OpenClaw add-on
 * activation (`apps/api/.../provision.ts`) and surface-agent provisioning
 * (`routers/intelligence.ts`) never stamped it, so their agents had no origin
 * at all. 0285 backfills the pod's own agents; this keeps new writers honest.
 *
 * HOW (derived, never hand-listed). Every non-test .ts under `packages/api/src`
 * and `apps/api/src` is walked; each object literal that contains
 * `userType: "agent"` (brace-matched from the nearest enclosing `{`) must also
 * contain a `createdVia` key.
 *
 * WHAT IT DOES NOT SEE (measured, not implied): a writer whose `userType` is a
 * variable, or whose values object is built across several statements; braces
 * inside string literals can shift the match (none in the current set).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const ROOTS = ["packages/api/src", "apps/api/src"].map((r) => join(REPO, r));
const SKIP = new Set(["node_modules", "dist", "__tests__", "__tripwires__"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** The object literal around `at`: from the nearest unmatched `{` to its `}`. */
export function enclosingObject(src: string, at: number): string {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (src[i] === "}") depth++;
    else if (src[i] === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return "";
  depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return "";
}

const AGENT_ROW = /userType:\s*"agent"/g;

const writers: Array<{ file: string; object: string }> = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(AGENT_ROW)) {
      writers.push({
        file: relative(REPO, file),
        object: enclosingObject(src, m.index!),
      });
    }
  }
}

describe("every agent-user writer stamps createdVia", () => {
  it("finds the known writers (non-vacuity) and the brace match works", () => {
    expect(writers.length).toBeGreaterThanOrEqual(8);
    expect(writers.map((w) => w.file)).toContain(
      "apps/api/src/routers/provision.ts"
    );
    expect(
      enclosingObject('x({ a: { b: 1 }, userType: "agent", c: 2 })', 20)
    ).toBe('{ a: { b: 1 }, userType: "agent", c: 2 }');
  });

  it("each agent row literal carries createdVia", () => {
    const missing = writers
      .filter((w) => !/\bcreatedVia\s*:/.test(w.object))
      .map((w) => w.file);
    expect(missing).toEqual([]);
  });
});
