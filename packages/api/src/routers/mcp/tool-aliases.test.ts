/**
 * An old MCP tool name answers exactly as the tool that replaced it
 * (`tool-aliases.ts`). `synap_list_widgets` became `synap_list_cells`
 * (founder, 23 Nov 2026: the word is Cell): a client that still calls the old
 * name, the Control Plane's `pod__list_widgets` among them, gets the same
 * answer, and both names stay listed.
 *
 * Driven through the adapter's real dispatch map (`mcpToolHandler`), so
 * dropping the alias merge in `adapter.ts` fails here, not only a change in
 * `tool-aliases.ts`. The hub caller is a stub returning the built-in rows
 * (no DB).
 */

import { describe, expect, it } from "vitest";
import { mcpToolHandler } from "./adapter.js";
import { MCP_TOOL_ALIASES } from "./tool-aliases.js";
import { tools } from "./tools/index.js";
import { builtinRenderableRows } from "../../services/cells/renderables.js";
import type { McpToolContext } from "./handlers/shared.js";

const ctx = (toolName: string, args: Record<string, unknown>) =>
  ({
    toolName,
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

async function answer(toolName: string, args: Record<string, unknown>) {
  const handler = mcpToolHandler(toolName);
  expect(handler, `${toolName} has no handler`).toBeDefined();
  const result = await handler!(ctx(toolName, args));
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text");
  return block.text;
}

describe("synap_list_widgets is an alias of synap_list_cells", () => {
  it("the alias table names it", () => {
    expect(MCP_TOOL_ALIASES.synap_list_widgets).toBe("synap_list_cells");
  });

  it.each([
    [{}],
    [{ placement: "document", limit: 200 }],
    [{ placement: "bento", offset: 15 }],
  ])("answers identically (%j)", async (args) => {
    const canonical = await answer("synap_list_cells", args);
    expect(JSON.parse(canonical).cells.length).toBeGreaterThan(0);
    expect(await answer("synap_list_widgets", args)).toBe(canonical);
  });

  it("the old parameter `surface` answers as `placement`", async () => {
    const byPlacement = await answer("synap_list_cells", {
      placement: "document",
      limit: 200,
    });
    expect(JSON.parse(byPlacement).placement).toBe("document");
    expect(JSON.parse(byPlacement).fences.length).toBeGreaterThan(0);
    for (const tool of ["synap_list_cells", "synap_list_widgets"]) {
      expect(await answer(tool, { surface: "document", limit: 200 })).toBe(
        byPlacement
      );
    }
  });

  it("both names are listed, with one input schema, the old one pointing at the new", async () => {
    const defs = await tools.list();
    const cells = defs.find((t) => t.name === "synap_list_cells");
    const widgets = defs.find((t) => t.name === "synap_list_widgets");
    expect(cells?.annotations?.title).toBe("List cells");
    expect(widgets?.inputSchema).toEqual(cells?.inputSchema);
    expect(widgets?.annotations?.readOnlyHint).toBe(true);
    expect(widgets?.description).toContain("Call synap_list_cells");
    expect(cells?.description).not.toMatch(/\bwidgets?\b/i);
  });
});
