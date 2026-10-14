/**
 * TRIPWIRE — every rung the dry-run can name has words.
 *
 * The matrix's why-drawer says "Decided by: <words>" from
 * `resolveGovernanceRungLabel` (`@synap-core/types/vocabulary`), keyed by
 * `GOVERNANCE_RUNGS` (`@synap-core/types/agent-matrix`). The PRODUCER is
 * `dryRunAgentGovernanceDecision` + `reasonToRung` in `@synap/database`, which
 * returns bare string literals. This scan derives the producer's rung literals
 * from its source and fails when one is missing from the list (a new rung would
 * otherwise reach a person humanized from its token) or when the list carries a
 * rung the producer no longer names.
 *
 * What it can see: kebab-case literals and `"default"` returned/assigned in the
 * slice from `export async function dryRunAgentGovernanceDecision` to the end of
 * `reasonToRung`. What it cannot: a rung computed at runtime (none today) or
 * one returned from a helper outside that slice.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GOVERNANCE_RUNGS } from "@synap-core/types/agent-matrix";

const SOURCE = path.resolve(
  __dirname,
  "../../../../../database/src/utils/resolve-agent-governance-decision.ts"
);

function producerRungs(src: string): Set<string> {
  const start = src.indexOf("export async function dryRunAgentGovernanceDecision");
  const fnStart = src.indexOf("function reasonToRung");
  const end = src.indexOf("\n}\n", fnStart);
  expect(start).toBeGreaterThan(0);
  expect(fnStart).toBeGreaterThan(start);
  const slice = src.slice(start, end);
  const found = new Set<string>();
  for (const m of slice.matchAll(/"([a-z][a-z0-9]*(?:-[a-z0-9]+)+)"/g)) found.add(m[1]!);
  for (const m of slice.matchAll(/(?:return|rung:|:)\s*"(default)"/g)) found.add(m[1]!);
  return found;
}

describe("governance rung words cover what the dry-run names", () => {
  const found = producerRungs(readFileSync(SOURCE, "utf8"));

  it("the scan still sees the producer (non-vacuity + a literal sample)", () => {
    expect(found.size).toBeGreaterThanOrEqual(15);
    expect(found.has("governance-rule")).toBe(true);
    expect(found.has("default")).toBe(true);
  });

  it("every rung the producer names is in GOVERNANCE_RUNGS, and nothing more", () => {
    expect([...found].sort()).toEqual([...GOVERNANCE_RUNGS].sort());
  });
});
