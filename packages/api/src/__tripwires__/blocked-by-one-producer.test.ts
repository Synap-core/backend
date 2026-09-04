import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TRIPWIRE — `blocked_by` has ONE producer.
 *
 * The readers in `session-blocked-by.ts` carry no owner floor of their own:
 * they are safe because the single producer floors BOTH endpoints, so an edge
 * can only ever join two sessions of the same owner. A second producer that
 * floors differently would silently turn every read into a cross-user
 * disclosure. This scan makes that a red gate instead of a comment.
 */
const ROOTS = [
  join(__dirname, ".."),
  join(__dirname, "..", "..", "..", "database", "src"),
  join(__dirname, "..", "..", "..", "jobs", "src"),
];
const PRODUCER = "services/focus-sessions/session-blocked-by.ts";

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

describe("tripwire: blocked_by edges are written by exactly one producer", () => {
  it("no insert-shaped `blocked_by` literal exists outside session-blocked-by.ts", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      let files: string[] = [];
      try {
        files = walk(root);
      } catch {
        continue;
      }
      for (const file of files) {
        const rel = relative(root, file).replace(/\\/g, "/");
        if (rel.endsWith(PRODUCER)) continue;
        const src = readFileSync(file, "utf8");
        // A producer stamps the type on a values object; readers compare it.
        if (/linkType:\s*["']blocked_by["']/.test(src)) offenders.push(rel);
      }
    }
    expect(offenders, "second blocked_by producer(s)").toEqual([]);
  });

  it("the one producer floors both endpoints on the caller", () => {
    const src = readFileSync(join(ROOTS[0]!, PRODUCER), "utf8");
    // Both handles are caller-supplied, so both must be loaded under userId.
    const floors = src.match(/eq\(focusSessions\.userId,\s*\w+\)/g) ?? [];
    expect(
      floors.length,
      "owner-floor predicates on focusSessions"
    ).toBeGreaterThanOrEqual(1);
    expect(src).toMatch(/inArray\(focusSessions\.id,|eq\(focusSessions\.id,/);
  });
});
