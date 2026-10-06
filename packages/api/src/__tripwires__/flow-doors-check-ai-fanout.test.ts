import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TRIPWIRE — every automation flow persist door runs the AI fan-out rule
 * (`unfilteredAiFanoutError`, @synap-core/types/automations).
 *
 * The rule: a `query` feeding a loop whose body starts AI work needs a
 * non-empty filter or an explicit `scope: "all"` (the 2026-10 incident queried
 * every company with an empty filter and started two AI calls per row).
 *
 * The door set is DERIVED: a file that validates a flow for persistence calls
 * `flowValidationErrorMessage(` — the node-contract helper every door already
 * uses. Each such file must also call `unfilteredAiFanoutError(`. A new door
 * joins the scan by existing.
 *
 * Granularity is the FILE: a file with two doors and one check passes. The
 * behaviour of the rule itself is pinned in `ai-dispatch-guardrails.test.ts`
 * (types) and at the router door in `automations-ai-fanout-door.test.ts`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, "..");
const DEFINITION = "services/automations/validate-flow.ts";

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
      continue;
    }
    if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
    out.push(p);
  }
  return out;
}

const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p) => p);

function doors(): Array<{ file: string; checks: boolean }> {
  return walk(API_SRC)
    .map((file) => ({
      file: relative(API_SRC, file).replace(/\\/g, "/"),
      src: stripComments(readFileSync(file, "utf8")),
    }))
    .filter(
      ({ file, src }) =>
        file !== DEFINITION && /\bflowValidationErrorMessage\(/.test(src)
    )
    .map(({ file, src }) => ({
      file,
      checks: /\bunfilteredAiFanoutError\(/.test(src),
    }));
}

describe("tripwire: every flow persist door runs the AI fan-out rule", () => {
  it("finds the known doors (non-vacuity)", () => {
    const files = doors().map((d) => d.file);
    for (const known of [
      "routers/automations.ts",
      "routers/playbooks.ts",
      "routers/sync.ts",
      "services/playbooks/cron-automation.ts",
      "services/rules/compile.ts",
    ]) {
      expect(files, `the scan no longer sees ${known}`).toContain(known);
    }
  });

  it("each door also checks the AI fan-out", () => {
    expect(
      doors()
        .filter((d) => !d.checks)
        .map((d) => d.file),
      "These validate a flow for persistence but never run unfilteredAiFanoutError — " +
        "an AI fan-out over an unfiltered query would persist through them."
    ).toEqual([]);
  });
});
