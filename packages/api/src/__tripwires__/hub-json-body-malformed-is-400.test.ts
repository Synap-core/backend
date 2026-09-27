import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — a Hub route never folds a MALFORMED request body into the empty
 * default. `c.req.json().catch(() => ({}))` (and `… .catch(() => null)) ?? {}`)
 * made a parse failure indistinguishable from "no body": a truncated
 * `{"restore":true` ARCHIVED a space instead of restoring it (RV1 S1), a
 * malformed `/playbooks/:id/run` body ran the playbook with defaults. The one
 * door is `readJsonBody` (`routers/hub-protocol/rest/_shared.ts`): blank → `{}`,
 * malformed → 400. Behaviour pinned in `rest/workspace-ops.malformed-body.test.ts`.
 *
 * DERIVED: walks every non-test `.ts` under `routers/` (Hub REST, MCP, sync…),
 * so a new file joins the scan by existing.
 *
 * DOES NOT SEE: a hand-written `try { await c.req.json() } catch { return {} }`
 * spread across lines, or a swallow through an intermediate variable. It sees
 * the two one-expression idioms that were the whole class on 2026-09-27 (27 sites).
 */

const ROOT = join(__dirname, "..", "routers");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.includes(".test.")) out.push(p);
  }
  return out;
}

const SWALLOW = [
  /req\.json\(\)\s*\.catch\(\s*\(\)\s*=>\s*\(\s*\{\s*\}\s*\)\s*\)/,
  /req\.json\(\)\s*\.catch\(\s*\(\)\s*=>\s*null\s*\)\s*\)\s*\?\?\s*\{\s*\}/,
];

function offenders(src: string): number {
  // Comments may quote the idiom (the helper's own docstring does).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return code.split("\n").filter((l) => SWALLOW.some((re) => re.test(l)))
    .length;
}

describe("tripwire: malformed request JSON is never the empty default", () => {
  it("self-check: the scan still sees both idioms", () => {
    expect(offenders("const b = await c.req.json().catch(() => ({}));")).toBe(
      1
    );
    expect(
      offenders("x.safeParse((await c.req.json().catch(() => null)) ?? {})")
    ).toBe(1);
    // …and not the honest forms.
    expect(offenders("const b = await c.req.json().catch(() => null);")).toBe(
      0
    );
  });

  it("no route swallows a parse failure into {}", () => {
    const files = walk(ROOT);
    // Non-vacuity: routers/ holds hundreds of files.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith("rest/workspace-ops.ts"))).toBe(true);
    const bad = files
      .map((f) => ({
        f: f.slice(ROOT.length + 1),
        n: offenders(readFileSync(f, "utf8")),
      }))
      .filter((x) => x.n > 0)
      .map((x) => `${x.f} (${x.n})`);
    expect(
      bad,
      "use readJsonBody (rest/_shared.ts): blank → {}, malformed → 400"
    ).toEqual([]);
  });
});
