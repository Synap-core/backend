/**
 * ONE playbook definition schema — no door re-declares the object.
 *
 * Every door used to write its own `z.object({ name, goalTemplate, ... })`, and
 * zod STRIPS undeclared keys — so each door silently dropped whatever it forgot
 * (scope/stages/criteria/metadata; see playbook-definition-round-trip.test.ts).
 * The fix is structural: the definition lives ONCE in
 * `schemas/playbook-definition.ts` and doors `.extend` it with their own shape.
 * This refuses the regression: any `goalTemplate: z.` in non-test source
 * outside the canonical file (and the named PATCH schemas below) fails.
 *
 * The scanned set is DERIVED (every .ts under src/), never hand-listed.
 *
 * NOT covered (measured by reading): a door that accepts a playbook as an OPEN
 * record (`z.record(...)` — e.g. `workspaces.applyDefinition`) strips nothing,
 * so it is not a re-declaration and is not flagged; a door written in JSON
 * Schema (MCP tool manifests) is not zod and is not scanned.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A `goalTemplate` declared as a zod field, across a line break or not. */
const DECLARES_GOAL_TEMPLATE = /\bgoalTemplate\s*:\s*z\s*\.\s*(string|coerce)/g;

/**
 * Allowed, each for a stated reason. Patch/update schemas are all-optional
 * PATCHES of an existing row, not definitions; the Hub create door is a narrow
 * single-playbook authoring surface (it carries scope + stages).
 */
const ALLOWED: Record<string, string> = {
  "schemas/playbook-definition.ts": "the canonical definition",
  "routers/playbooks.ts": "updateInputSchema — a PATCH (all optional)",
  "services/capabilities/builtin-verbs.ts":
    "playbook.update verb — a strict PATCH",
  "routers/hub-protocol/rest/playbooks.ts":
    "POST /playbooks (+ MCP create_playbook via playbook-doors) — narrow authoring door with OpenAPI descriptions; carries scope + stages. Converting it is a follow-up (it lacks params/criteria/expectedOutputs).",
};

function scan(): Map<string, number> {
  const hits = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        const n = (readFileSync(p, "utf8").match(DECLARES_GOAL_TEMPLATE) ?? [])
          .length;
        if (n > 0) hits.set(relative(SRC, p), n);
      }
    }
  };
  walk(SRC);
  return hits;
}

describe("playbook definition — one schema", () => {
  const hits = scan();

  it("the scan can still see a declaration (non-vacuity)", () => {
    expect(hits.get("schemas/playbook-definition.ts")).toBe(1);
    expect(
      "goalTemplate: z\n    .string()".match(DECLARES_GOAL_TEMPLATE)
    ).toHaveLength(1);
  });

  it("no door re-declares a playbook definition object", () => {
    const offenders = [...hits.keys()].filter((f) => !(f in ALLOWED));
    expect(
      offenders,
      "Extend `playbookDefinitionSchema` / `packagePlaybookDefinitionSchema` " +
        "(schemas/playbook-definition.ts) instead of re-declaring a playbook " +
        "z.object — a re-declared object strips every field it forgets."
    ).toEqual([]);
  });

  it("the canonical definition is not duplicated inside the allowed files", () => {
    // routers/playbooks.ts: only the PATCH may declare it (create extends).
    expect(hits.get("routers/playbooks.ts")).toBe(1);
  });
});
