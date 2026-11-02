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
 *
 * Its sibling, {@link resolveAgentLaunch}, is the door to a NEW conversation:
 * the command a person runs on the agent's computer to open it.
 */

import { AGENT_HARNESSES } from "./harnesses.js";
import { parseReportedModel } from "./model-providers.js";

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

/** Harnesses a person can start with a command (the registry's `launch`). */
export type AgentLaunchHarness = Extract<
  (typeof AGENT_HARNESSES)[number],
  { launch: unknown }
>["slug"];

export interface AgentLaunchRef {
  harness: AgentLaunchHarness;
  /**
   * The shell command that opens a new conversation, on the agent's computer.
   * Rendered by the pod from the registry's template and validated values
   * only, so it is safe to show and copy as-is.
   */
  command: string;
}

/** A value the shell takes as one plain word; anything else is quoted. */
const PLAIN_WORD = /^[A-Za-z0-9._:/@=-]+$/;

function shellWord(value: string): string {
  return PLAIN_WORD.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The command that opens an agent, or null when its harness has no launch
 * template, or when the model asked for is not a model id: a door that would
 * start ANOTHER model is worse than none. `model` is a default (a preset's),
 * never a fact about a run.
 */
export function resolveAgentLaunch(input: {
  agentType: string | null | undefined;
  model?: string | null;
}): AgentLaunchRef | null {
  const harness = AGENT_HARNESSES.find(
    (h) => h.slug === input.agentType && "launch" in h
  );
  if (!harness || !("launch" in harness)) return null;
  const words: string[] = [harness.launch.program];
  if (input.model != null && input.model !== "") {
    const model = parseReportedModel(input.model);
    if (!model || !harness.launch.modelFlag) return null;
    words.push(harness.launch.modelFlag, shellWord(model));
  }
  return {
    harness: harness.slug as AgentLaunchHarness,
    command: words.join(" "),
  };
}
