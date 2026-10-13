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

const CONVERSATION_SEP = "|conv:";

/** Harnesses whose conversation id we can turn into a reopen door. */
export const AGENT_CONVERSATION_HARNESSES = ["claude-code"] as const;
export type AgentConversationHarness =
  (typeof AGENT_CONVERSATION_HARNESSES)[number];

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

const CLAUDE_CODE_ID =
  /^claude-code:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

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
  const match = CLAUDE_CODE_ID.exec(conversationOfClientKey(clientKey) ?? "");
  if (!match) return null;
  const conversationId = match[1]!.toLowerCase();
  const cwd =
    typeof metadata?.conversationCwd === "string" && metadata.conversationCwd
      ? metadata.conversationCwd
      : null;
  return {
    harness: "claude-code",
    conversationId,
    cwd,
    resumeCommand: `claude --resume ${conversationId}`,
  };
}
