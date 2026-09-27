import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — MCP tool TITLES (what the Claude connector UI shows a person)
 * speak the user words: Space, Template, Rule, Tool (`@synap-core/types`
 * vocabulary `object-kinds.ts`, founder N1/D1/D2). Tool NAMES keep the DB-kind
 * stems (`synap_list_workspaces`) — renaming a name breaks every connected
 * client, so only titles are held here (RV2 S5 / RV1 S16: "Run playbook" etc.
 * survived the Space decision, including on tools written after it).
 *
 * DERIVED: reads every title in the generated manifest the pod serves.
 * DOES NOT SEE: descriptions (they legitimately name params like
 * `workspaceId`), and a retired word spelled another way.
 */
const MANIFEST = join(
  __dirname,
  "../routers/mcp/tools/mcp-tools.manifest.json"
);
const RETIRED = /\b(workspaces?|playbooks?|automations?|capabilit(y|ies))\b/i;

describe("tripwire: MCP titles use the user words", () => {
  it("self-check", () => {
    expect(RETIRED.test("Run playbook")).toBe(true);
    expect(RETIRED.test("Run template")).toBe(false);
  });

  it("no title uses a retired concept word", () => {
    const { tools } = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      tools: Array<{ name: string; annotations?: { title?: string } }>;
    };
    const titled = tools.filter((t) => t.annotations?.title);
    expect(titled.length).toBeGreaterThan(60); // non-vacuity (2026-09-27: 80)
    expect(titled.map((t) => t.name)).toContain("synap_run_playbook");
    const bad = titled
      .filter((t) => RETIRED.test(t.annotations!.title!))
      .map((t) => `${t.name}: ${t.annotations!.title}`);
    expect(bad).toEqual([]);
  });
});
