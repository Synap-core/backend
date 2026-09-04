/**
 * ONE MEMBERSHIP STORE FOR A RULE'S AUTOMATIONS.
 *
 * A rule's behaviours are stored as `skill --activates--> automation` edges.
 * The JSONB copy at `metadata.rule.behaviours[]` keeps ONLY the divergence
 * `flowHash`, keyed by automation id — it is not the membership store and has
 * not been since the edge got its readers.
 *
 * ── THE DIVERGENCE THIS PREVENTS ───────────────────────────────────────────
 * The backend switched to the edge while `synap rule list` kept counting
 * `rule.behaviours.length`. Two doors, two stores, one question. They agree for
 * a rule created today and disagree exactly where the `"unsnapshotted"` status
 * was introduced to name the anomaly: a rule with an edge but no snapshot read
 * `0 attached` on the CLI and `1` in the browser, and the reverse for a
 * snapshot with no edge.
 *
 * So `skills.listRules` must PROJECT `automationIds` from the edge. A client
 * cannot be trusted to derive membership, because the JSONB is right there and
 * looks like it means what it used to mean.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "..");

function read(rel: string): string {
  const path = join(API_SRC, rel);
  if (!existsSync(path)) throw new Error(`guarded file is missing: ${rel}`);
  return readFileSync(path, "utf8");
}

/**
 * Strip `//` line comments and `/* *\/` blocks.
 *
 * Every assertion below scans for CODE. Without this, a doc-comment explaining
 * why `rule.behaviours` must not be read counts as reading it — which is
 * exactly what happened: the "must not derive membership from the JSONB"
 * assertion went red against a correct implementation, matching two comments
 * that said so in prose. A scan that cannot tell code from prose measures prose.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** The body of the named tRPC procedure, up to the next procedure. */
function procedureBody(source: string, name: string): string {
  const at = source.indexOf(`  ${name}: protectedProcedure`);
  if (at === -1) throw new Error(`procedure not found: ${name}`);
  const next = source
    .slice(at + 1)
    .search(/\n  [a-zA-Z]+: (?:protected|workspace|public)Procedure/);
  const body = next === -1 ? source.slice(at) : source.slice(at, at + 1 + next);
  return stripComments(body);
}

describe("a rule's membership has ONE store", () => {
  it("listRules projects automationIds from the EDGE", () => {
    const body = procedureBody(read("routers/skills.ts"), "listRules");
    expect(
      body,
      "`skills.listRules` no longer projects `automationIds`, so every client " +
        "must fall back to counting `rule.behaviours` — the JSONB copy that is " +
        "no longer the membership store."
    ).toMatch(/automationIds:/);
    // The invariant is the SOURCE, not one function's name: the projection
    // must come from the lineage module (which reads the edge), never from the
    // JSONB blob. This assertion named `readRuleAutomationIdsBulk` at first and
    // went red the moment the call was widened to `readRuleHealthBulk` — a
    // correct change. A tripwire pinned to a callee's name tests the spelling;
    // pin the module and the shape of what it must not read instead.
    expect(
      body,
      "the projection must come from `services/rules/lineage` (the edge)"
    ).toMatch(/services\/rules\/lineage/);
    expect(
      body,
      "listRules must not derive membership from the JSONB `behaviours` copy"
    ).not.toMatch(/rule\.behaviours|behaviours\?\.length/);
  });

  it("health is derived from the edge + the automations table, never the JSONB", () => {
    const lineage = stripComments(read("services/rules/lineage.ts"));
    const at = lineage.indexOf("export async function readRuleHealthBulk");
    expect(at, "readRuleHealthBulk not found").toBeGreaterThan(-1);
    const body = lineage.slice(at, at + 3000);
    // Membership through the edge reader, status/lastRun/count from the rows.
    expect(body).toMatch(/readRuleAutomationIdsBulk/);
    expect(body).toMatch(/\.from\(automations\)/);
    expect(
      body,
      "health must not read `metadata.rule.behaviours` — that is the copy the " +
        "edge replaced"
    ).not.toMatch(/behaviours\b/);
  });

  it("the bulk reader queries the activates EDGE, never the JSONB", () => {
    const lineage = stripComments(read("services/rules/lineage.ts"));
    // Module-private (see its docstring): matched without `export` on purpose.
    const at = lineage.indexOf("async function readRuleAutomationIdsBulk");
    expect(at).toBeGreaterThan(-1);
    const body = lineage.slice(at, at + 1800);
    expect(body).toMatch(/\.from\(links\)/);
    expect(body).toMatch(/ACTIVATES/);
    // If this ever reads the skills blob, the "one store" claim is dead.
    expect(
      body,
      "the lineage reader must not read `metadata` — that is the copy it replaced"
    ).not.toMatch(/behaviours|metadata/);
  });

  it("every rule row in the list gets a key, so [] means 'none' not 'unknown'", () => {
    // A caller distinguishing "no automations" from "not asked about" without a
    // second lookup is what lets the CLI fall back ONLY on an older pod.
    const lineage = stripComments(read("services/rules/lineage.ts"));
    const at = lineage.indexOf("async function readRuleAutomationIdsBulk");
    const body = lineage.slice(at, at + 1800);
    expect(body).toMatch(/ruleSkillIds\.map\(\(id\) => \[id, \[\]\]\)/);
  });
});
