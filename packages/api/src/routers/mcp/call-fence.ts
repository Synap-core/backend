/**
 * THE two refusals of an MCP `tools/call`, decided in the tool-call door
 * (`createMCPServer`'s `tools/call` handler) — the one point every tool call
 * reaches, whatever shape the HTTP body had.
 *
 * They used to run in the HTTP handler on `parsedBody.method`, which reads ONE
 * JSON-RPC object. The SDK transport also accepts a JSON-RPC batch (an array)
 * and dispatches every request in it, so `[{"method":"tools/call",…}]` skipped
 * both: a space-pinned key read pod-wide through `synap_ask`, and a bare human
 * key wrote with no agent attribution (audit F4, 2026-10-28). The HTTP door now
 * refuses batches too (`MCP_BATCH_REFUSED`), but the refusal lives here so no
 * future transport shape can walk past it.
 *
 *  1. Attribution (Phase 0, docs/decisions/agent-governance.md D1): a
 *     `user_pat`/`hub_inbound` key with no `linkedUserId` that is not an agent
 *     principal is a bare human key used as an agent. A human does not speak
 *     MCP, so its WRITE is refused; left alone it falls to the human governance
 *     path and DEFAULT_AUTO_APPROVE verbs execute with no proposal. Reads pass.
 *  2. W1 grant fence (`access/grant-door-fence.ts`): a scoped key may only call
 *     READ tools whose reads its grant bounds. Writes pass to the gate.
 *
 * An unknown tool name is refused by neither: the SDK's own error names it.
 * `resources/read` gets the same fence (`resourceReadRefusal`): it was never
 * fenced at all.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KeyGrant } from "@synap/database";
import {
  GRANT_DOOR_UNSUPPORTED,
  isFencedGrant,
  mcpToolAllowed,
} from "../../access/grant-door-fence.js";

/** Who is calling, as the HTTP door resolved the key (`resolveKeyIdentity`). */
export interface McpCallPrincipal {
  /** The key's grant; absent or full access ⇒ no fence. */
  grant?: KeyGrant | null;
  keyType?: string | null;
  linkedUserId?: string | null;
  /** The key's principal is an agent (`userType === 'agent'`). */
  isAgent?: boolean;
}

/** JSON-RPC error code of both refusals (the code the HTTP 403 body carried). */
export const MCP_CALL_REFUSED_CODE = -32001;

export const UNATTRIBUTED_WRITE_MESSAGE =
  "This key is not an agent key. Run `synap init` to provision one.";

/**
 * Said to a client that POSTs a JSON-RPC batch. MCP removed batching in
 * protocol 2025-06-18 and no Synap client sends one.
 */
export const MCP_BATCH_REFUSED =
  "Batch requests are not supported: send one JSON-RPC message per request.";

/**
 * Refusal 1: a WRITE tool called by a bare human key misused as an agent.
 * Unknown and read-only tools are never refused here.
 */
export function shouldRejectUnattributedWrite(
  toolName: string,
  toolDefs: ReadonlyArray<Pick<Tool, "name" | "annotations">>,
  principal: McpCallPrincipal
): boolean {
  const tool = toolDefs.find((t) => t.name === toolName);
  if (!tool || tool.annotations?.readOnlyHint === true) return false;
  // The is-agent signal ADMITS a real agent principal, including a pod-wide
  // agent (no linked human). Owner-attributed non-agent keys (service creds)
  // are not bare and pass.
  return (
    !principal.isAgent &&
    !principal.linkedUserId &&
    (principal.keyType === "user_pat" || principal.keyType === "hub_inbound")
  );
}

/**
 * Why this call is refused, or `null` when it may run. Pure, so every case is
 * a table row.
 */
export function toolCallRefusal(
  toolName: string,
  toolDefs: ReadonlyArray<Pick<Tool, "name" | "annotations">>,
  principal: McpCallPrincipal
): string | null {
  if (shouldRejectUnattributedWrite(toolName, toolDefs, principal)) {
    return UNATTRIBUTED_WRITE_MESSAGE;
  }
  const tool = toolDefs.find((t) => t.name === toolName);
  if (
    tool &&
    isFencedGrant(principal.grant) &&
    !mcpToolAllowed(tool.name, tool.annotations?.readOnlyHint, principal.grant!)
  ) {
    return GRANT_DOOR_UNSUPPORTED;
  }
  return null;
}

/**
 * `resources/read`: a `synap://` resource (entity lists, one entity, a
 * thread's context) is a read door the W1 inventory never classified, so a
 * fenced key is refused it, fail closed like every unclassified read door.
 * `ui://` documents are static MCP Apps UI, not pod data.
 */
export function resourceReadRefusal(
  uri: string,
  principal: McpCallPrincipal | undefined
): string | null {
  if (!principal || !isFencedGrant(principal.grant)) return null;
  return uri.startsWith("ui://") ? null : GRANT_DOOR_UNSUPPORTED;
}
