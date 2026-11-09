/**
 * `synap_call_tool({tool, arguments})` — run a tool this key has unlocked but
 * its client does not list yet, in the same turn (plan "live tool unlock",
 * pod document c28d0683; founder-validated 2026-11-09).
 *
 * WHY: an entry key lists 15 tools; `synap_load_skill('tools:<group>')`
 * unlocks more on the key, but most clients only see a new tool after they
 * list again (claude.ai, ChatGPT, Cursor never re-list on `list_changed`, and
 * this door answers in JSON, which drops the notification). The client
 * refuses to let its model call an unlisted tool, while the pod would run it.
 * The dispatcher is listed from the start, so the model calls IT and names
 * the tool.
 *
 * HOW THE CALL IS JUDGED: the tools/call door (`mcp/index.ts`) unwraps a
 * dispatcher call ONCE, at its top (`effectiveToolCall`, `call-tool-name.ts`),
 * then runs the call fence (`toolCallRefusal`), the undeclared-args shadow and
 * `tools.execute` on the INNER tool, exactly as a direct call of it. The
 * dispatcher has no authority of its own, so nothing judges its name.
 *
 * What the dispatcher adds on top of the direct call (this module, pure):
 *  - it runs only a tool THIS KEY LISTS (`filterToolsForAccess`): a tool in a
 *    group the key has not unlocked is refused with the exact unlock call
 *    (founder decision 1), and a name no tool carries, or itself, is refused;
 *  - `arguments` left out answers the tool's input schema instead of running
 *    it; arguments that are not an object or miss a required key are refused
 *    with that schema; a tool that answers an error gets its schema appended.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { CALL_TOOL_NAME } from "./call-tool-name.js";
import { toolError } from "./tool-errors.js";
import { TOOL_GROUPS, TOOL_GROUP_NAMES } from "./tool-profiles.js";
import { loadSkillCall } from "./tool-guidance.js";

/** Renders a pod tool name as the calling door names it (`pod__*` on the connector). */
export type DoorNamer = (podName: string) => string;

/** What the tools/call door does with a dispatcher call. */
export type DispatchResolution =
  | {
      kind: "run";
      name: string;
      args: Record<string, unknown>;
      def: Pick<Tool, "name" | "inputSchema">;
    }
  | { kind: "answer"; result: CallToolResult };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The tool's input, as the dispatcher hands it back. */
function schemaBlock(def: Pick<Tool, "name" | "inputSchema">): string {
  return `\`\`\`json\n${JSON.stringify({ tool: def.name, inputSchema: def.inputSchema })}\n\`\`\``;
}

/** Required keys of `schema` that `args` does not carry. */
function missingRequired(
  def: Pick<Tool, "inputSchema">,
  args: Record<string, unknown>
): string[] {
  const required = (def.inputSchema as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return required.filter(
    (k): k is string => typeof k === "string" && args[k] === undefined
  );
}

/**
 * Decide what a dispatcher call does. `defs` = every tool (`tools.list()`);
 * `listed` = the names this key lists (`visibleToolNames`), `null` = every
 * tool. `doorNames` is read only to word a refusal.
 */
export async function resolveDispatch(
  dispatcherArgs: Record<string, unknown>,
  defs: ReadonlyArray<Pick<Tool, "name" | "inputSchema">>,
  listed: ReadonlySet<string> | null,
  doorNames: () => Promise<DoorNamer>
): Promise<DispatchResolution> {
  const answer = async (text: (n: DoorNamer) => string, isError = true) => {
    const n = await doorNames();
    const result: CallToolResult = isError
      ? toolError(text(n))
      : { content: [{ type: "text", text: text(n) }] };
    return { kind: "answer", result } as const;
  };
  const tool =
    typeof dispatcherArgs.tool === "string" ? dispatcherArgs.tool.trim() : "";
  if (!tool) {
    return answer(
      (n) =>
        `\`tool\` is required: the name of the tool to run (e.g. ${n("synap_get_entity")}), with its input as \`arguments\`. Leave \`arguments\` out to get the tool's input schema.`
    );
  }
  if (tool === CALL_TOOL_NAME) {
    return answer(
      (n) =>
        `${n(CALL_TOOL_NAME)} runs another tool; it cannot call itself. Name the tool you want as \`tool\`.`
    );
  }
  const def = defs.find((d) => d.name === tool);
  if (!def) {
    return answer(
      (n) =>
        `No tool is named "${tool}". ${n("synap_load_skill")}({ref: "catalog"}) lists the teaching skills; a tool group's names come with its unlock, e.g. ${loadSkillCall(n("synap_load_skill"))}.`
    );
  }
  if (listed && !listed.has(tool)) {
    const group = TOOL_GROUP_NAMES.find((g) =>
      (TOOL_GROUPS[g] as readonly string[]).includes(tool)
    );
    // Every advertised tool is entry (always listed) or in one group
    // (`tool-profiles.test.ts`); a tool in neither is not this key's to run.
    if (!group) {
      return answer((n) => `${n(tool)} is not available to this key.`);
    }
    return answer(
      (n) =>
        `${n(tool)} is in the tool group "${group}", which this key has not unlocked. Unlock it first: ${loadSkillCall(n("synap_load_skill"), group)}, then call ${n(CALL_TOOL_NAME)} again. Nothing was run.`
    );
  }
  const raw = dispatcherArgs.arguments;
  if (raw === undefined) {
    return answer(
      (n) =>
        `${n(tool)} was not run: \`arguments\` was left out. Its input, to pass as \`arguments\` to ${n(CALL_TOOL_NAME)}:\n\n${schemaBlock(def)}`,
      false
    );
  }
  if (!isPlainObject(raw)) {
    return answer(
      (n) =>
        `\`arguments\` must be an object: ${n(tool)}'s input. Nothing was run. Its input schema:\n\n${schemaBlock(def)}`
    );
  }
  const missing = missingRequired(def, raw);
  if (missing.length > 0) {
    return answer(
      (n) =>
        `${n(tool)} needs ${missing.map((k) => `\`${k}\``).join(", ")} in \`arguments\`. Nothing was run. Its input schema:\n\n${schemaBlock(def)}`
    );
  }
  // The dispatcher's own `sessionId` (declared because it is a write tool,
  // `tools.list()` W-C1) reaches the tool when `arguments` names none.
  const sessionId = dispatcherArgs.sessionId;
  const args =
    typeof sessionId === "string" && raw.sessionId === undefined
      ? { ...raw, sessionId }
      : raw;
  return { kind: "run", name: tool, args, def };
}

/**
 * A dispatched tool that answered an error gets its input schema appended:
 * the caller's client does not list the tool, so its model has no other way
 * to see what the tool takes.
 */
export function withInputSchemaOnError(
  result: CallToolResult,
  def: Pick<Tool, "name" | "inputSchema">
): CallToolResult {
  if (!result.isError) return result;
  return {
    ...result,
    content: [
      ...(result.content ?? []),
      {
        type: "text",
        text: `Input schema of ${def.name}, for your next call:\n\n${schemaBlock(def)}`,
      },
    ],
  };
}
