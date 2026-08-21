/**
 * The intent vocabulary is CLOSED — and the published MCP schema must SAY so.
 *
 * `synap_list_capabilities` takes an `intent` argument for the reverse lookup
 * (what you want to DO, without knowing the vendor). Its valid values are
 * `ABSTRACT_VERBS` in `@synap/database/schema`.
 *
 * Describing that vocabulary in prose is not enough. A caller then has to parse
 * the valid set out of an English sentence, and discovers a typo as a runtime
 * rejection instead of a schema violation. Declaring it as an `enum` constrains
 * the call BEFORE it is made — the same treatment `PlaybookStage.category` got.
 *
 * The published manifest is GENERATED from `tools/index.ts`, so the two can
 * drift from the schema independently. These tests pin all three together:
 * source union → tool definition → generated manifest. Adding a verb to the
 * union without regenerating the manifest fails here, loudly, rather than
 * shipping a door that silently rejects a value the vocabulary allows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ABSTRACT_VERBS } from "@synap/database/schema";

const here = dirname(fileURLToPath(import.meta.url));

function listCapabilitiesIntentSchema(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(here, "tools", "mcp-tools.manifest.json"), "utf8")
  ) as {
    tools: Array<{
      name: string;
      inputSchema?: { properties?: Record<string, Record<string, unknown>> };
    }>;
  };
  const tool = manifest.tools.find((t) => t.name === "synap_list_capabilities");
  expect(
    tool,
    "synap_list_capabilities missing from the manifest"
  ).toBeTruthy();
  const intent = tool?.inputSchema?.properties?.intent;
  expect(
    intent,
    "`intent` arg missing from synap_list_capabilities"
  ).toBeTruthy();
  return intent as Record<string, unknown>;
}

describe("intent vocabulary — schema ↔ published MCP manifest parity", () => {
  it("declares the vocabulary as an ENUM, not only in prose", () => {
    const intent = listCapabilitiesIntentSchema();
    expect(
      Array.isArray(intent.enum),
      "`intent` must declare an enum so a caller is constrained before the call, " +
        "not corrected by a runtime rejection"
    ).toBe(true);
  });

  it("the published enum is EXACTLY the closed vocabulary — no drift either way", () => {
    const intent = listCapabilitiesIntentSchema();
    // Sorted compare: order is presentational, membership is the contract.
    expect([...(intent.enum as string[])].sort()).toEqual(
      [...ABSTRACT_VERBS].sort()
    );
  });

  it("every published value is a real member of the union", () => {
    const intent = listCapabilitiesIntentSchema();
    for (const value of intent.enum as string[]) {
      expect(
        (ABSTRACT_VERBS as readonly string[]).includes(value),
        `manifest advertises "${value}", which is not in ABSTRACT_VERBS`
      ).toBe(true);
    }
  });

  it("still explains the argument in prose — an enum is not a description", () => {
    const intent = listCapabilitiesIntentSchema();
    expect(typeof intent.description).toBe("string");
    expect((intent.description as string).length).toBeGreaterThan(60);
  });
});
