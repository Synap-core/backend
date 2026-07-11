import { db, eq } from "@synap/database";
import { agents } from "@synap/database/schema";

/**
 * Maps @mention handles to the agent slugs used in the database lookup.
 * Updated from the previous hardcoded agentType values to agent slugs.
 * Kept for reference and backward compat with UI / docs.
 *
 * Orchestrator is the fallback for legacy "ai" and "synap" mentions.
 */
export const AGENT_HANDLE_MAP: Record<string, string> = {
  ai: "orchestrator",
  synap: "orchestrator",
  cto: "persona:cto",
  sales: "persona:sales",
  marketing: "persona:marketing",
  pm: "persona:project-manager",
  research: "knowledge-search",
  code: "code",
  writing: "writing",
};

/**
 * Resolve a @mention handle to the owning agent via the `agents` table.
 * Strips leading `@`, looks up the slug via `AGENT_HANDLE_MAP`, then
 * queries `agents` by slug.
 *
 * Orchestrator ("ai" / "synap") is a system-level agent with no
 * intelligenceServiceId — always available.
 */
export async function resolveAgentHandle(handle: string): Promise<{
  agentId: string;
  agentName: string;
  agentSlug: string;
} | null> {
  const raw = handle.replace(/^@/, "").trim().toLowerCase();
  const slug = AGENT_HANDLE_MAP[raw];
  if (!slug) return null;

  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.slug, slug))
    .limit(1);
  if (!agent) return null;

  return {
    agentId: agent.id,
    agentName: agent.name,
    agentSlug: agent.slug,
  };
}

/**
 * Parse the first @handle from plain-text message content.
 * Returns the raw handle string for backward compat; callers
 * should pass the result to `resolveAgentHandle()` for the full
 * agent record.
 */
export function extractMentionAgentType(content: string): string | null {
  const match = content.match(/@([\w-]+)/);
  if (!match) return null;
  return match[1];
}

/**
 * Extract HUMAN @mention handles from message content — the mentions that should
 * NOTIFY people, as opposed to the agent handles (`AGENT_HANDLE_MAP`) that ROUTE
 * to an AI. Returns every distinct `@handle` in the content that is NOT a known
 * agent handle, lower-cased and de-duplicated. Callers resolve these against the
 * channel's human participants to decide who to notify.
 */
export function extractHumanMentionHandles(content: string): string[] {
  const matches = content.match(/@([\w-]+)/g);
  if (!matches) return [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const handle = raw.replace(/^@/, "").trim().toLowerCase();
    // Skip agent handles — those route to AI, they don't notify a person.
    if (!handle || AGENT_HANDLE_MAP[handle]) continue;
    seen.add(handle);
  }
  return [...seen];
}
