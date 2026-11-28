/**
 * TRIPWIRE: a run that stopped at its budget (`failed` + `stop_reason =
 * 'budget'`, its token budget or step limit) is told apart by ONE rule in the
 * API: `budgetStopWhere` in `services/runs/index.ts` (#1369). The run groups,
 * the failing flows, the health read's stopped flows and the automation
 * dispatch footprint (`childStopped7d`) all count with it. A second copy of
 * the predicate is how a count drifts: `automation-dispatch.ts` carried its
 * own (`IS DISTINCT FROM 'budget'` / `= 'budget'`) until W0-g.
 *
 * DERIVED: every non-test `.ts` under the API's source roots is scanned
 * (comments stripped) for a `stop_reason` / `stopReason` compared with the
 * literal `'budget'`; only the rule's own file may hold one.
 *
 * WHAT IT DOES NOT SEE, stated: `packages/jobs` (the automation breaker reads
 * `stopReason IS DISTINCT FROM 'budget'` itself: the jobs package cannot import
 * @synap/api, so sharing the rule there means moving it to @synap/database
 * first), and a predicate built from a variable holding `'budget'`.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

/** `src/__tripwires__` → src → api → packages → synap-backend. */
const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const ROOTS = ["apps/api/src", "packages/api/src"];
const THE_RULE = "packages/api/src/services/runs/index.ts";

/** `stop_reason` / `stopReason}` compared with the literal 'budget'. */
const INLINE_BUDGET_STOP =
  /stop_?reason\}?\s*(?:=|is\s+(?:not\s+)?distinct\s+from)\s*'budget'/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function scan(): { scanned: number; hits: string[] } {
  let scanned = 0;
  const hits: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(BACKEND_ROOT, root))) {
      scanned += 1;
      const src = stripComments(readFileSync(file, "utf8"), "ts");
      if (INLINE_BUDGET_STOP.test(src))
        hits.push(relative(BACKEND_ROOT, file).split("\\").join("/"));
    }
  }
  return { scanned, hits };
}

describe("one budget-stop rule in the API", () => {
  it("SELF-GUARD: the detector sees each inline form, and the rule itself", () => {
    expect(
      INLINE_BUDGET_STOP.test(
        "${playbookRuns.stopReason} IS DISTINCT FROM 'budget'"
      )
    ).toBe(true);
    expect(INLINE_BUDGET_STOP.test("${t.stopReason} = 'budget'")).toBe(true);
    expect(INLINE_BUDGET_STOP.test("and stop_reason = 'budget'")).toBe(true);
    expect(INLINE_BUDGET_STOP.test("stopReason: 'budget'")).toBe(false);
    const rule = stripComments(
      readFileSync(join(BACKEND_ROOT, THE_RULE), "utf8"),
      "ts"
    );
    expect(rule).toContain("export function budgetStopWhere(");
    expect(INLINE_BUDGET_STOP.test(rule)).toBe(true);
  });

  it("only budgetStopWhere compares a stop reason with 'budget'", () => {
    const { scanned, hits } = scan();
    expect(scanned).toBeGreaterThan(500);
    expect(
      hits.filter((f) => f !== THE_RULE),
      "Count budget stops with budgetStopWhere (services/runs/index.ts), " +
        "never a copy of its predicate."
    ).toEqual([]);
  });
});
