/**
 * WHO SPOKE — which actor wrote a chat message. ONE rule for every surface:
 * the desk (`resolveMessageAuthor`, the room adapter, the Pins list) and the
 * phone (`assistantSpeakerName`). The surfaces own their directory (who is in
 * the room, with which colour and avatar); they never re-derive which id names
 * the speaker.
 *
 * What the pod records on a message row (`messages`, `@synap/database`):
 *
 *   userId            — the OWNER the row belongs to. On an agent's message it
 *                       is the person the agent acts for (`persistAssistantReply`,
 *                       `postChannelMessage`), or "system" for a bot notice —
 *                       never the agent. Read for an agent's message, it put
 *                       the owner's name (and a human avatar) on the agent's words.
 *   routedTeammateId  — the agent USER that wrote it: an agent's own post
 *                       (`postChannelMessage`, hub thread writes: `direct`), a
 *                       reply the orchestrator routed or a mention summoned.
 *   metadata.agentId  — the agent DEFINITION (`agents` row) an interactive
 *                       reply ran as (`channels.sendMessage`, Discord turns).
 *
 * Pure and dependency-free.
 */

/** The fields of a message row the rule reads (the pod wire's own names). */
export interface SpokenMessage {
  role?: string | null;
  authorType?: string | null;
  userId?: string | null;
  routedTeammateId?: string | null;
  metadata?: unknown;
}

/** True when an agent or a bot wrote the message, not a person. */
export function isAgentSpokenMessage(message: SpokenMessage): boolean {
  return (
    message.authorType === "ai_agent" ||
    message.authorType === "bot" ||
    message.role === "assistant"
  );
}

/**
 * The ids that may name the speaker, most specific first. An agent's message
 * yields the agent user (`routedTeammateId`), then the agent definition
 * (`metadata.agentId`) — never `userId`, which is its owner. A person's
 * message yields its `userId`.
 */
export function messageSpeakerIds(message: SpokenMessage): string[] {
  if (!isAgentSpokenMessage(message)) {
    return message.userId ? [message.userId] : [];
  }
  const agentId = (message.metadata as { agentId?: unknown } | null | undefined)
    ?.agentId;
  const ids: string[] = [];
  if (message.routedTeammateId) ids.push(message.routedTeammateId);
  if (typeof agentId === "string" && agentId && !ids.includes(agentId)) {
    ids.push(agentId);
  }
  return ids;
}

/**
 * The speaker as the caller's directory knows it: the first id of
 * `messageSpeakerIds` that `lookup` resolves. `undefined` when none does — the
 * caller then shows its unnamed mark (an agent's message stays an agent's:
 * never a guess, never the owner).
 */
export function resolveMessageSpeaker<P>(
  message: SpokenMessage,
  lookup: (id: string) => P | null | undefined
): P | undefined {
  for (const id of messageSpeakerIds(message)) {
    const found = lookup(id);
    if (found != null) return found;
  }
  return undefined;
}
