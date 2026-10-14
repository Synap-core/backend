/**
 * "Who should answer?" — the room's question when several house agents could
 * answer a message and nobody was mentioned (founder decision 2026-10-14:
 * silence + a one-tap chip, never an AI picker).
 *
 * The pod posts ONE system message carrying this under
 * `messages.metadata[ROUTE_CHOICE_META_KEY]`; every surface draws its
 * candidates as chips. Tapping one calls `channels.answerRouteChoice`, which
 * starts that agent's turn on the ORIGINAL message.
 */

export const ROUTE_CHOICE_META_KEY = "routeChoice";

export interface RouteChoiceCandidate {
  agentUserId: string;
  /** The agent's display name, for the chip. */
  name: string;
}

export interface RouteChoiceMeta {
  /** The message the chosen agent will answer. */
  triggerMessageId: string;
  candidates: RouteChoiceCandidate[];
}

/**
 * Read the choice off a message's metadata. Anything malformed reads as
 * `null` (no chip) — a half-written choice must never render dead chips.
 */
export function readRouteChoice(metadata: unknown): RouteChoiceMeta | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[ROUTE_CHOICE_META_KEY];
  if (!raw || typeof raw !== "object") return null;
  const { triggerMessageId, candidates } = raw as Record<string, unknown>;
  if (typeof triggerMessageId !== "string" || !triggerMessageId) return null;
  if (!Array.isArray(candidates)) return null;
  const parsed: RouteChoiceCandidate[] = [];
  for (const c of candidates) {
    if (!c || typeof c !== "object") return null;
    const { agentUserId, name } = c as Record<string, unknown>;
    if (typeof agentUserId !== "string" || !agentUserId) return null;
    parsed.push({
      agentUserId,
      name: typeof name === "string" && name.trim() ? name : "Agent",
    });
  }
  return parsed.length >= 2 ? { triggerMessageId, candidates: parsed } : null;
}
