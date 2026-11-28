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
 * The MCP tools are zod since `defineTool` (their JSON Schema is derived):
 * `synap_create_playbook` / `synap_update_playbook` take the definition's own
 * fields from `playbookDefinitionSchema.shape`, and the last test proves it by
 * behaviour (the definition's bound is enforced at the MCP door).
 *
 * NOT covered (measured by reading): a door that accepts a playbook as an OPEN
 * record (`z.record(...)` — e.g. `workspaces.applyDefinition`) strips nothing,
 * so it is not a re-declaration and is not flagged. The scan sees
 * `goalTemplate` only: another definition field re-declared beside a derived
 * `goalTemplate` is not flagged here.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseToolArgs } from "../routers/mcp/define-tool.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A `goalTemplate` declared as a zod field, across a line break or not. */
const DECLARES_GOAL_TEMPLATE = /\bgoalTemplate\s*:\s*z\s*\.\s*(string|coerce)/g;

/**
 * Allowed, each for a stated reason. Patch/update schemas are all-optional
 * PATCHES of an existing row, not definitions. The Hub `POST /playbooks` door
 * (+ MCP create_playbook) was the last exception; it now `.pick`s the ONE
 * schema (2026-09-28) — its hand copy stripped `params` and `criteria`.
 */
const ALLOWED: Record<string, string> = {
  "schemas/playbook-definition.ts": "the canonical definition",
  "routers/playbooks.ts": "updateInputSchema — a PATCH (all optional)",
  "services/capabilities/builtin-verbs.ts":
    "playbook.update verb — a strict PATCH",
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

  it("the MCP playbook tools parse the definition's own fields (its bounds hold at the door)", () => {
    // A re-declared `z.string()` takes any length; the definition's
    // `goalTemplate` stops at 5000 and its `name` at 500.
    for (const [tool, base] of [
      ["synap_create_playbook", {}],
      ["synap_update_playbook", { playbookId: "pb-1" }],
    ] as const) {
      const long = parseToolArgs(tool, {
        ...base,
        name: "Weekly review",
        goalTemplate: "x".repeat(5001),
      });
      expect(long.ok, tool).toBe(false);
      expect(JSON.stringify(long), tool).toContain("goalTemplate");
      const longName = parseToolArgs(tool, {
        ...base,
        name: "x".repeat(501),
        goalTemplate: "Review the week",
      });
      expect(longName.ok, tool).toBe(false);
      // Non-vacuity: the same call within bounds is taken.
      expect(
        parseToolArgs(tool, {
          ...base,
          name: "Weekly review",
          goalTemplate: "Review the week",
        }).ok,
        tool
      ).toBe(true);
    }
  });

  it("the canonical definition is not duplicated inside the allowed files", () => {
    // routers/playbooks.ts: only the PATCH may declare it (create extends).
    expect(hits.get("routers/playbooks.ts")).toBe(1);
  });
});
