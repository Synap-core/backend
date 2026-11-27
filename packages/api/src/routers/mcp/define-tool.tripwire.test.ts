/**
 * TRIPWIRE: one definition per MCP tool (`define-tool.ts`, design note
 * 7ed5d9ed).
 *
 * 1. Every name `tools.list()` returns comes from a `defineTool` definition:
 *    a tool or one of its declared aliases. A literal pushed into the list by
 *    hand has no group, no input check and no connector exposure.
 * 2. No hand-written tool list or tool-keyed map lives anywhere in
 *    `packages/api/src` (every non-test, non-generated source file, derived
 *    from the directory; the definitions themselves excepted): a fact about
 *    a tool is a field on its definition, read from `define-tool.ts`. Seen:
 *    a tool-to-tool map (`synap_old: "synap_new"`, either quote), a list of
 *    two or more tool names (an array, `new Set([...])`, an `as const`
 *    tuple), and an object with two or more tool-name keys. Only names a
 *    definition answers to count, so `synap_hub_live_` or an OAuth client id
 *    is no hit. What must stay is declared in ALLOWED, each with its reason;
 *    an allowed entry that no longer matches anything fails too.
 *
 * Negative control: put `tool-aliases.ts`, `ENTRY_TOOLS`, `HOW_TO_NARROW`,
 * `TOOL_METADATA`, a two-name `new Set` or `MCP_READ_TOOL_DOORS` back and
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
  isPodToolName,
} from "./define-tool.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** The one file allowed to name tools by the hundred: the definitions. */
const DEFINITIONS = "routers/mcp/tools/index.ts";

/**
 * Tool lists that stay, each with why. `file` is a path under src (a regex),
 * `shape` the kind of hit it allows.
 */
const ALLOWED: ReadonlyArray<{
  file: RegExp;
  shape: Shape;
  reason: string;
}> = [
  {
    file: /^routers\/mcp\/handlers\/[a-z-]+\.ts$/,
    shape: "keyed",
    reason:
      "The dispatch: each domain's handler map, keyed by the tool it runs. Merged into TOOL_HANDLERS, which `satisfies Required<McpHandlerMap>` against the definitions, so a tool without a handler (or a handler for no tool) does not compile.",
  },
];

type Shape = "map" | "list" | "keyed";
const NAME = String.raw`synap_[a-z]+(?:_[a-z]+)*`;
const Q = `["']`;
/** `"synap_a": "synap_b"` / `synap_a: 'synap_b'`: a tool-to-tool map entry. */
const TOOL_TO_TOOL = new RegExp(
  `${Q}?\\b(${NAME})${Q}?\\s*:\\s*${Q}(${NAME})${Q}`,
  "g"
);
/** A literal list of two or more names: `[...]`, `new Set([...])`, `as const`. */
const TOOL_LIST = new RegExp(
  `\\[\\s*(?:${Q}${NAME}${Q}\\s*,\\s*(?:\\/\\/[^\\n]*\\n\\s*)*)+${Q}${NAME}${Q}`,
  "g"
);
/** An object key that is a tool name, at the start of a line. */
const TOOL_KEY = new RegExp(`^\\s*${Q}?(${NAME})${Q}?\\??\\s*:`, "gm");

const names = (text: string) =>
  [...text.matchAll(new RegExp(NAME, "g"))].map((m) => m[0]);

/** Hand-written tool lists and maps in `src`, as `shape: excerpt`. */
export function handWrittenToolTables(
  src: string,
  isTool: (name: string) => boolean = isPodToolName
): Array<{ shape: Shape; hit: string }> {
  const out: Array<{ shape: Shape; hit: string }> = [];
  for (const m of src.matchAll(TOOL_TO_TOOL))
    if (isTool(m[1]!) && isTool(m[2]!)) out.push({ shape: "map", hit: m[0] });
  for (const m of src.matchAll(TOOL_LIST))
    if (names(m[0]).filter(isTool).length >= 2)
      out.push({ shape: "list", hit: m[0] });
  const keys = [...src.matchAll(TOOL_KEY)]
    .map((m) => m[1]!)
    .filter(isTool);
  if (keys.length >= 2)
    out.push({ shape: "keyed", hit: `${keys.length} keys: ${keys[0]}, …` });
  return out.map((h) => ({
    ...h,
    hit: h.hit.replace(/\s+/g, " ").slice(0, 80),
  }));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory())
      return e.name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(e.name) &&
      !/\.test\.ts$/.test(e.name) &&
      !e.name.endsWith(".d.ts") &&
      !e.name.includes(".generated.") &&
      relative(SRC, path) !== DEFINITIONS
      ? [path]
      : [];
  });
}

describe("tripwire: one definition per MCP tool", () => {
  it("SELF-CHECK: the detector sees each shape, and passes a single name or a non-tool", () => {
    const shapes = (src: string) =>
      handWrittenToolTables(src).map((h) => h.shape);
    expect(
      shapes('const A = { synap_list_widgets: "synap_list_cells" };')
    ).toEqual(["map"]);
    expect(
      shapes("const A = { 'synap_list_widgets': 'synap_list_cells' };")
    ).toEqual(["map"]);
    expect(
      shapes('const S = new Set(["synap_ask", "synap_capture"]);')
    ).toEqual(["list"]);
    expect(shapes("const L = ['synap_ask', 'synap_capture'];")).toEqual([
      "list",
    ]);
    expect(
      shapes(
        'const E = [\n  "synap_orient",\n  // why\n  "synap_ask",\n] as const;'
      )
    ).toEqual(["list"]);
    expect(
      shapes(
        'const M = {\n  synap_ask: "Lower `limit`.",\n  synap_find: { a: 1 },\n};'
      )
    ).toEqual(["keyed"]);
    expect(
      shapes('const T = "synap_ask"; f("synap_capture"); g({ synap_ask: 1 });')
    ).toEqual([]);
    expect(
      shapes('const K = live ? "synap_hub_live_" : "synap_hub_test_";')
    ).toEqual([]);
    expect(shapes('const C = ["synap_first_party", "synap_other"];')).toEqual(
      []
    );
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
    expect(listed.filter((n) => !defined.has(canonicalToolName(n)))).toEqual(
      []
    );
  });

  const scan = () => {
    const files = sourceFiles(SRC);
    return {
      files: files.map((f) => relative(SRC, f)),
      hits: files.flatMap((f) =>
        handWrittenToolTables(readFileSync(f, "utf8")).map((h) => ({
          ...h,
          file: relative(SRC, f),
        }))
      ),
    };
  };

  it("no hand-written tool list or tool-keyed map anywhere in src, beyond ALLOWED", () => {
    const { files: rel, hits } = scan();
    // Non-vacuity: the scan reads the whole package and the files that used
    // to hold the tables.
    for (const f of [
      "routers/mcp/tool-profiles.ts",
      "access/grant-door-fence.ts",
      "services/capability-briefs/compose-capability-brief.ts",
      "routers/mcp/reply-cap.ts",
      "middleware/hub-request-guard.ts",
      "services/proposals/supersedes-door.ts",
    ])
      expect(rel).toContain(f);
    expect(rel.length).toBeGreaterThan(500);

    const allowed = (h: (typeof hits)[number]) =>
      ALLOWED.some((a) => a.shape === h.shape && a.file.test(h.file));
    // Non-vacuity: the allowed dispatch maps are seen by the same scan.
    expect(hits.filter(allowed).length).toBeGreaterThanOrEqual(10);
    expect(
      hits.filter((h) => !allowed(h)).map((h) => `${h.file}: ${h.hit}`),
      "A fact about a tool is a field on its defineTool (tools/index.ts), read through define-tool.ts; if this list must stay, declare it in ALLOWED with its reason."
    ).toEqual([]);
  });

  it("every ALLOWED entry still matches a hit (the allow-list cannot rot)", () => {
    const { hits } = scan();
    expect(
      ALLOWED.filter(
        (a) => !hits.some((h) => h.shape === a.shape && a.file.test(h.file))
      ).map((a) => `${a.file} (${a.shape})`),
      "An ALLOWED entry matches nothing any more: delete it."
    ).toEqual([]);
  });
});
