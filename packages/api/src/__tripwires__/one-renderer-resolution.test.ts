/**
 * TRIPWIRE — ONE renderer resolution (renderer bundles, decision c91d26dc).
 *
 * "Which renderer draws this object" is answered ONCE, by
 * `@synap-core/types/renderer-resolution` (`resolveObjectRenderer`, with
 * `resolveEntityRendererOverride` and `readBoundViewCellKey`, the one reading
 * of each stored binding). Until W1 the rule lived in three places of the
 * desktop, each holding part of it; pod admin is about to draw pod content
 * (W4) and must ask the same function, never grow a fourth copy.
 *
 * WHAT IS CHECKED, in every non-test source under `apps/` (pod admin, the
 * API) and `packages/`, comments stripped (`scripts/strip-comments.mjs`):
 *   1. No read of an entity's renderer override: `systemData.renderer`,
 *      `systemData?.renderer` or `systemData["renderer"]` outside the module.
 *      The pod WRITES that field (`entities.setEntityRenderer`, its proposal
 *      executor) through a merge (`{ renderer: ref }`), which is not a read.
 *   2. No file that names `rendererRef` and also tests `kind === "cell"`
 *      outside the module: that pair is a view's cell binding being decided.
 *      Known server-side readers that index or validate bindings, never draw
 *      one, are listed in ALLOWED with their reason, pinned by count.
 *
 * THE SET IS DERIVED (a glob of both trees); the scan asserts it reaches pod
 * admin and that the module itself matches both rules (so neither regex is
 * blind). Its twin in app-bases and the browser scans those trees.
 *
 * WHAT IT CANNOT SEE: a destructured read (`const { renderer } =
 * entity.systemData`), a binding read through a variable name other than
 * `rendererRef`, and a whole-file pair (rule 2) whose two halves are about
 * different things. Delegation (a host running RENDERER_RESOLUTION_CASES
 * through its own adapter) is each host's test, not this scan.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const MODULE_DIR = "packages/types/src/renderer-resolution/";
const MODULE = `${MODULE_DIR}index.ts`;
const POD_ADMIN = "apps/pod-admin/";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
]);
const SOURCE = /\.(?:ts|tsx|js|mjs)$/;
const TEST = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$|__tests__|__tripwires__/;

/** Rule 1: a read of the per-entity override. */
const OVERRIDE_READ =
  /\bsystemData\s*\)?\s*\??\.\s*renderer\b|\bsystemData\s*\)?\s*(?:\?\.)?\s*\[\s*["'`]renderer["'`]\s*\]/;
/** Rule 2, both halves: a view binding named, and a cell kind tested. */
const BINDING_NAMED = /\brendererRef\b/;
const CELL_KIND_TESTED =
  /\bkind\s*[!=]==?\s*["'`]cell["'`]|["'`]cell["'`]\s*[!=]==?\s*[\w.?]*\bkind\b/g;

/** Server-side readers of bindings that never decide what draws (file → count of cell tests). */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "packages/api/src/services/surfaces/renderer-usage.ts": {
    count: 2,
    why: "the reverse index of where each renderer is bound (usage counts, dangling keys); it reads a stored ref's key, it draws nothing",
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return SOURCE.test(name) ? [p] : [];
  });
}

describe("tripwire: one renderer resolution", () => {
  const files = ["apps", "packages"]
    .flatMap((d) => sourceFiles(join(REPO, d)))
    .map((abs) => ({ abs, rel: relative(REPO, abs).split("\\").join("/") }))
    .filter(({ rel }) => !TEST.test(rel));
  const code = new Map(
    files.map(({ abs, rel }) => [
      rel,
      stripComments(readFileSync(abs, "utf8"), "ts"),
    ])
  );
  const outside = [...code.keys()].filter((rel) => !rel.startsWith(MODULE_DIR));

  it("the scan reaches pod admin and the module, and both rules still see the module", () => {
    expect(code.size).toBeGreaterThan(500);
    expect(outside.some((rel) => rel.startsWith(POD_ADMIN))).toBe(true);
    const own = code.get(MODULE);
    expect(own, MODULE).toBeDefined();
    expect(OVERRIDE_READ.test(own!)).toBe(true);
    expect(BINDING_NAMED.test(own!)).toBe(true);
    expect((own!.match(CELL_KIND_TESTED) ?? []).length).toBeGreaterThan(0);
    // The regexes, on samples of what they hunt and of what they must not.
    expect(OVERRIDE_READ.test("const r = entity.systemData?.renderer;")).toBe(
      true
    );
    expect(OVERRIDE_READ.test('row.systemData["renderer"]')).toBe(true);
    expect(
      OVERRIDE_READ.test("mergeSystemData(row.systemData, { renderer: ref })")
    ).toBe(false);
    expect('if (ref.kind === "cell")'.match(CELL_KIND_TESTED)).toHaveLength(1);
  });

  it("no source reads an entity's renderer override but the module", () => {
    const offenders = outside.flatMap((rel) => {
      const line = code
        .get(rel)!
        .split("\n")
        .findIndex((l) => OVERRIDE_READ.test(l));
      return line >= 0
        ? [
            `${rel}:${line + 1}: reads systemData.renderer; use resolveEntityRendererOverride`,
          ]
        : [];
    });
    expect(offenders).toEqual([]);
  });

  it("no source decides a view's cell binding but the module (known server readers pinned)", () => {
    const found: Record<string, number> = {};
    for (const rel of outside) {
      const src = code.get(rel)!;
      if (!BINDING_NAMED.test(src)) continue;
      const n = (src.match(CELL_KIND_TESTED) ?? []).length;
      if (n > 0) found[rel] = n;
    }
    expect(found).toEqual(
      Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, v.count]))
    );
  });
});
