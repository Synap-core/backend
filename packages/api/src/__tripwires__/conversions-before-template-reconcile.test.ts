/**
 * TRIPWIRE — at boot, ontology conversions run BEFORE the template reconcile.
 *
 * `runConversions` (apps/api/src/index.ts) backfills the retirement tombstone
 * (`ui_hints.retired`) on rows an earlier destructive tail deactivated
 * (packages/database/src/conversions/retirement-backfill.ts). The template
 * reconcile (`reconcileWorkspacesToTemplates`, reached only through
 * `runStartupHooks()`) calls resolveProfileForApply, which REVIVES an inactive
 * row with no tombstone. If the reconcile ran first, it would revive a
 * merged-away workspace seat before the backfill could protect it.
 *
 * Asserted:
 *  1. index.ts calls `runConversions(` exactly once and `runStartupHooks(`
 *     exactly once (both anchors, non-vacuity), and the conversions call comes
 *     first in source order;
 *  2. the conversions call sits in an AWAITED top-level IIFE
 *     (`await (async () => {`), so source order is execution order — the module
 *     does not evaluate past it until conversions settle;
 *  3. `reconcileWorkspacesToTemplates(` is CALLED only from
 *     apps/api/src/startup-hooks.ts, and `runStartupHooks(` only from
 *     apps/api/src/index.ts (derived by scanning every non-test .ts under
 *     apps/api/src and packages/{api,jobs,database}/src).
 *
 * WHAT IT CANNOT SEE:
 *  - that the IIFE's `await` is at module top level rather than nested in a
 *    non-awaited function (it checks only the text immediately before the
 *    nearest preceding `(async () => {`);
 *  - a call reached through an alias (`const r = reconcileWorkspacesToTemplates; r()`),
 *    dynamic import, or string-built name;
 *  - trailing `//` comments on a code line (only whole-line and block comments
 *    are stripped) — a comment mentioning an anchor there fails LOUD via the
 *    exactly-once count, never silently;
 *  - a second process/entrypoint that runs the reconcile without conversions.
 *
 * `TRIPWIRE_BOOT_INDEX_PATH` redirects the index.ts read (negative controls on
 * a temp copy only).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BACKEND = join(__dirname, "..", "..", "..", "..");
const INDEX =
  process.env.TRIPWIRE_BOOT_INDEX_PATH ??
  join(BACKEND, "apps", "api", "src", "index.ts");

const SCAN_ROOTS = [
  "apps/api/src",
  "packages/api/src",
  "packages/jobs/src",
  "packages/database/src",
].map((r) => join(BACKEND, r));

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function indicesOf(code: string, re: RegExp): number[] {
  return [...code.matchAll(re)].map((m) => m.index ?? -1);
}

const CONVERSIONS_CALL = /\brunConversions\s*\(/g;
const HOOKS_CALL = /\brunStartupHooks\s*\(/g;

/** Why the boot order is wrong, or null when conversions provably come first. */
export function bootOrderViolation(src: string): string | null {
  const code = stripComments(src);
  const conv = indicesOf(code, CONVERSIONS_CALL);
  const hooks = indicesOf(code, HOOKS_CALL);
  if (conv.length !== 1) {
    return `expected exactly one runConversions( call, found ${conv.length}`;
  }
  if (hooks.length !== 1) {
    return `expected exactly one runStartupHooks( call, found ${hooks.length}`;
  }
  if (conv[0] > hooks[0]) {
    return "runConversions( comes AFTER runStartupHooks( — the template reconcile would run before the retirement backfill";
  }
  const iife = code.lastIndexOf("(async () => {", conv[0]);
  if (
    iife === -1 ||
    !/await\s+$/.test(code.slice(Math.max(0, iife - 16), iife))
  ) {
    return "runConversions( is not inside an awaited `await (async () => {` IIFE — source order no longer proves execution order";
  }
  return null;
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, acc);
    else if (
      p.endsWith(".ts") &&
      !p.endsWith(".test.ts") &&
      !p.endsWith(".d.ts")
    )
      acc.push(p);
  }
  return acc;
}

/** Files that CALL `name(` — a `function name(` definition is not a call. */
function callers(files: string[], name: string): string[] {
  const call = new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`);
  return files
    .filter((f) => call.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => relative(BACKEND, f).split(/[\\/]/).join("/"))
    .sort();
}

describe("boot: conversions run before the template reconcile", () => {
  it("self-check: the order check accepts the right shape and rejects the swapped one", () => {
    const good = `await (async () => {\n  const s = await runConversions(sql, m, o);\n})();\nrunStartupHooks().catch(() => {});\n`;
    const swapped = `runStartupHooks().catch(() => {});\nawait (async () => {\n  const s = await runConversions(sql, m, o);\n})();\n`;
    const notAwaited = `(async () => {\n  const s = await runConversions(sql, m, o);\n})();\nrunStartupHooks().catch(() => {});\n`;
    expect(bootOrderViolation(good)).toBeNull();
    expect(bootOrderViolation(swapped)).toMatch(/AFTER/);
    expect(bootOrderViolation(notAwaited)).toMatch(/awaited/);
    expect(bootOrderViolation("")).toMatch(/exactly one runConversions/);
  });

  it("apps/api/src/index.ts awaits runConversions( before runStartupHooks(", () => {
    const src = readFileSync(INDEX, "utf8");
    expect(src.length, `could not read ${INDEX}`).toBeGreaterThan(1000);
    expect(bootOrderViolation(src)).toBeNull();
  });

  it("the template reconcile is reachable only through runStartupHooks, and that only from index.ts", () => {
    const files = SCAN_ROOTS.flatMap((r) => tsFiles(r));
    // Non-vacuity: the scan sees the tree, and the definitions exist.
    expect(files.length).toBeGreaterThan(200);
    const defs = files.filter((f) =>
      /export async function reconcileWorkspacesToTemplates\s*\(/.test(
        readFileSync(f, "utf8")
      )
    );
    expect(defs.map((f) => relative(BACKEND, f))).toEqual([
      "apps/api/src/startup/reconcile-workspaces-to-templates.ts",
    ]);

    expect(callers(files, "reconcileWorkspacesToTemplates")).toEqual([
      "apps/api/src/startup-hooks.ts",
    ]);
    expect(callers(files, "runStartupHooks")).toEqual([
      "apps/api/src/index.ts",
    ]);
  });
});
