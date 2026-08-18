/**
 * Write-door contract test for playbook stages.
 *
 * `stages` used to be `z.array(z.record(z.string(), z.unknown()))` at every
 * door — an unvalidated bag, which is why `PlaybookStage` was a TypeScript-only
 * fiction and readers defended with inline `as` casts. This asserts the DOORS
 * (not just the schema module) now enforce the rollup category, so a
 * cross-playbook board can group on it.
 *
 * No DB — these are pure zod input schemas.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { updateInputSchema } from "./playbooks.js";

const PLAYBOOK_ID = "00000000-0000-4000-8000-000000000001";

describe("playbooks.update input — stages", () => {
  it("REJECTS a stage with no category", () => {
    const result = updateInputSchema.safeParse({
      id: PLAYBOOK_ID,
      stages: [{ key: "qualify", name: "Qualify" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a stage that declares one of the six categories", () => {
    const result = updateInputSchema.safeParse({
      id: PLAYBOOK_ID,
      stages: [{ key: "qualify", name: "Qualify", category: "started" }],
    });
    expect(result.success).toBe(true);
  });

  it("REJECTS duplicate stage keys (currentStage stores the bare key)", () => {
    const result = updateInputSchema.safeParse({
      id: PLAYBOOK_ID,
      stages: [
        { key: "qualify", name: "Qualify", category: "started" },
        { key: "qualify", name: "Qualify again", category: "paused" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("REJECTS a category outside the closed set", () => {
    const result = updateInputSchema.safeParse({
      id: PLAYBOOK_ID,
      stages: [{ key: "qualify", name: "Qualify", category: "in-progress" }],
    });
    expect(result.success).toBe(false);
  });

  it("still accepts an update that omits stages entirely", () => {
    expect(
      updateInputSchema.safeParse({ id: PLAYBOOK_ID, name: "Renamed" }).success
    ).toBe(true);
  });
});

describe("synap_create_playbook MCP manifest", () => {
  /**
   * The manifest is what an external agent reads to learn the tool's shape. If
   * it does not DECLARE `category` as required, agents keep sending
   * category-less stages and every call fails at the door with no way to know
   * why — the tightening has to be visible in the contract, not only enforced.
   */
  const manifest = JSON.parse(
    readFileSync(join(__dirname, "mcp/tools/mcp-tools.manifest.json"), "utf8")
  ) as {
    tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
  };

  it("declares category as a required stage field with the six values", () => {
    const tool = manifest.tools.find((t) => t.name === "synap_create_playbook");
    expect(tool).toBeDefined();
    const stages = (
      tool!.inputSchema.properties as Record<
        string,
        { items: Record<string, unknown> }
      >
    ).stages;
    const items = stages.items as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(items.required).toContain("category");
    expect(items.properties.category?.enum).toEqual([
      "backlog",
      "planned",
      "started",
      "paused",
      "completed",
      "canceled",
    ]);
  });
});
