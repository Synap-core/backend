import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TRIPWIRE — every MCP tool DECLARED in `routers/mcp/tools/index.ts` (the
 * `list()` array the client sees via `tools/list`) has a matching dispatch
 * branch that actually EXECUTES it.
 *
 * WHY THIS EXISTS: declaration and dispatch for pod MCP tools live in TWO
 * separate files that must be kept in sync BY HAND:
 *   1. `tools/index.ts` `list()` — an array literal of `{ name: "synap_x", ... }`
 *      tool definitions. This is what `tools/list` advertises.
 *   2. `tools/index.ts` `execute()` special-cases exactly one name inline
 *      (`synap_load_skill`) and otherwise delegates to `adapter.ts`'s
 *      `executeMCPToolViaHubProtocol`, which is a `switch (toolName) { case
 *      "synap_x": ... }` — every other declared tool needs a `case` there.
 *
 * This is NOT a registry keyed by tool name (which would make declaration and
 * dispatch the same object, safe by construction) — it is two independently
 * maintained lists, the EXACT shape of bug this session hit on the CP-hosted
 * MCP server (`set_pod_focus` advertised in `TOOLS` with no matching `else if`
 * branch in the dispatch chain → every call threw "Unknown tool" despite the
 * tool being advertised as real). `adapter.ts`'s `switch` has the identical
 * failure mode: a tool added to `list()` without a `case` falls through to
 * `default: throw new Error(\`Unknown MCP tool: ${toolName}\`)`.
 *
 * This test parses both files as source text (same approach as the pod's
 * `a2ai-one-door.test.ts` and CP's `mcp-native-tool-dispatch-tripwire.test.ts`)
 * and asserts every name declared in `list()` has either a `case` in
 * `adapter.ts`'s switch, or is the one name `tools/index.ts` special-cases
 * inline before delegating to the adapter.
 */

const TOOLS_INDEX_SRC = join(__dirname, "../routers/mcp/tools/index.ts");
const ADAPTER_SRC = join(__dirname, "../routers/mcp/adapter.ts");

/** Names special-cased inline in `execute()` BEFORE delegating to the adapter. */
const DISPATCHED_INLINE_IN_TOOLS_INDEX = new Set(["synap_load_skill"]);

/**
 * Adapter `case`s that intentionally dispatch a name no longer on the curated
 * `list()` — a DEPRECATED alias kept for backward compatibility, not a
 * forgotten rename. `adapter.ts:2130` documents `synap_capture_graph` as the
 * deprecated alias of `synap_capture` (same case block, same handler).
 */
const INTENTIONALLY_UNDECLARED_ALIASES = new Set(["synap_capture_graph"]);

function parseDeclaredNames(src: string): string[] {
  return [...src.matchAll(/name: "(synap_[a-z_]+)"/g)].map((m) => m[1]);
}

function parseSwitchCaseNames(src: string): Set<string> {
  return new Set(
    [...src.matchAll(/case "(synap_[a-z_]+)"/g)].map((m) => m[1]),
  );
}

describe("tripwire: every declared MCP tool has a dispatch branch", () => {
  const toolsIndexSrc = readFileSync(TOOLS_INDEX_SRC, "utf8");
  const adapterSrc = readFileSync(ADAPTER_SRC, "utf8");

  it("can parse declared tool names and adapter switch cases (else this tripwire proves nothing)", () => {
    const declared = parseDeclaredNames(toolsIndexSrc);
    const dispatched = parseSwitchCaseNames(adapterSrc);
    expect(declared.length).toBeGreaterThan(30);
    expect(dispatched.size).toBeGreaterThan(30);
  });

  it("every tool declared in list() has a dispatch branch (adapter case, or the inline execute() special-case)", () => {
    const declared = parseDeclaredNames(toolsIndexSrc);
    const dispatched = parseSwitchCaseNames(adapterSrc);

    const missing = [...new Set(declared)].filter(
      (name) =>
        !dispatched.has(name) && !DISPATCHED_INLINE_IN_TOOLS_INDEX.has(name),
    );

    expect(
      missing,
      `These tools are declared in tools/index.ts \`list()\` (so \`tools/list\` ` +
        `advertises them as real) but have no \`case "..."\` in adapter.ts's ` +
        `switch, and are not inline-dispatched in \`execute()\` either — every ` +
        `call to them falls through to the switch's \`default:\` and throws ` +
        `"Unknown MCP tool: <name>":\n` +
        `  ${missing.join("\n  ")}\n` +
        `Add a \`case\` in adapter.ts (or an inline special-case in execute()), ` +
        `or remove the tool from list() if it isn't ready.`,
    ).toEqual([]);
  });

  it("every adapter switch case corresponds to a name still declared in list() (no dead/renamed dispatch)", () => {
    // The inverse direction: a `case` for a tool that no longer exists in
    // `list()` is at best dead code and at worst evidence of a rename that
    // forgot to update one side — not the incident bug, but the same class.
    const declared = new Set(parseDeclaredNames(toolsIndexSrc));
    const dispatched = parseSwitchCaseNames(adapterSrc);

    const orphaned = [...dispatched].filter(
      (name) =>
        !declared.has(name) && !INTENTIONALLY_UNDECLARED_ALIASES.has(name),
    );

    expect(
      orphaned,
      `These adapter.ts switch cases dispatch tool names that are no longer ` +
        `declared in tools/index.ts \`list()\` — likely a rename or removal that ` +
        `only updated one side:\n  ${orphaned.join("\n  ")}`,
    ).toEqual([]);
  });
});
