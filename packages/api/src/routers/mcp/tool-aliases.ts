/**
 * MCP tool-name ALIASES: an old tool name that keeps answering as the tool
 * that replaced it.
 *
 * A rename of a tool must not break a client that learned the old name (a
 * saved prompt, a skill, the Control Plane connector's `pod__<short>` mirror).
 * So the old name stays LISTED (`tools.list()` derives its entry from the
 * canonical tool, `toolAliasDefs`) and DISPATCHED to the canonical tool's
 * handler (`toolAliasHandlers`, merged into the adapter's `TOOL_HANDLERS`):
 * same parameters, same answer. Being listed keeps the manifest, the door
 * tool-name table and the Control Plane's mirror coherent with no special
 * case. The alias entry's description sends the agent to the new name.
 *
 * This table is the ONE place an alias is declared. It is not
 * `tool-verb-aliases.ts`, which maps a tool to its teaching keys.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Old tool name → the canonical tool it answers as. */
export const MCP_TOOL_ALIASES: Readonly<Record<string, string>> = {
  // Founder, 23 Nov 2026: the word is Cell, for users and agents alike.
  synap_list_widgets: "synap_list_cells",
};

/** The tool a name answers as: itself, or the canonical tool of an alias. */
export function canonicalToolName(name: string): string {
  return Object.hasOwn(MCP_TOOL_ALIASES, name) ? MCP_TOOL_ALIASES[name]! : name;
}

/**
 * The listed entry of each alias, derived from its canonical tool's entry
 * (same input schema and hints). An alias whose canonical tool is not in
 * `defs` is left out: it would answer nothing.
 */
export function toolAliasDefs(defs: readonly Tool[]): Tool[] {
  const byName = new Map(defs.map((t) => [t.name, t]));
  return Object.entries(MCP_TOOL_ALIASES).flatMap(([alias, canonical]) => {
    const tool = byName.get(canonical);
    if (!tool) return [];
    const title = tool.annotations?.title;
    return [
      {
        ...tool,
        name: alias,
        ...(tool.annotations
          ? {
              annotations: {
                ...tool.annotations,
                ...(title ? { title: `${title} (old name)` } : {}),
              },
            }
          : {}),
        description: `Old name of ${canonical}, kept so existing clients keep working: same parameters, same answer. Call ${canonical}.`,
      },
    ];
  });
}

/** Each alias's handler: its canonical tool's handler, the same function. */
export function toolAliasHandlers<H>(
  handlers: Readonly<Partial<Record<string, H>>>
): Partial<Record<string, H>> {
  const out: Partial<Record<string, H>> = {};
  for (const [alias, canonical] of Object.entries(MCP_TOOL_ALIASES)) {
    const handler = handlers[canonical];
    if (handler) out[alias] = handler;
  }
  return out;
}
