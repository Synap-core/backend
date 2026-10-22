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
 * (`tools.list()`), never a second hand-kept list: a property added to the
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

/** Keys the MCP door injects into every tool call (the URL lens). */
export const DOOR_INJECTED_ARGS = ["workspaceId", "projectId"] as const;

/** The declared property names of `toolName`'s input schema, or null. */
export async function declaredArgNames(
  toolName: string
): Promise<string[] | null> {
  const { tools } = await import("./tools/index.js");
  const def = (await tools.list()).find((t) => t.name === toolName);
  const props = (def?.inputSchema as { properties?: Record<string, unknown> })
    ?.properties;
  return props ? Object.keys(props) : null;
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

/** A declared name that is a prefix-variant of `key` (`addOutputs` → `addOutput`). */
function nearMiss(key: string, declared: readonly string[]): string | null {
  const k = key.toLowerCase();
  const hit = declared.find((d) => {
    const dl = d.toLowerCase();
    return dl !== k && (k.startsWith(dl) || dl.startsWith(k));
  });
  return hit ?? null;
}

/** The refusal sentence. Pure, so its wording is testable. */
export function undeclaredArgsMessage(
  toolName: string,
  unknown: readonly string[],
  declared: readonly string[]
): string {
  const hints = unknown
    .map((k) => {
      const near = nearMiss(k, declared);
      return near ? `\`${k}\` → did you mean \`${near}\`?` : null;
    })
    .filter((h): h is string => h !== null);
  return (
    `${toolName} does not take ${unknown.map((k) => `\`${k}\``).join(", ")} — NOTHING WAS CHANGED. ` +
    (hints.length > 0 ? `${hints.join(" ")} ` : "") +
    `Valid inputs: ${declared.join(", ")}. Resend with only these.`
  );
}

/**
 * The door check: `null` when every key is declared, else the refusal RESULT
 * (`isError: true`). A tool absent from `tools.list()` refuses nothing (it is
 * a bug in the list, not a reason to block every call); a list that cannot be
 * BUILT throws, and the MCP error door reports it.
 */
export async function refuseUndeclaredArgs(
  toolName: string,
  args: Record<string, unknown> | null | undefined
): Promise<CallToolResult | null> {
  const declared = await declaredArgNames(toolName);
  if (!declared) return null;
  const unknown = undeclaredArgs(args, declared);
  if (unknown.length === 0) return null;
  return toolError(undeclaredArgsMessage(toolName, unknown, declared));
}
