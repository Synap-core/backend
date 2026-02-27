/**
 * Agent handle resolution
 *
 * Maps short @mention handles (e.g. "@cto", "@ai") to intelligence hub
 * agent type strings (e.g. "persona:cto", "meta").
 *
 * Used by sendMessage to resolve @mentions in user messages before forwarding
 * to the intelligence hub — no DB storage, purely for the per-call agentType override.
 */

export const AGENT_HANDLE_MAP: Record<string, string> = {
  // Default / catch-all
  ai: "meta",
  synap: "meta",
  // Personas
  cto: "persona:cto",
  sales: "persona:sales",
  marketing: "persona:marketing",
  pm: "persona:project-manager",
  // Specialists
  research: "knowledge-search",
  code: "code",
  writing: "writing",
};

/**
 * Resolve a @mention handle to an agentType string.
 * Returns null if the handle is not recognised.
 */
export function resolveAgentHandle(handle: string): string | null {
  return AGENT_HANDLE_MAP[handle.toLowerCase()] ?? null;
}

/**
 * Parse the first @handle from plain-text message content and resolve it.
 * Returns the agentType string, or null if no recognised @mention found.
 */
export function extractMentionAgentType(content: string): string | null {
  const match = content.match(/@([\w-]+)/);
  if (!match) return null;
  return resolveAgentHandle(match[1]);
}
