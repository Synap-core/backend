/**
 * REFUSE an argument a tool does not declare, instead of dropping it.
 *
 * MCP input schemas are ADVISORY: nothing validates `arguments` server-side,
 * and a handler reads the keys it knows and ignores the rest. For a WRITE door
 * that is a lie told as a success. Live, 2026-10-21/22 on the founder's pod:
 * `synap_update_session` with `reopenOutput: "spec"` returned
 * `status: "updated"` and changed nothing; with `addOutputs` (the real input
 * is `addOutput`, or `outcomes`) it returned "updated" and left
 * `expectedOutputs` empty. The agent believed both, and so did the person.
 *
 * The valid set is DERIVED from the tool's own declared `inputSchema`
 * (its `defineTool`), never a second hand-kept list: a property added to the
 * schema is accepted the moment it is declared, and one read by a handler
 * without being declared is refused (pinned by the door's test, which scans
 * the handler for every `args.<key>` it reads).
 *
 * `DOOR_INJECTED_ARGS` are keys the MCP door itself adds to every call (the
 * URL lens, `mcp/index.ts`) — a caller never sent them, so they are never
 * "unknown".
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolError } from "./tool-errors.js";
import { toolDefinition } from "./define-tool.js";

/** Keys the MCP door injects into every tool call (the URL lens). */
export const DOOR_INJECTED_ARGS = ["workspaceId", "projectId"] as const;

/** The declared and the required property names of a tool, or null. */
async function inputNames(
  toolName: string
): Promise<{ declared: string[]; required: string[] } | null> {
  const schema = toolDefinition(toolName)?.inputSchema;
  if (!schema?.properties) return null;
  return {
    declared: Object.keys(schema.properties),
    required: schema.required ?? [],
  };
}

/** The declared property names of `toolName`'s input schema, or null. */
export async function declaredArgNames(
  toolName: string
): Promise<string[] | null> {
  return (await inputNames(toolName))?.declared ?? null;
}

/** The keys of `args` that `declared` does not name. Pure. */
export function undeclaredArgs(
  args: Record<string, unknown> | null | undefined,
  declared: readonly string[]
): string[] {
  if (!args || typeof args !== "object") return [];
  const known = new Set<string>([...declared, ...DOOR_INJECTED_ARGS]);
  return Object.keys(args).filter((k) => !known.has(k));
}

/**
 * A declared name `key` was probably meant for: a prefix-variant (`addOutputs`
 * → `addOutput`, `sort` → `sortBy`) or a camel-case tail (`id` → `entityId`).
 * Required names are tried first: a call missing one is the likeliest miss.
 */
function nearMiss(
  key: string,
  declared: readonly string[],
  required: readonly string[] = []
): string | null {
  const k = key.toLowerCase();
  const tail = key.length >= 2 ? key[0]!.toUpperCase() + key.slice(1) : null;
  const hit = [...required, ...declared].find((d) => {
    const dl = d.toLowerCase();
    if (dl === k) return false;
    return (
      k.startsWith(dl) ||
      dl.startsWith(k) ||
      (tail !== null && d.endsWith(tail))
    );
  });
  return hit ?? null;
}

function nearMissHints(
  unknown: readonly string[],
  declared: readonly string[],
  required: readonly string[] = []
): string[] {
  return unknown
    .map((k) => {
      const near = nearMiss(k, declared, required);
      return near ? `\`${k}\` → did you mean \`${near}\`?` : null;
    })
    .filter((h): h is string => h !== null);
}

/** The refusal sentence. Pure, so its wording is testable. */
export function undeclaredArgsMessage(
  toolName: string,
  unknown: readonly string[],
  declared: readonly string[],
  required: readonly string[] = []
): string {
  const hints = nearMissHints(unknown, declared, required);
  return (
    `${toolName} does not take ${unknown.map((k) => `\`${k}\``).join(", ")} — NOTHING WAS CHANGED. ` +
    (hints.length > 0 ? `${hints.join(" ")} ` : "") +
    `Valid inputs: ${declared.join(", ")}. Resend with only these.`
  );
}

/**
 * The door check: `null` when every key is declared, else the refusal RESULT
 * (`isError: true`). Run for every call by `parseToolArgs` (`define-tool.ts`).
 * An unknown tool refuses nothing: the dispatch says it is unknown.
 */
export async function refuseUndeclaredArgs(
  toolName: string,
  args: Record<string, unknown> | null | undefined
): Promise<CallToolResult | null> {
  const names = await inputNames(toolName);
  if (!names) return null;
  const unknown = undeclaredArgs(args, names.declared);
  if (unknown.length === 0) return null;
  return toolError(
    undeclaredArgsMessage(toolName, unknown, names.declared, names.required)
  );
}
