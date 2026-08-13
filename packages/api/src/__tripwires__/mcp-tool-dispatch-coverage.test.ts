import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — every MCP tool DECLARED in `routers/mcp/tools/index.ts` (the
 * `list()` array the client sees via `tools/list`) has a matching dispatch
 * entry that actually EXECUTES it.
 *
 * WHY THIS EXISTS: declaration and dispatch for pod MCP tools live in TWO
 * separate places that must be kept in sync BY HAND:
 *   1. `tools/index.ts` `list()` — an array literal of `{ name: "synap_x", ... }`
 *      tool definitions. This is what `tools/list` advertises.
 *   2. `tools/index.ts` `execute()` special-cases exactly one name inline
 *      (`synap_load_skill`) and otherwise delegates to `adapter.ts`'s
 *      `executeMCPToolViaHubProtocol`, which (router-decomposition Wave 7)
 *      looks the tool up in `TOOL_HANDLERS` — a `Record<toolName, handler>`
 *      merged from the per-domain files under `mcp/handlers/*.ts`. Every
 *      other declared tool needs a registered key in that merged map.
 *
 * This is NOT a registry keyed by tool name (which would make declaration and
 * dispatch the same object, safe by construction) — it is two independently
 * maintained lists, the EXACT shape of bug this session hit on the CP-hosted
 * MCP server (`set_pod_focus` advertised in `TOOLS` with no matching `else if`
 * branch in the dispatch chain → every call threw "Unknown tool" despite the
 * tool being advertised as real). `adapter.ts`'s dispatch map has the
 * identical failure mode: a tool added to `list()` without a handler-map
 * entry falls through to `TOOL_HANDLERS[toolName]` being `undefined`, which
 * throws `Unknown MCP tool: ${toolName}`.
 *
 * This test parses `tools/index.ts` plus every `adapter.ts` + `handlers/*.ts`
 * source file as text (same approach as the pod's `a2ai-one-door.test.ts` and
 * CP's `mcp-native-tool-dispatch-tripwire.test.ts`) and asserts every name
 * declared in `list()` has either a registered handler-map key somewhere
 * under `handlers/` (or `adapter.ts` itself), or is the one name
 * `tools/index.ts` special-cases inline before delegating to the adapter.
 *
 * WHY SCANNING SOURCE TEXT (not importing + introspecting `TOOL_HANDLERS` at
 * runtime) IS STILL THE RIGHT SHAPE: the previous switch-based version parsed
 * `case "..."` text for the identical reason — a runtime import would need
 * every handler module's full dependency graph (DB clients, hub routers) to
 * resolve, which is exactly the friction a *source* tripwire avoids. The
 * regex below looks for the property-key shape `synap_x:` at the start of a
 * line, which is how every domain file (`handlers/read.ts`, `entity.ts`,
 * `capture.ts`, `capability.ts`, `workspace.ts`, `session.ts`, `build.ts`)
 * registers its slice of `McpHandlerMap` — see e.g. `export const
 * readHandlers: McpHandlerMap = { synap_ask: async (ctx) => {...}, ... }`.
 */

const TOOLS_INDEX_SRC = join(__dirname, "../routers/mcp/tools/index.ts");
const MCP_DIR = join(__dirname, "../routers/mcp");
const HANDLERS_DIR = join(MCP_DIR, "handlers");

/** Names special-cased inline in `execute()` BEFORE delegating to the adapter. */
const DISPATCHED_INLINE_IN_TOOLS_INDEX = new Set(["synap_load_skill"]);

/**
 * Handler-map keys that intentionally register a name no longer on the
 * curated `list()` — a DEPRECATED alias kept for backward compatibility, not
 * a forgotten rename. `handlers/capture.ts` documents `synap_capture_graph`
 * as the deprecated alias of `synap_capture` (same handler function, two
 * map keys).
 */
const INTENTIONALLY_UNDECLARED_ALIASES = new Set(["synap_capture_graph"]);

function parseDeclaredNames(src: string): string[] {
  return [...src.matchAll(/name: "(synap_[a-z_]+)"/g)].map((m) => m[1]);
}

/**
 * Every source file that could carry a `TOOL_HANDLERS` registration:
 * `adapter.ts` itself (kept as a possible location — the dispatcher used to
 * live there and could again) plus every `.ts` file directly under
 * `mcp/handlers/` (the domain split this tripwire was rewritten for).
 * Excludes nested `__tests__`/`__tripwires__` dirs, same convention as the
 * rest of the repo's source tripwires.
 */
function dispatchSourceFiles(): string[] {
  const files = [join(MCP_DIR, "adapter.ts")];
  for (const entry of readdirSync(HANDLERS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(join(HANDLERS_DIR, entry.name));
    }
  }
  return files;
}

/**
 * Registered handler-map keys across every dispatch source file: property
 * keys of the shape `synap_x:` at the start of a (trimmed) line — the shape
 * every `Partial<Record<toolName, handler>>` object literal in this codebase
 * uses (`synap_ask: async (ctx) => {...}`, or `synap_capture: captureHandler,`
 * for a shared-handler alias).
 */
function parseDispatchedNames(): Set<string> {
  const dispatched = new Set<string>();
  for (const file of dispatchSourceFiles()) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*(synap_[a-z_]+):/gm)) {
      dispatched.add(m[1]);
    }
  }
  return dispatched;
}

describe("tripwire: every declared MCP tool has a dispatch branch", () => {
  const toolsIndexSrc = readFileSync(TOOLS_INDEX_SRC, "utf8");

  it("can parse declared tool names and dispatch-map keys (else this tripwire proves nothing)", () => {
    const declared = parseDeclaredNames(toolsIndexSrc);
    const dispatched = parseDispatchedNames();
    expect(declared.length).toBeGreaterThan(30);
    expect(dispatched.size).toBeGreaterThan(30);
  });

  it("every tool declared in list() has a dispatch branch (a handler-map key under mcp/handlers/, or the inline execute() special-case)", () => {
    const declared = parseDeclaredNames(toolsIndexSrc);
    const dispatched = parseDispatchedNames();

    const missing = [...new Set(declared)].filter(
      (name) =>
        !dispatched.has(name) && !DISPATCHED_INLINE_IN_TOOLS_INDEX.has(name)
    );

    expect(
      missing,
      `These tools are declared in tools/index.ts \`list()\` (so \`tools/list\` ` +
        `advertises them as real) but have no handler-map key under ` +
        `mcp/handlers/*.ts (or adapter.ts), and are not inline-dispatched in ` +
        `\`execute()\` either — every call to them falls through to ` +
        `\`TOOL_HANDLERS[toolName]\` being \`undefined\` and throws ` +
        `"Unknown MCP tool: <name>":\n` +
        `  ${missing.join("\n  ")}\n` +
        `Add a \`synap_x: async (ctx) => {...}\` entry to the right domain file ` +
        `under mcp/handlers/ (or an inline special-case in execute()), or remove ` +
        `the tool from list() if it isn't ready.`
    ).toEqual([]);
  });

  it("every dispatch-map key corresponds to a name still declared in list() (no dead/renamed dispatch)", () => {
    // The inverse direction: a handler-map key for a tool that no longer
    // exists in `list()` is at best dead code and at worst evidence of a
    // rename that forgot to update one side — not the incident bug, but the
    // same class.
    const declared = new Set(parseDeclaredNames(toolsIndexSrc));
    const dispatched = parseDispatchedNames();

    const orphaned = [...dispatched].filter(
      (name) =>
        !declared.has(name) && !INTENTIONALLY_UNDECLARED_ALIASES.has(name)
    );

    expect(
      orphaned,
      `These mcp/handlers/*.ts (or adapter.ts) dispatch-map keys register tool ` +
        `names that are no longer declared in tools/index.ts \`list()\` — ` +
        `likely a rename or removal that only updated one side:\n  ${orphaned.join("\n  ")}`
    ).toEqual([]);
  });
});
