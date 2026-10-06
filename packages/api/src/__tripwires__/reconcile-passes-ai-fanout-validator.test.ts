import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TRIPWIRE — every `reconcileWorkspaceFromDefinition({...})` call in the API
 * passes `validateFlow: unfilteredAiFanoutError`.
 *
 * `@synap/database` cannot import `@synap-core/types`, so the reconcile accepts
 * the AI fan-out filter rule as an injected `validateFlow`. A call that omits
 * it would seed template automations past the rule every other flow door runs
 * (`flow-doors-check-ai-fanout.test.ts`).
 *
 * The call set is DERIVED (every non-test file under api/src). Granularity is
 * the CALL: calls and `validateFlow: unfilteredAiFanoutError` occurrences are
 * counted per file and must match. It does not see a call made through an
 * alias of the function, nor a validator that is passed but wrong.
 */
const API_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const strip = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p) => p);

function sites() {
  return walk(API_SRC).flatMap((f) => {
    const src = strip(readFileSync(f, "utf8"));
    const calls = (src.match(/\breconcileWorkspaceFromDefinition\(\{/g) ?? [])
      .length;
    if (calls === 0) return [];
    const passed = (
      src.match(/validateFlow:\s*unfilteredAiFanoutError\b/g) ?? []
    ).length;
    return [{ file: relative(API_SRC, f).replace(/\\/g, "/"), calls, passed }];
  });
}

describe("tripwire: reconcile callers inject the AI fan-out rule", () => {
  it("finds the known callers (non-vacuity)", () => {
    const files = sites().map((s) => s.file);
    for (const known of [
      "services/workspace-creation-service.ts",
      "services/compose-overlay.ts",
      "routers/workspaces/definition-engine.ts",
    ]) {
      expect(files, `the scan no longer sees ${known}`).toContain(known);
    }
  });

  it("every call passes validateFlow", () => {
    expect(
      sites()
        .filter((s) => s.passed < s.calls)
        .map((s) => `${s.file}: ${s.passed}/${s.calls}`)
    ).toEqual([]);
  });
});
