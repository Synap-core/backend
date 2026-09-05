import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — `market.install({kind:"template"})` must apply LAYER 2.
 *
 * A workspace package has two layers:
 *   1. profiles / views / bento / entity links — `createWorkspaceFromDefinition`
 *      (via `createWorkspaceFromDefinitionIdempotent`).
 *   2. capabilities / playbooks / automations / loops / cells / actionPlacements
 *      — `applyPackagePostWorkspace`.
 *
 * `createWorkspaceFromDefinitionIdempotent` builds layer 1 ONLY; its own doc
 * (`workspace-creation-service.ts`) states that a caller which also wants the
 * post-workspace layers MUST call `applyPackagePostWorkspace` itself. The
 * browser/Hub door (`hub-protocol/rest/packages.ts`) and the `workspace/create`
 * approve-executor both do. The `case "template"` branch of `applyMarketInstall`
 * — the AGENT door, reached by MCP/CLI `market.install` and by `capability.install`
 * proposal approval — did NOT, for its whole life: it created the workspace and
 * returned, so an agent-installed workspace package silently arrived with zero
 * capabilities, playbooks, automations, loops, cells and action placements while
 * the same package installed from the browser arrived complete. One package, two
 * doors, two different workspaces — the door-parity severance class.
 *
 * This is invisible to `tsc` (dropping a call is type-correct) and to a naive
 * `rg -c applyPackagePostWorkspace marketplace-install.ts`, which reported 1 for
 * a file whose only occurrence was inside a COMMENT. So: a SOURCE SCAN that
 * strips comments and string literals first, and looks only INSIDE the template
 * branch.
 *
 * KNOWN LIMIT, stated so nobody over-trusts this file: it is a SOURCE scan, so
 * it proves the call is WRITTEN in executable code — not that it is REACHABLE.
 * Verified by mutation 2026-09-05: deleting the call turns this red (good), but
 * guarding it with `if (false && …)` still passes. Deletion is the realistic
 * regression and is covered; a deliberately dead-branched call is not. If this
 * branch ever grows a real conditional that could disable layer 2, that gate
 * needs a behavioural test, not another source assertion.
 *
 * If this fails: restore the `applyPackagePostWorkspace` call in
 * `applyMarketInstall`'s `case "template"`. Do NOT satisfy it with a comment,
 * and do NOT delete the assertion — the whole point is that the layer-2 call
 * cannot be dropped again without a red test.
 */

const SOURCE = join(
  process.cwd(),
  "src/services/capabilities/marketplace-install.ts"
);

/**
 * Strip line comments, block comments and string/template literals. Everything
 * that survives is EXECUTABLE source — the exact distinction the original defect
 * hid behind (the door's name was present, but only in prose).
 */
function stripCommentsAndStrings(src: string): string {
  // ALL THREE quote styles in ONE left-to-right pass. Stripping them in
  // sequence is subtly wrong: the single-quote pass treats an apostrophe inside
  // a DOUBLE-quoted string ("…didn't…") as an opening quote and swallows
  // everything to the next apostrophe. That bit a sibling tripwire in the CLI
  // on 2026-09-05 — it failed against correct code. It fails CLOSED (red, not
  // green), so it is confusing rather than dangerous; fixed anyway.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(
      /`(?:\\[\s\S]|[^\\`])*`|'(?:\\.|[^\\'])*'|"(?:\\.|[^\\"])*"/g,
      '""'
    );
}

describe("tripwire: market.install template branch applies post-workspace layer 2", () => {
  const raw = readFileSync(SOURCE, "utf8");
  const stripped = stripCommentsAndStrings(raw);

  it("the template branch calls applyPackagePostWorkspace in EXECUTABLE code", () => {
    // Which `case "..."` is the template one, by order in the raw source.
    const rawCases = [...raw.matchAll(/case\s+"([a-z]+)"\s*:\s*\{/g)].map(
      (m) => m[1]
    );
    const templateIndex = rawCases.indexOf("template");
    expect(
      templateIndex,
      'no `case "template": {` branch found in marketplace-install.ts — did the kind switch move?'
    ).toBeGreaterThanOrEqual(0);

    // The same ordinal `case "":` in the stripped source (literals became `""`).
    const strippedCases = [...stripped.matchAll(/case\s+""\s*:\s*\{/g)];
    expect(strippedCases.length).toBe(rawCases.length);
    const start = strippedCases[templateIndex].index!;

    // Brace-match the branch body.
    let depth = 0;
    let end = -1;
    for (let i = stripped.indexOf("{", start); i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(
      end,
      "could not brace-match the template branch body"
    ).toBeGreaterThan(start);
    const body = stripped.slice(start, end);

    // Layer 1 is expected to still be there — if it is not, this test is
    // asserting against a branch that no longer does what it is named for.
    expect(
      body.includes("createWorkspaceFromDefinitionIdempotent("),
      "the template branch no longer creates the workspace — this tripwire is stale, fix it deliberately"
    ).toBe(true);

    // Layer 2 — the actual invariant.
    expect(
      body.includes("applyPackagePostWorkspace("),
      "market.install({kind:'template'}) creates the workspace but never applies " +
        "capabilities/playbooks/automations/loops/cells/actionPlacements. Call " +
        "applyPackagePostWorkspace() in the template branch, as " +
        "hub-protocol/rest/packages.ts and proposals/executors/workspace.ts do."
    ).toBe(true);
  });

  it("the layer-2 door is reached through the shared applier, not re-implemented", () => {
    // A re-implementation would call the per-layer appliers directly instead of
    // the ONE shared door — that is how the two install paths drifted apart in
    // the first place.
    expect(stripped.includes("createLoopFromDefinition")).toBe(false);
    expect(stripped.includes("resolveActionPlacementRefs")).toBe(false);
  });
});
