/**
 * TRIPWIRE — every documents read floor built with `accessScopeWhere` carries
 * `documentFollowsEntity: true` (founder decision 2026-09-25: a document
 * follows its entity; W4a §6).
 *
 * Without it a floor silently UNDER-shows the body of a pod-shared entity: the
 * registered `documents` VisibilityRule admits it, and a hand-built floor
 * elsewhere (diagnose's two probes, until W7a) said "not found". That never
 * leaks, but it makes two doors disagree about the same row.
 *
 * Scan set: DERIVED — every non-test `.ts` under `src/` whose
 * `accessScopeWhere({...})` argument names `documents.workspaceId`.
 * Blind spot (stated): a floor that aliases the column into a variable first
 * is invisible to this scan.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** The `{...}` argument of each `accessScopeWhere(` call (brace-balanced). */
function accessScopeArgs(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/accessScopeWhere\(\s*\{/g)) {
    let depth = 0;
    const start = m.index! + m[0].length - 1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        out.push(src.slice(start, i + 1));
        break;
      }
    }
  }
  return out;
}

const calls = walk(SRC).flatMap((file) =>
  accessScopeArgs(readFileSync(file, "utf8"))
    .filter((arg) => /workspaceIdColumn:\s*documents\.workspaceId\b/.test(arg))
    .map((arg) => ({ file: relative(SRC, file), arg }))
);

describe("tripwire: a document floor follows its entity", () => {
  it("non-vacuous: finds the registry rule and the router floor", () => {
    expect(calls.length).toBeGreaterThanOrEqual(4);
    const files = calls.map((c) => c.file);
    expect(files).toContain("access/registry.ts");
    expect(files).toContain("routers/documents.ts");
    // self-check: the extractor sees a nested object literal to its end
    expect(accessScopeArgs("accessScopeWhere({ a: { b: 1 }, c: 2 })")).toEqual([
      "{ a: { b: 1 }, c: 2 }",
    ]);
  });

  it("every documents floor sets documentFollowsEntity: true", () => {
    const missing = calls
      .filter((c) => !/documentFollowsEntity:\s*true/.test(c.arg))
      .map((c) => c.file);
    expect(missing).toEqual([]);
  });
});
