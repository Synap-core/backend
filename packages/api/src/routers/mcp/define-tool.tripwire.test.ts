/**
 * TRIPWIRE: one definition per MCP tool (`define-tool.ts`, design note
 * 7ed5d9ed).
 *
 * 1. Every name `tools.list()` returns comes from a `defineTool` definition:
 *    a tool or one of its declared aliases. A literal pushed into the list by
 *    hand has no group, no input check and no connector exposure.
 * 2. No hand-written tool list or tool-to-tool map lives next to the
 *    definitions: an alias table (`"synap_old": "synap_new"`) or a group
 *    member list (an array of tool names) under `routers/mcp` is a second
 *    truth that drifts. The scanned set is every non-test source file there,
 *    derived from the directory.
 *
 * Negative control: put `tool-aliases.ts` (its `synap_list_widgets:
 * "synap_list_cells"` map) or `ENTRY_TOOLS` back in `tool-profiles.ts` and
 * case 2 goes red; push a plain object into `toolDefinitions()` and case 1
 * goes red.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tools, toolDefinitions } from "./tools/index.js";
import {
  canonicalToolName,
  definedToolNames,
  isDefinedTool,
} from "./define-tool.js";

const MCP_DIR = dirname(fileURLToPath(import.meta.url));
/** The one file allowed to name tools by the hundred: the definitions. */
const DEFINITIONS = join(MCP_DIR, "tools/index.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(e.name) &&
      !/\.test\.ts$/.test(e.name) &&
      !e.name.endsWith(".generated.ts") &&
      path !== DEFINITIONS
      ? [path]
      : [];
  });
}

/** `"synap_a": "synap_b"` / `synap_a: "synap_b"`: a tool-to-tool map entry. */
const TOOL_TO_TOOL = /\b"?synap_[a-z_]+"?\s*:\s*"synap_[a-z_]+"/g;
/** An array literal of three or more tool names: a member list. */
const TOOL_LIST =
  /\[\s*(?:"synap_[a-z_]+"\s*,\s*(?:\/\/[^\n]*\n\s*)*){2,}"synap_[a-z_]+"/g;

/** Hand-written tool lists and maps in `src`, as short excerpts. */
export function handWrittenToolTables(src: string): string[] {
  return [...src.matchAll(TOOL_TO_TOOL), ...src.matchAll(TOOL_LIST)].map((m) =>
    m[0].replace(/\s+/g, " ").slice(0, 80)
  );
}

describe("tripwire: one definition per MCP tool", () => {
  it("SELF-CHECK: the detector sees an alias map and a member list, and passes a single name", () => {
    expect(
      handWrittenToolTables(
        'const A = { synap_list_widgets: "synap_list_cells" };'
      )
    ).toHaveLength(1);
    expect(
      handWrittenToolTables(
        'const E = [\n  "synap_orient",\n  // why\n  "synap_ask",\n  "synap_capture",\n];'
      )
    ).toHaveLength(1);
    expect(
      handWrittenToolTables('const T = "synap_ask"; f("synap_capture");')
    ).toEqual([]);
  });

  it("every listed name comes from a defineTool definition (a tool or its alias)", async () => {
    const defs = toolDefinitions();
    expect(defs.length).toBeGreaterThan(100);
    expect(defs.filter((d) => !isDefinedTool(d)).map((d) => d.name)).toEqual(
      []
    );
    const defined = new Set(definedToolNames());
    const listed = (await tools.list()).map((t) => t.name);
    expect(listed).toContain("synap_list_widgets");
    expect(
      listed.filter((n) => !defined.has(canonicalToolName(n)))
    ).toEqual([]);
  });

  it("no hand-written tool list or tool-to-tool map beside the definitions", () => {
    const files = sourceFiles(MCP_DIR);
    // Non-vacuity: the scan reads the files that used to hold the tables.
    const rel = files.map((f) => relative(MCP_DIR, f));
    expect(rel).toContain("tool-profiles.ts");
    expect(rel).toContain("adapter.ts");
    expect(rel.length).toBeGreaterThan(40);
    const offenders = files.flatMap((f) =>
      handWrittenToolTables(readFileSync(f, "utf8")).map(
        (hit) => `${relative(MCP_DIR, f)}: ${hit}`
      )
    );
    expect(
      offenders,
      "A tool's group, aliases and teaching keys live on its defineTool (tools/index.ts); derive the list from define-tool.ts instead."
    ).toEqual([]);
  });
});
