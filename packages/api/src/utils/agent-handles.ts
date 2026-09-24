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
 * Every distinct `@handle` in the content, lower-cased, in the order written.
 * A multi-actor room reads ALL of them — "@bob can you and @ai look at this"
 * summons the AI even though the FIRST handle names a person, which
 * `extractMentionAgentType` (first handle only) cannot see.
 */
export function extractMentionHandles(content: string): string[] {
  const matches = content.match(/@([\w-]+)/g);
  if (!matches) return [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const handle = raw.replace(/^@/, "").trim().toLowerCase();
    if (handle) seen.add(handle);
  }
  return [...seen];
}

/**
 * Route a room message's mentions against the room's AI roster: the FIRST
 * handle (in writing order) naming an AI member wins. A handle names a member
 * when it IS the member's `agentType` or maps to it through `AGENT_HANDLE_MAP`
 * (`@ai` → the `orchestrator` agent user). A handle naming no member — a
 * person, a typo, an agent NOT on this room's roster — routes nowhere: the
 * caller stays silent, it never falls through to a default responder.
 */
export function resolveMentionedMember<M extends { agentType: string | null }>(
  handles: readonly string[],
  members: readonly M[]
): M | null {
  for (const raw of handles) {
    const handle = raw.replace(/^@/, "").trim().toLowerCase();
    if (!handle) continue;
    const wanted = new Set([handle, AGENT_HANDLE_MAP[handle]].filter(Boolean));
    const hit = members.find(
      (m) => !!m.agentType && wanted.has(m.agentType.toLowerCase())
    );
    if (hit) return hit;
  }
  return null;
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
