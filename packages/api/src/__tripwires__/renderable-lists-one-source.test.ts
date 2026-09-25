/**
 * TRIPWIRE — no hand-written list of renderables outside the ONE catalog
 * (`@synap-core/types/renderables`, plan §4 "Renderables", §5.2 W7).
 *
 * The plan counted 11 lists of renderable things that disagreed (a bento list
 * of 18 keys against a frontend of 80; the IS teaching 6 keys that did not
 * exist). Each was folded into a derivation from the catalog; this keeps it so.
 *
 * Scan set: DERIVED by walking synap-backend (packages, apps), the IS apps and
 * the CLI (non-test `.ts/.tsx/.mjs`). It parses each file and flags every array
 * literal holding ≥ 4 string literals that are catalog keys (widget, view or
 * fence) making up ≥ half its elements. The key set is imported from the
 * catalog itself, so a new key joins the scan by existing.
 * The web repos (synap-app, browser) are W7b's scan.
 *
 * Blind spots (measured): a list of ≤ 3 keys (e.g. the `grid|list|table`
 * display-mode preference, which names UI modes, not renderables), and a list
 * built from non-literal elements.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import {
  FENCE_RENDERABLE_KEYS,
  VIEW_TYPE_KEYS,
  WIDGET_TYPE_KEYS,
} from "@synap-core/types/renderables";

const MONOREPO = join(import.meta.dirname, "..", "..", "..", "..", "..");
const ROOTS = [
  "synap-backend/packages",
  "synap-backend/apps",
  "synap-intelligence-service/apps",
  "synap-cli/src",
].filter((r) => existsSync(join(MONOREPO, r)));
const SOURCE = "synap-backend/packages/types/src/renderables/";

/**
 * Hand lists that cannot be derived YET, each with the reason. A listed file
 * that no longer holds a list fails ("stale"), so this set only shrinks.
 */
const PENDING: Record<string, string> = {
  "synap-intelligence-service/apps/intelligence-hub/src/tools/workspace/create-view-tool.ts":
    "IS resolves @synap-core/types 1.4.0 from the registry (no /renderables) until types ≥1.12 is published and bumped (W3 handoff)",
  "synap-intelligence-service/apps/intelligence-hub/src/tools/actions/update-workspace.ts":
    "same: types publish",
  "synap-intelligence-service/apps/intelligence-hub/src/tools/actions/propose-workspace.ts":
    "same: types publish",
};

const KEYS = new Set<string>([
  ...WIDGET_TYPE_KEYS,
  ...VIEW_TYPE_KEYS,
  ...FENCE_RENDERABLE_KEYS,
]);
const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "generated",
  "__tests__",
  "__fixtures__",
]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      /\.(ts|tsx|mjs)$/.test(name) &&
      !/\.(test|spec)\.|\.d\.ts$/.test(name)
    )
      out.push(full);
  }
}

/** Every array literal in `src` that reads as a list of catalog keys. */
function handLists(fileName: string, src: string): string[][] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true);
  const found: string[][] = [];
  const visit = (n: ts.Node) => {
    if (ts.isArrayLiteralExpression(n)) {
      const keys = n.elements
        .filter(ts.isStringLiteral)
        .map((e) => e.text)
        .filter((t) => KEYS.has(t));
      if (keys.length >= 4 && keys.length * 2 >= n.elements.length)
        found.push(keys);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const files: string[] = [];
for (const r of ROOTS) walk(join(MONOREPO, r), files);
const byFile = new Map<string, string[][]>();
for (const full of files) {
  const src = readFileSync(full, "utf8");
  if (!/["'](table|kanban|stat-card|chart-|list|mermaid)/.test(src)) continue;
  const lists = handLists(full, src);
  if (lists.length) byFile.set(relative(MONOREPO, full), lists);
}

describe("tripwire: one renderables source", () => {
  it("non-vacuous: walks the repos and sees the catalog's own lists", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(KEYS.size).toBeGreaterThan(80);
    expect([...byFile.keys()].some((f) => f.startsWith(SOURCE))).toBe(true);
    expect(
      handLists("x.ts", 'const v = z.enum(["table","kanban","list","grid"]);')
    ).toHaveLength(1);
    // three keys (a display-mode preference) are below the floor
    expect(handLists("x.ts", 'z.enum(["grid","list","table"])')).toEqual([]);
  });

  it("no hand list of renderables outside the catalog", () => {
    const offenders = [...byFile.keys()].filter(
      (f) => !f.startsWith(SOURCE) && !(f in PENDING)
    );
    expect(offenders).toEqual([]);
  });

  it("every pending entry still holds its list (the set only shrinks)", () => {
    for (const f of Object.keys(PENDING))
      if (existsSync(join(MONOREPO, f)))
        expect(byFile.has(f), `stale: ${f}`).toBe(true);
  });
});
