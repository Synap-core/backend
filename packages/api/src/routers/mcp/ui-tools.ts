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
 * caller. ONE seam answers both "is it servable?" and "what is it?" —
 * {@link UiRendererLookup} — so `tools/list`, `resources/list` and
 * `resources/read` can never disagree about what a caller may render. The
 * default seam serves nothing, so an unwired server (stdio, the unauthenticated
 * GET/SSE stream) advertises and serves no UI at all.
 */

import { createLogger } from "@synap-core/core";
import { db, resolveSurfaceRenderer } from "@synap/database";
import {
  McpError,
  type CallToolResult,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  SLOT_TO_CONTENT_KIND,
  type RendererContentKind,
} from "../../services/profiles/renderer-slots.js";

const logger: any = createLogger({ module: "mcp-ui-tools" });

/** MCP Apps resources carry this mime type — nothing else is a UI resource. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** MCP's "resource not found" JSON-RPC code (not in the SDK's `ErrorCode`). */
export const RESOURCE_NOT_FOUND = -32002;

export type ToolUiSubject = {
  /** The object kind the tool's result renders as (`proposal`, …). */
  subjectKind: string;
  /**
   * Which renderer binding serves it — a slot's ContentKind, read through
   * `SLOT_TO_CONTENT_KIND` so it is never a hand-spelled string.
   */
  contentKind: RendererContentKind;
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
    // The `card` slot: an outside host renders the result INLINE in a chat
    // turn — a bounded card, not a full detail page (`detail`) or a profile
    // dashboard. The resource name (`proposal-card`) says the same.
    contentKind: SLOT_TO_CONTENT_KIND.card,
    resourceUri: "ui://synap/proposal-card",
  },
};

/** Who is listing tools — what the servability check may scope by. */
export type UiServableContext = {
  userId?: string;
  agentUserId?: string;
  workspaceId?: string;
};

/** What a host is served for a `ui://` resource. */
export type UiRenderer = {
  /** A complete, self-contained HTML document — served verbatim. */
  rendererSource: string;
  /** Origins the document may fetch from (→ `csp.connectDomains`). */
  externalHosts: string[];
};

/**
 * THE SEAM. "Which renderer serves `subject` to this caller?" — `null` when
 * none is servable. Servability is DERIVED from it (`!== null`), never asked
 * separately. Wired by the HTTP door to {@link resolveUiRendererFromDb}; every
 * other server is built with {@link NO_UI_RENDERER}.
 */
export type UiRendererLookup = (
  subject: ToolUiSubject,
  ctx: UiServableContext
) => Promise<UiRenderer | null>;

/** The unwired default: no tool advertises a UI, no `ui://` resource exists. */
export const NO_UI_RENDERER: UiRendererLookup = async () => null;

/**
 * The real lookup: the renderer bound on the `mcp-app` surface for this
 * subject (user → workspace → pod). DB errors throw — the callers decide what
 * a failure means for their method.
 */
export const resolveUiRendererFromDb: UiRendererLookup = async (
  subject,
  ctx
) => {
  // The HTTP door always has an authed user. A missing one is a wiring bug,
  // not "nothing bound" — refuse loudly instead of resolving without the user
  // rung (that would silently skip the caller's personal override).
  if (!ctx.userId) {
    throw new Error("MCP Apps renderer lookup needs an authenticated userId");
  }
  const hit = await resolveSurfaceRenderer(db, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId ?? null,
    subjectKind: subject.subjectKind,
    contentKind: subject.contentKind,
    surface: "mcp-app",
  });
  return hit
    ? { rendererSource: hit.rendererSource, externalHosts: hit.externalHosts }
    : null;
};

/**
 * Servability per distinct `ui://` resource, for a listing. A lookup that
 * THROWS is logged at error level (naming `label`) and counts as NOT
 * servable: a listing must not fail as a whole because one renderer read
 * failed — every text result still works without UI. Not cached across
 * requests (the per-call map only dedupes tools sharing a resource).
 */
async function servableFor(
  subject: ToolUiSubject,
  lookup: UiRendererLookup,
  ctx: UiServableContext,
  cache: Map<string, boolean>,
  label: string
): Promise<boolean> {
  const known = cache.get(subject.resourceUri);
  if (known !== undefined) return known;
  let ok: boolean;
  try {
    ok = (await lookup(subject, ctx)) !== null;
  } catch (err) {
    logger.error(
      { err, tool: label, resourceUri: subject.resourceUri },
      "MCP Apps renderer lookup failed — omitting its UI from this listing"
    );
    ok = false;
  }
  cache.set(subject.resourceUri, ok);
  return ok;
}

/**
 * Attach `_meta.ui` to every tagged tool whose subject is servable. Untagged
 * and unservable tools are returned as the SAME object (not a copy), so an
 * unwired server's `tools/list` is unchanged byte for byte.
 */
export async function withToolUiMeta(
  tools: Tool[],
  lookup: UiRendererLookup,
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
    const ok = await servableFor(subject, lookup, ctx, servable, tool.name);
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
 * The `ui://` resources `resources/list` advertises: one per distinct tagged
 * resource that is servable to this caller, and nothing otherwise.
 */
export async function listUiResources(
  lookup: UiRendererLookup,
  ctx: UiServableContext
): Promise<Resource[]> {
  const servable = new Map<string, boolean>();
  const out: Resource[] = [];
  for (const [toolName, subject] of Object.entries(TOOL_UI_SUBJECT)) {
    if (servable.has(subject.resourceUri)) continue;
    if (await servableFor(subject, lookup, ctx, servable, toolName)) {
      out.push({
        uri: subject.resourceUri,
        name: subject.resourceUri.slice("ui://synap/".length),
        description: `Synap ${subject.subjectKind} view for MCP Apps hosts`,
        mimeType: MCP_APP_MIME_TYPE,
      });
    }
  }
  return out;
}

/**
 * `resources/read` for a `ui://` URI: the bound renderer's HTML, verbatim.
 * An unknown URI or nothing servable is RESOURCE_NOT_FOUND — never an empty
 * document, which a host would render as a blank frame. A lookup failure
 * PROPAGATES: the host asked for this one document, and a failed read is not
 * an absent one.
 */
export async function readUiResource(
  uri: string,
  lookup: UiRendererLookup,
  ctx: UiServableContext
) {
  const subject = Object.values(TOOL_UI_SUBJECT).find(
    (s) => s.resourceUri === uri
  );
  const renderer = subject ? await lookup(subject, ctx) : null;
  if (!renderer) {
    throw new McpError(RESOURCE_NOT_FOUND, `Resource not found: ${uri}`, {
      uri,
    });
  }
  return {
    contents: [
      {
        uri,
        mimeType: MCP_APP_MIME_TYPE,
        text: renderer.rendererSource,
        // Spec: `_meta.ui.csp` sits on the CONTENT item. No hosts → no csp,
        // so the host applies its default deny-all egress.
        ...(renderer.externalHosts.length > 0
          ? {
              _meta: {
                ui: { csp: { connectDomains: renderer.externalHosts } },
              },
            }
          : {}),
      },
    ],
  };
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
