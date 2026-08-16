/**
 * MCP to Hub Protocol Adapter
 *
 * This adapter allows MCP to use the existing Hub Protocol API,
 * ensuring all operations go through the same event sourcing,
 * validation, security, and worker infrastructure.
 *
 * DISPATCH (router-decomposition Wave 7): `executeMCPToolViaHubProtocol`
 * used to be a single ~3,300-line `switch (toolName)`. It is now a thin
 * setup phase (this file) that builds the shared `McpToolContext` and looks
 * the tool up in `TOOL_HANDLERS` — a `Record<toolName, handler>` merged
 * from the per-domain files under `./handlers/`. Every tool name key and
 * every handler's behavior is preserved byte-for-byte; only the wrapping
 * changed. See `handlers/shared.ts` for the caller factory, `ok`/
 * `requireScope`, and focus-session resolution helpers.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveConfinedWorkspace } from "../hub-protocol/confine-workspace.js";
import { logger, verifyWorkspaceAccess } from "../hub-protocol/rest/_shared.js";
import { getAgentFocusWorkspaceId } from "../../services/agent-identity-service.js";
import {
  createHubProtocolCaller,
  pickAdvisoryWorkspaceId,
  resolveSessionHandle,
  type McpHandlerMap,
  type ResolvedSession,
} from "./handlers/shared.js";
import { readHandlers } from "./handlers/read.js";
import { entityHandlers } from "./handlers/entity.js";
import { captureHandlers } from "./handlers/capture.js";
import { capabilityHandlers } from "./handlers/capability.js";
import { workspaceHandlers } from "./handlers/workspace.js";
import { sessionHandlers } from "./handlers/session.js";
import { buildHandlers } from "./handlers/build.js";

export { isReadOnlyTool, pickAdvisoryWorkspaceId } from "./handlers/shared.js";

/**
 * THE dispatch map — every MCP tool name declared in `tools/index.ts`
 * resolves to exactly one handler here. Merged from the per-domain files;
 * a tool declared in `tools/index.ts` but missing here falls through to
 * `executeMCPToolViaHubProtocol`'s `Unknown MCP tool` error, same as the
 * old switch's `default:`. Kept alias: `synap_capture_graph` (deprecated,
 * not declared in `tools/index.ts` `list()`) maps to the same handler as
 * `synap_capture` — see `handlers/capture.ts`.
 */
const TOOL_HANDLERS: McpHandlerMap = {
  ...readHandlers,
  ...entityHandlers,
  ...captureHandlers,
  ...capabilityHandlers,
  ...workspaceHandlers,
  ...sessionHandlers,
  ...buildHandlers,
};

export async function executeMCPToolViaHubProtocol(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
  apiKeyScopes: string[],
  _sessionUserId?: string,
  agentUserId?: string,
  /**
   * SERVICE-KEY CONFINEMENT: the authenticating key's `keyType` + workspace
   * binding. When it is a bound `service` key, EVERY workspace this call would
   * touch (the injected `?workspaceId=` lens and every `args.workspaceId` a
   * write reads) is clamped to the binding via `resolveConfinedWorkspace` — the
   * SAME primitive the Hub REST door uses. Non-service/unbound keys pass through
   * unchanged.
   */
  keyType?: string | null,
  keyWorkspaceId?: string | null
): Promise<CallToolResult> {
  const session = await resolveSessionHandle(toolName, args, userId);
  const sessionId = session?.sessionId;

  const caller = await createHubProtocolCaller(
    userId,
    apiKeyScopes,
    agentUserId,
    sessionId,
    null,
    keyType,
    keyWorkspaceId
  );

  // The MCP server auto-injects the URL lens (`?workspaceId=`) into every tool
  // call that accepts it. Entity writes ignored it entirely, so the hub fell
  // back to the user's most-recently-updated workspace membership. `lensCaller`
  // is the same hub caller with that lens as the AMBIENT governance workspace —
  // used by the entity write tools below. Normalized like `sessionId`: a
  // non-string arg is dropped rather than blindly cast.
  //
  // SECURITY: the URL lens is injected ONLY when the model didn't send one
  // (mcp/index.ts), so `args.workspaceId` here can be a MODEL-supplied id. It
  // becomes `ctx.workspaceId`, which the hub write procs consume as the ambient
  // governance workspace WITHOUT re-validating it (`entities.create` only
  // membership-checks `input.targetWorkspaceId`). Gate it here — the same
  // `verifyWorkspaceAccess` the capture-graph branch uses.
  const rawRequestedWorkspaceId =
    typeof args.workspaceId === "string" && args.workspaceId.trim() !== ""
      ? args.workspaceId
      : undefined;
  // SERVICE-KEY CONFINEMENT (the one clamp for the whole call): resolve the
  // requested workspace through the shared primitive BEFORE it becomes any lens
  // or write input. A bound `service` key targeting another workspace throws 403
  // HERE (before the switch → every read/write handler is covered); a bound key
  // with no target is positively pinned to its binding; non-service/unbound keys
  // return the requested value unchanged. Downstream reads `requestedWorkspaceId`
  // (the confined value) everywhere it previously read the raw `args.workspaceId`.
  const confinedWorkspaceId =
    resolveConfinedWorkspace(
      keyType,
      keyWorkspaceId,
      rawRequestedWorkspaceId
    ) ?? undefined;
  // ADVISORY WORKSPACE FOCUS (WORKSPACE-PLACEMENT-AGENT-FOCUS-PLAN.md, Layer 2):
  // only consulted when NEITHER an explicit `args.workspaceId` NOR a bound
  // service-key pin resolved anything above — priority is explicit-per-call >
  // service-key pin > agent's live focus. MCP *write* tools that need a
  // concrete home (capture text, create_project/playbook, run_playbook) must
  // NOT fall back to membership[0] when this is still null — they reject via
  // `rejectMissingWriteWorkspace` (run_playbook also falls through to the
  // playbook's own workspaceId, then subject/session, before rejecting).
  // Catalog/read tools like list_playbooks use listAllPage (user floor) — no
  // membership[0]. Never overrides, never 403s: a
  // focus on a workspace the caller has since lost access to is silently
  // dropped by the `verifyWorkspaceAccess` check right below, same as any
  // other lens.
  const requestedWorkspaceId = pickAdvisoryWorkspaceId(
    confinedWorkspaceId,
    agentUserId ? await getAgentFocusWorkspaceId(agentUserId) : undefined
  );
  const workspaceAccessible = requestedWorkspaceId
    ? await verifyWorkspaceAccess(userId, requestedWorkspaceId)
    : false;
  if (requestedWorkspaceId && !workspaceAccessible) {
    // DROPPED, not rejected — like the session handle, the ambient lens is a
    // governance HINT, and falling back to no lens is exactly the (safe)
    // behaviour that predates it. Failing the whole call would also punish the
    // legitimate owner-without-member-row case. Placement PINS still fail loud:
    // the capture-graph branch below reuses this verdict to return Forbidden.
    logger.warn(
      { userId, workspaceId: requestedWorkspaceId, toolName },
      "mcp: workspace lens is not accessible to the caller — ignoring"
    );
  }
  const lensWorkspaceId = workspaceAccessible
    ? requestedWorkspaceId
    : undefined;
  const lensCaller = lensWorkspaceId
    ? await createHubProtocolCaller(
        userId,
        apiKeyScopes,
        agentUserId,
        sessionId,
        lensWorkspaceId,
        keyType,
        keyWorkspaceId
      )
    : caller;

  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    throw new Error(
      `Unknown MCP tool: ${toolName}. Call synap_load_skill("catalog") for skills or synap_list_capabilities({query}) to find capabilities.`
    );
  }
  const result = await handler({
    toolName,
    args,
    userId,
    apiKeyScopes,
    agentUserId,
    sessionId,
    keyType,
    keyWorkspaceId,
    caller,
    lensCaller,
    requestedWorkspaceId,
    lensWorkspaceId,
    confinedWorkspaceId,
    workspaceAccessible,
  });

  // A GUESS MUST ANNOUNCE ITSELF. When several sessions were open we attributed
  // this write to the most recently started one — usually right, occasionally
  // not. Disclosing it here (once, in the adapter) is what makes the guess
  // legitimate: the model learns the write was grouped by inference and can
  // re-issue with an explicit `sessionId` if it was wrong. Silent inference is
  // the thing we refuse, not inference.
  //
  // Deliberately NOT threaded through every handler's own payload shape — one
  // place, no per-handler drift.
  return session?.ambiguous ? withSessionDisclosure(result, session) : result;
}

/** Appends the ambiguity note to a tool result without disturbing its payload. */
function withSessionDisclosure(
  result: CallToolResult,
  session: ResolvedSession
): CallToolResult {
  const note =
    `Note: ${session.openCount} of your focus sessions are open. This write was ` +
    `attributed to the most recently started one (${session.sessionId}). If it ` +
    `belongs to another, pass that session's id as \`sessionId\`.`;
  return {
    ...result,
    content: [
      ...(Array.isArray(result.content) ? result.content : []),
      { type: "text" as const, text: note },
    ],
  };
}

/**
 * Read MCP resource by calling Hub Protocol API
 */
export async function readMCPResourceViaHubProtocol(
  uri: string,
  userId: string,
  apiKeyScopes: string[]
): Promise<{
  contents: Array<{ uri: string; mimeType: string; text?: string }>;
}> {
  if (!apiKeyScopes.includes("mcp.read")) {
    throw new Error("Insufficient permissions: mcp.read required");
  }

  const caller = await createHubProtocolCaller(userId, apiKeyScopes);

  const match = uri.match(/^synap:\/\/(\w+)(?:\/(.+))?$/);
  if (!match) throw new Error(`Invalid resource URI: ${uri}`);

  const [, resourceType, resourcePath] = match;

  if (resourceType === "entities") {
    const parts = resourcePath?.split("/") || [];
    const entityType = parts[0]?.replace(/s$/, "");
    const entityId = parts[1];

    if (entityId) {
      const all = await caller.entities.getEntities({ userId, limit: 1 });
      const entity = all.find((e: { id: string }) => e.id === entityId);
      if (!entity) throw new Error(`Entity not found: ${uri}`);
      return {
        contents: [
          { uri, mimeType: "application/json", text: JSON.stringify(entity) },
        ],
      };
    }

    const entities = await caller.entities.getEntities({
      userId,
      profileSlug: entityType || undefined,
      limit: 100,
    });
    return {
      contents: [
        { uri, mimeType: "application/json", text: JSON.stringify(entities) },
      ],
    };
  }

  if (resourceType === "threads") {
    const parts = resourcePath?.split("/") || [];
    const threadId = parts[0];
    if (!threadId)
      throw new Error("Thread ID required: synap://threads/{id}/context");
    const context = await caller.context.getThreadContext({ threadId });
    return {
      contents: [
        { uri, mimeType: "application/json", text: JSON.stringify(context) },
      ],
    };
  }

  throw new Error(`Unknown resource type: ${resourceType}`);
}
