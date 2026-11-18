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
import { createLogger } from "@synap-core/core";
import { toolError } from "./tool-errors.js";
import { clearIgnoredArgs, noteIgnoredArgs } from "./call-notices.js";

const logger = createLogger({ module: "mcp/undeclared-args" });

/** Keys the MCP door injects into every tool call (the URL lens). */
export const DOOR_INJECTED_ARGS = ["workspaceId", "projectId"] as const;

/** The declared and the required property names of a tool, or null. */
async function inputNames(
  toolName: string
): Promise<{ declared: string[]; required: string[] } | null> {
  const { tools } = await import("./tools/index.js");
  const def = (await tools.list()).find((t) => t.name === toolName);
  const schema = def?.inputSchema as
    { properties?: Record<string, unknown>; required?: unknown } | undefined;
  if (!schema?.properties) return null;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === "string")
    : [];
  return { declared: Object.keys(schema.properties), required };
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
  declared: readonly string[]
): string {
  const hints = nearMissHints(unknown, declared);
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
  // The refusal names them itself: the door's `ignoredArgs` note would repeat it.
  clearIgnoredArgs();
  return toolError(undeclaredArgsMessage(toolName, unknown, declared));
}

/**
 * The note the `tools/call` door adds to a reply when the call carried
 * arguments the tool does not take (`call-notices.ts`): they were IGNORED,
 * what each was probably meant as, and the inputs the tool has. Pure.
 */
export function ignoredArgsNote(
  toolName: string,
  unknown: readonly string[],
  declared: readonly string[],
  required: readonly string[] = []
): string {
  const hints = nearMissHints(unknown, declared, required);
  return (
    `${toolName} does not take ${unknown.map((k) => `\`${k}\``).join(", ")}: ignored. ` +
    (hints.length > 0 ? `${hints.join(" ")} ` : "") +
    `Its inputs: ${declared.join(", ")}.`
  );
}

/**
 * SHADOW (W-C1): the undeclared keys of a call, LOGGED per (tool, key) — key
 * names only, never values — and the call is NOT refused. Since tickets
 * e18a0451 / 2d61ff7c the caller is told too: the keys are noted for the
 * door's reply (`ignoredArgs`, `call-notices.ts`), so `sort` on a tool whose
 * input is `sortBy` no longer returns the default order as if it were sorted. The dispatch calls
 * this for every tool; after seven days of these numbers every recurrent key
 * is either declared (a handler reads it) or confirmed junk, and the dispatch
 * refuses through {@link refuseUndeclaredArgs} instead (W-C3). Returns the
 * keys it logged. A list that cannot be built is logged too, never folded
 * into "nothing undeclared".
 */
export async function shadowUndeclaredArgs(
  toolName: string,
  args: Record<string, unknown> | null | undefined
): Promise<string[]> {
  try {
    const names = await inputNames(toolName);
    if (!names) return [];
    const { declared, required } = names;
    const unknown = undeclaredArgs(args, declared);
    if (unknown.length > 0) {
      noteIgnoredArgs({
        keys: unknown,
        note: ignoredArgsNote(toolName, unknown, declared, required),
      });
      logger.info(
        { toolName, undeclaredKeys: unknown, shadow: true },
        "mcp: tool call carried undeclared arguments (accepted; shadow count)"
      );
    }
    return unknown;
  } catch (err) {
    logger.warn(
      { err, toolName },
      "mcp: undeclared-argument shadow check could not run"
    );
    return [];
  }
}
