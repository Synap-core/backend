/**
 * MCP Apps (SEP-1865, spec 2026-01-26) — the ONE declaration point for which
 * MCP tools can render as inline Synap UI in an outside host (Claude, ChatGPT,
 * VS Code).
 *
 * The contract: a tool advertises `_meta.ui = { resourceUri, visibility }`; the
 * host reads that `ui://` resource (`text/html;profile=mcp-app`), renders it in
 * a sandboxed iframe, and pushes the tool result's `structuredContent` into it.
 * The iframe calls tools back through the host on the SAME agent credential.
 * The nested `_meta.ui` key is the only form emitted — never the legacy flat
 * `_meta["ui/resourceUri"]`.
 *
 * Tagging is BY OBJECT KIND: a tool names the subject kind it returns, and
 * `_meta.ui` is attached only when a renderer for that kind is SERVABLE to this
 * caller (`IsUiServable`). The default seam answers `false`, so until the
 * renderer resolver is wired `tools/list` is byte-identical to before.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export type ToolUiSubject = {
  /** The object kind the tool's result renders as (`proposal`, …). */
  subjectKind: string;
  /** The `ui://` resource the host reads to render it. */
  resourceUri: `ui://synap/${string}`;
};

/**
 * Tool name → the UI it renders as. A tool absent here never carries
 * `_meta.ui` and never gets `structuredContent`.
 */
export const TOOL_UI_SUBJECT: Readonly<Record<string, ToolUiSubject>> = {
  synap_get_proposal: {
    subjectKind: "proposal",
    resourceUri: "ui://synap/proposal-card",
  },
};

/** Who is listing tools — what the servability check may scope by. */
export type UiServableContext = {
  userId?: string;
  agentUserId?: string;
  workspaceId?: string;
};

/**
 * THE SEAM. "Can a renderer for `subjectKind` be served to this caller?"
 * Wired by the renderer layer (`resolveSurfaceRenderer`); until then every
 * server is built with {@link UI_NOT_SERVABLE}.
 */
export type IsUiServable = (
  subjectKind: string,
  ctx: UiServableContext
) => Promise<boolean>;

/** The unwired default: no tool advertises a UI. */
export const UI_NOT_SERVABLE: IsUiServable = async () => false;

/**
 * Attach `_meta.ui` to every tagged tool whose subject is servable. Untagged
 * and unservable tools are returned as the SAME object (not a copy), so an
 * unwired server's `tools/list` is unchanged byte for byte.
 */
export async function withToolUiMeta(
  tools: Tool[],
  isUiServable: IsUiServable,
  ctx: UiServableContext
): Promise<Tool[]> {
  const servable = new Map<string, boolean>();
  const out: Tool[] = [];
  for (const tool of tools) {
    const subject = TOOL_UI_SUBJECT[tool.name];
    if (!subject) {
      out.push(tool);
      continue;
    }
    let ok = servable.get(subject.subjectKind);
    if (ok === undefined) {
      ok = await isUiServable(subject.subjectKind, ctx);
      servable.set(subject.subjectKind, ok);
    }
    out.push(
      ok
        ? {
            ...tool,
            _meta: {
              ...tool._meta,
              ui: {
                resourceUri: subject.resourceUri,
                visibility: ["model", "app"],
              },
            },
          }
        : tool
    );
  }
  return out;
}

/**
 * Add `structuredContent` to a tagged tool's result — the SAME object the JSON
 * text block carries, read back from that block. Applied as the LAST step of
 * result shaping, so every field stamped onto the text (`link`, `attribution`)
 * is already in it and the two copies cannot diverge. Untagged tools, error
 * results and non-object payloads (arrays, plain text) are returned unchanged.
 */
export function withUiStructuredContent(
  toolName: string,
  result: CallToolResult
): CallToolResult {
  if (!TOOL_UI_SUBJECT[toolName] || result.isError) return result;
  if (!Array.isArray(result.content)) return result;
  for (const block of result.content) {
    if (block.type !== "text") continue;
    const payload = parseJsonObject(block.text);
    if (payload) return { ...result, structuredContent: payload };
  }
  return result;
}

/** The JSON object a text block carries, or `null` (array / non-JSON). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
