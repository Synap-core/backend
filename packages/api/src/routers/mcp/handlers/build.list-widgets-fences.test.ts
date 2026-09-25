/**
 * synap_list_widgets(surface: "document") teaches the FENCE rows of the one
 * catalog (```mermaid, ```math, code) — derived from `FENCE_RENDERABLES`, so an
 * agent learns a content language because the catalog has it, never from a
 * hand list. A bento answer carries no fences (a fence is not a block).
 *
 * Driven through the real handler; the hub caller is a stub returning the
 * built-in rows (no DB).
 */

import { describe, it, expect } from "vitest";
import { FENCE_RENDERABLES } from "@synap-core/types/renderables";
import { buildHandlers } from "./build.js";
import { builtinRenderableRows } from "../../../services/cells/renderables.js";
import type { McpToolContext } from "./shared.js";

const ctx = (args: Record<string, unknown>): McpToolContext =>
  ({
    toolName: "synap_list_widgets",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {
      widgetDefinitions: {
        listWidgetDefs: async () => builtinRenderableRows(),
      },
    } as unknown as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  }) as McpToolContext;

async function answer(args: Record<string, unknown>) {
  const result = await buildHandlers.synap_list_widgets!(ctx(args));
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text");
  return JSON.parse(block.text) as {
    fences?: Array<{ key: string; languages: string[]; aiHint: string }>;
    widgets: unknown[];
  };
}

describe("synap_list_widgets — fences from the catalog", () => {
  it("document: every inline fence row arrives with its aiHint", async () => {
    const out = await answer({ surface: "document" });
    expect(out.widgets.length).toBeGreaterThan(20);
    const inline = FENCE_RENDERABLES.filter((f) =>
      f.placements.includes("inline")
    );
    expect(inline.length).toBeGreaterThanOrEqual(3);
    expect(out.fences?.map((f) => f.key)).toEqual(inline.map((f) => f.key));
    const mermaid = out.fences!.find((f) => f.key === "mermaid")!;
    expect(mermaid.languages).toContain("mermaid");
    expect(mermaid.aiHint).toContain("```mermaid");
    expect(out.fences!.find((f) => f.key === "math")!.aiHint).toContain(
      "```math"
    );
  });

  it("bento: no fences", async () => {
    const out = await answer({});
    expect(out).not.toHaveProperty("fences");
  });
});
