import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { stripComments } from "../../../scripts/strip-comments.mjs";

/**
 * One chip per filter (page-grammar §9, decision afab5911, founder
 * 2026-11-05): a filter is ONE chip that shows its value and opens a menu
 * (`components/filter-chip.tsx`), never a row of pressed chips, one per
 * value. Before this wave nine pod admin lists drew their filters as such a
 * row (`FilterChips`).
 *
 * What this fails on, in every .tsx of the app (walked, never listed):
 *   1. a hand-made row: a `.map(` whose callback draws an element with
 *      `aria-pressed`, inside a component that shows a FILTER's signs;
 *   2. a `SegmentedChoice` (the kept segmented control, for choices that are
 *      not filters) fed a filter's values;
 *   3. the retired `FilterChips` component coming back.
 *
 * A filter's signs (what tells it from a view switch, a grouping or a
 * setting, which may stay segmented): an "All" value (`"all"`, `"All…"`,
 * `t("….all")`, `ALL`), a count per value (`count:`, `counts[`), or values
 * taken from a model's filter list (`*_FILTERS`, `*_SEGMENTS`). For a hand-made
 * row the evidence is the whole top-level declaration around the `.map(`;
 * for a `SegmentedChoice` it is the element plus the `const` its `options`
 * names in the same file.
 *
 * NOT covered, measured: a row of HeroUI `Chip`s or `Tabs` used as a filter
 * (no `aria-pressed`), a pressed row drawn through another local component
 * (`<ChoiceCard selected>` mapped), and options imported from another file
 * under a name with no filter sign (the `const` is resolved in the same
 * file only). The negative controls in the PR body revert one conversion each
 * way (1 and 2) and watch this go red.
 */

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "__tripwires__",
  ".turbo",
  "coverage",
]);

/** The two doors, where a pressed segment is the component itself. */
const DOOR_FILES = new Set([
  "app/(admin)/components/filter-chip.tsx",
  "app/(admin)/components/segmented-choice.tsx",
]);

function tsxFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".tsx") && !/\.test\.tsx$/.test(entry))
        out.push(full);
    }
  };
  walk(APP_ROOT);
  return out;
}

const FILTER_SIGNS: Array<[string, RegExp]> = [
  ['an "all" key', /(["'`])all\1/],
  ['an "All…" label', /["'`]All\b/],
  ["a translated All", /\.all["'`]/],
  ["an ALL constant", /\bALL(_[A-Z]+)?\b/],
  ["a count per value", /\bcount\s*:|\bcounts\s*\[/],
  ["a model's filter list", /\b[A-Z][A-Z0-9_]*_(FILTERS|SEGMENTS)\b/],
];

function filterSigns(evidence: string): string[] {
  const text = stripComments(evidence, "ts");
  return FILTER_SIGNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

interface RowSite {
  kind: "hand-made pressed row" | "SegmentedChoice";
  line: number;
  signs: string[];
}

function hasPressedJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isJsxAttribute(n) && n.name.getText() === "aria-pressed") {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function topLevelStatement(node: ts.Node): ts.Node {
  let n = node;
  while (n.parent && !ts.isSourceFile(n.parent)) n = n.parent;
  return n;
}

function tagName(n: ts.Node): string | null {
  if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n))
    return n.tagName.getText();
  return null;
}

/** Every row of chips in one source file, with the filter signs it shows. */
function rowSites(source: string, fileName = "x.tsx"): RowSite[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const consts = new Map<string, string>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer)
      consts.set(n.name.text, n.initializer.getText(sf));
    ts.forEachChild(n, collect);
  };
  collect(sf);

  const sites: RowSite[] = [];
  const lineOf = (n: ts.Node) =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "map" &&
      n.arguments.length > 0 &&
      hasPressedJsx(n.arguments[0]!)
    ) {
      sites.push({
        kind: "hand-made pressed row",
        line: lineOf(n),
        signs: filterSigns(topLevelStatement(n).getText(sf)),
      });
    }
    if (tagName(n) === "SegmentedChoice") {
      const attrs = (n as ts.JsxSelfClosingElement | ts.JsxOpeningElement)
        .attributes;
      let evidence = n.getText(sf);
      for (const a of attrs.properties) {
        if (!ts.isJsxAttribute(a) || a.name.getText() !== "options") continue;
        const init = a.initializer;
        if (init && ts.isJsxExpression(init) && init.expression) {
          const root = init.expression.getText(sf).match(/^[A-Za-z_$][\w$]*/);
          if (root && consts.has(root[0])) evidence += consts.get(root[0]);
        }
      }
      sites.push({
        kind: "SegmentedChoice",
        line: lineOf(n),
        signs: filterSigns(evidence),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

const FILES = tsxFiles().map((path) => ({
  path: relative(APP_ROOT, path),
  body: readFileSync(path, "utf8"),
}));

const SCANNED = FILES.filter((f) => !DOOR_FILES.has(f.path)).map((f) => ({
  path: f.path,
  sites: rowSites(f.body, f.path),
}));

describe("pod admin: one chip per filter", () => {
  it("walks the app (a walker that finds nothing proves nothing)", () => {
    expect(FILES.length).toBeGreaterThan(150);
    for (const door of DOOR_FILES)
      expect(FILES.some((f) => f.path === door)).toBe(true);
  });

  it("the detector still sees what it hunts, and lets a view switch be", () => {
    const handMade = rowSites(`
      export function Bad({ filter }) {
        return STATUS_FILTERS.map((f) => (
          <button aria-pressed={f.key === filter}>{f.label}</button>
        ));
      }`);
    expect(handMade).toHaveLength(1);
    expect(handMade[0]!.signs).toContain("a model's filter list");

    const segmented = rowSites(`
      const OPTS = [{ key: "all", label: "All" }, { key: "x", label: "X" }];
      export const P = () => <SegmentedChoice options={OPTS} active="all" onSelect={f} />;`);
    expect(segmented).toHaveLength(1);
    expect(segmented[0]!.signs.length).toBeGreaterThan(0);

    const viewSwitch = rowSites(`
      function ViewSwitch({ view }) {
        const options = [{ key: "list", label: "List" }, { key: "grid", label: "Grid" }];
        return options.map((o) => <button aria-pressed={o.key === view}>{o.label}</button>);
      }`);
    expect(viewSwitch).toHaveLength(1);
    expect(viewSwitch[0]!.signs).toEqual([]);
  });

  it("the scan reaches real rows: the kept segmented choices and the filter chips", () => {
    const all = SCANNED.flatMap((f) => f.sites);
    // Review's group-by, a package's layout, Settings › Review (3): choices, not filters.
    expect(
      all.filter((s) => s.kind === "SegmentedChoice").length
    ).toBeGreaterThanOrEqual(4);
    // The nine inventory rows (backend 7e6055f9f) minus Review's tabs.
    const chipUses = FILES.reduce(
      (n, f) => n + (f.body.match(/<FilterChip\b/g)?.length ?? 0),
      0
    );
    expect(chipUses).toBeGreaterThanOrEqual(8);
  });

  it("no filter is drawn as a row of pressed chips", () => {
    const offenders = SCANNED.flatMap((f) =>
      f.sites
        .filter((s) => s.signs.length > 0)
        .map(
          (s) =>
            `${f.path}:${s.line} ${s.kind} shows ${s.signs.join(", ")}: a filter is ONE FilterChip (components/filter-chip.tsx)`
        )
    );
    expect(offenders).toEqual([]);
  });

  it("the retired FilterChips row does not come back", () => {
    const back = FILES.filter((f) =>
      /\bFilterChips\b|components\/filter-chips\b/.test(
        stripComments(f.body, "ts")
      )
    ).map((f) => f.path);
    expect(back).toEqual([]);
  });
});
