/**
 * The AGENT CONVERSATION behind a piece of work — the one a person can reopen
 * to talk to the agent that did it (debug an error, ask why).
 *
 * The pod groups every agent write by a client key
 * `key:<apiKeyId>|conv:<conversationId>` and stamps it on the session as
 * `metadata.clientKey`. A LOCAL agent's client names its OWN conversation in
 * the conversation half (`X-Synap-Conversation: claude-code:<uuid>`, sent by
 * the synap CLI and its stdio MCP bridge), so that id is resumable. Any other
 * conversation half — the `Mcp-Session-Id` the pod mints for a hosted chat app
 * (claude.ai, ChatGPT), which never exposes its own id — is NOT a door, and
 * this returns null for it rather than a command that resumes nothing.
 *
 * ONE derivation for every surface (browser, relay). Pure.
 */

import { AGENT_HARNESSES } from "./harnesses.js";

const CONVERSATION_SEP = "|conv:";

/** Harnesses whose conversation id we can turn into a reopen door (the registry's `reopen`). */
export type AgentConversationHarness = Extract<
  (typeof AGENT_HARNESSES)[number],
  { reopen: unknown }
>["slug"];

export interface AgentConversationRef {
  harness: AgentConversationHarness;
  /** The harness's own conversation id (Claude Code: the session UUID). */
  conversationId: string;
  /** Where it ran, when its client said so. Display only. */
  cwd: string | null;
  /**
   * The shell command that reopens it, on the computer it ran on. Built only
   * from a validated id, so it is safe to show and copy as-is.
   */
  resumeCommand: string;
}

/** The conversation half of a client key, or null (key scope / none). */
export function conversationOfClientKey(
  clientKey: string | null | undefined
): string | null {
  if (!clientKey) return null;
  const at = clientKey.indexOf(CONVERSATION_SEP);
  return at === -1
    ? null
    : clientKey.slice(at + CONVERSATION_SEP.length) || null;
}

/**
 * The reopenable conversation recorded on a session's metadata, or null when
 * the work came from a conversation we cannot reopen (a hosted chat app, a
 * key-scoped client, a person).
 */
export function resolveAgentConversation(
  metadata:
    { clientKey?: unknown; conversationCwd?: unknown } | null | undefined
): AgentConversationRef | null {
  const clientKey =
    typeof metadata?.clientKey === "string" ? metadata.clientKey : null;
  const half = conversationOfClientKey(clientKey) ?? "";
  const at = half.indexOf(":");
  const slug = at === -1 ? "" : half.slice(0, at);
  const harness = AGENT_HARNESSES.find((h) => h.slug === slug && "reopen" in h);
  if (!harness || !("reopen" in harness)) return null;
  const id = half.slice(at + 1);
  if (!harness.reopen.idPattern.test(id)) return null;
  const conversationId = id.toLowerCase();
  const cwd =
    typeof metadata?.conversationCwd === "string" && metadata.conversationCwd
      ? metadata.conversationCwd
      : null;
  return {
    harness: harness.slug as AgentConversationHarness,
    conversationId,
    cwd,
    resumeCommand: harness.reopen.command(conversationId),
  };
}
