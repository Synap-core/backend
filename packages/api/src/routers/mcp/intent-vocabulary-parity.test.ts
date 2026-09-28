/**
 * The intent argument is OPEN. The vocabulary is the `capability_intents`
 * registry, seeded by `ABSTRACT_VERBS`. A static enum on the published MCP
 * tool rejects a slug the pod already stored, before the handler runs.
 *
 * These tests pin the opposite of the old closed enum: the manifest must NOT
 * publish an enum for `synap_list_capabilities.intent`, and the description
 * must say the value is a registry slug. Re-closing it fails here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

describe("intent vocabulary — the published MCP argument stays open", () => {
  it("does not publish an enum — a registry slug must reach the handler", () => {
    const intent = listCapabilitiesIntentSchema();
    expect(intent.enum).toBeUndefined();
  });

  it("tells the caller the value is a registry slug", () => {
    const intent = listCapabilitiesIntentSchema();
    expect(typeof intent.description).toBe("string");
    expect(intent.description as string).toMatch(/registry/i);
    expect((intent.description as string).length).toBeGreaterThan(60);
  });
});
