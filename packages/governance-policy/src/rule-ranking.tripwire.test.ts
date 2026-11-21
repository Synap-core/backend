/**
 * ONE ranking of approval rows (finding ac28928c). The resolver the gate runs,
 * the pod-wide action-mode read and pod admin's tool page each import it from
 * `rule-ranking.ts`; none keeps a ranking of its own. `readActionModes` did
 * (deny > auto > propose), so the tool page could read "runs on its own"
 * where the gate asked first.
 *
 * Scanned, comments stripped: each reader imports the shared function and
 * spells no verdict order of its own (`=== "deny" ? 2`, a local
 * `verdictStrictness` / `principalSpecificity`, or a find-chain that prefers
 * one verdict to another).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "../../../scripts/strip-comments.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/** Every reader of approval rows that decides a verdict, and what it must import. */
const READERS: Array<{ file: string; imports: RegExp }> = [
  {
    file: "packages/database/src/utils/resolve-agent-governance-decision.ts",
    imports: /\bverdictStrictness\b[\s\S]*?from "@synap\/governance-policy"/,
  },
  {
    file: "packages/api/src/services/governance/action-mode.ts",
    imports:
      /\bdecidingCapabilityRule\b[\s\S]*?from "@synap\/governance-policy"/,
  },
  {
    file: "apps/pod-admin/lib/governance-rules/tool-approvals-model.ts",
    imports:
      /\bdecidingCapabilityRule\b[\s\S]*?from "@synap\/governance-policy\/rule-ranking"/,
  },
];

/** A verdict order spelled by hand. */
const LOCAL_RANKING = [
  /function\s+verdictStrictness\b/,
  /function\s+principalSpecificity\b/,
  /===\s*"deny"\s*\?\s*\d/,
  /\.find\(\s*\([^)]*\)\s*=>\s*[^)]*\.verdict\s*===\s*"(deny|auto|propose)"\s*\)\s*\?\?/,
];

const read = (file: string) =>
  stripComments(readFileSync(join(ROOT, file), "utf8"), "ts") as string;

describe("one ranking of approval rows", () => {
  it("the scan sees a hand-spelled order (fixture)", () => {
    const fixture = `const r = rows.find((r) => r.verdict === "deny") ?? rows[0];
function verdictStrictness(v) { return v === "deny" ? 2 : 0; }`;
    expect(LOCAL_RANKING.filter((re) => re.test(fixture))).toHaveLength(3);
  });

  for (const { file, imports } of READERS) {
    it(`${file} ranks with the shared function, never its own`, () => {
      const src = read(file);
      expect(src, "imports the shared ranking").toMatch(imports);
      for (const re of LOCAL_RANKING)
        expect(src, `no local ranking (${re})`).not.toMatch(re);
    });
  }
});
