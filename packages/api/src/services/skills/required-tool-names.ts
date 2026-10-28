/**
 * `requiredTools` as the agent doors take them: tool NAMES (as
 * synap_list_capabilities lists them), resolved to ids under the same
 * visibility + lens `synap_create_verb` uses for its parent tool. An unknown
 * name is refused, never dropped.
 *
 * Shared by `synap_create_skill` (lens: the workspace the skill is created
 * in) and `synap_update_skill` (lens: the skill's own workspace), so the two
 * doors cannot read one name two ways.
 */
import { getDb } from "@synap/database";

export const REQUIRED_TOOLS_SHAPE_MESSAGE =
  'requiredTools must be an array of installed tool names, e.g. ["apify_api"].';

/** The names, when `raw` is a well-formed list; `null` otherwise. */
export function readRequiredToolNames(raw: unknown): string[] | null {
  if (
    !Array.isArray(raw) ||
    !raw.every((n) => typeof n === "string" && n.trim())
  ) {
    return null;
  }
  return [...new Set((raw as string[]).map((n) => n.trim()))];
}

export async function resolveRequiredToolNames(params: {
  userId: string;
  names: readonly string[];
  workspaceId: string | null;
}): Promise<{ ids: string[] } | { error: string }> {
  // Dynamic, as the create door had it: the verb module's graph stays out of
  // the skill doors' load.
  const { parentToolWhere, parentToolMissingMessage } =
    await import("../capabilities/create-declarative-verb.js");
  const { tools: toolsTable } = await import("@synap/database/schema");
  const db = await getDb();
  const ids: string[] = [];
  for (const toolName of params.names) {
    const [tool] = await db
      .select({ id: toolsTable.id })
      .from(toolsTable)
      .where(
        parentToolWhere({
          userId: params.userId,
          toolName,
          workspaceId: params.workspaceId,
        })
      )
      .limit(1);
    if (!tool) {
      return {
        error: parentToolMissingMessage(
          toolName,
          params.workspaceId ?? undefined
        ),
      };
    }
    ids.push(tool.id);
  }
  return { ids };
}
