/**
 * WHO IS ASKING for a proposal, in one line — the ONE derivation every Pod
 * Console surface reads (Review's row, detail and history, the review page's
 * "Requested by").
 *
 * The pod resolves the roles separately (`routers/proposals/display.ts`):
 * `agentActorName` is the agent that filed it, `principal` whether a person's
 * identity is behind that agent, `appName` an Application whose key filed it,
 * `actorKind: "guest"` a stranger through a public form. `authorName` is the
 * LEGACY COALESCE (`agentUserId ?? createdBy ?? sourceId`) — it cannot say
 * which role its name plays, so it is read only for a person's own proposal
 * and as the person an app acts for.
 *
 * A MIRROR of the browser's `delegationSentence` (`apps/processors/
 * delegation.ts`) and relay's `attributionRows` (`features/decide/
 * attribution.ts`), which name the same roles the same way; those repos share
 * no code with this app.
 */

import { resolveProvenanceLabel } from "@synap-core/types/vocabulary";

/** Mirrors the pod's `ProposalPrincipal`. Read structurally. */
export type ProposalPrincipalView =
  | { kind: "unresolved" }
  | { kind: "global" }
  | { kind: "delegated"; name?: string };

export interface ProposalRequesterFacts {
  appName?: string | null;
  agentActorName?: string | null;
  principal?: ProposalPrincipalView | null;
  actorKind?: string | null;
  authorName?: string | null;
}

/** Who filed it, by role. */
export type ProposalActorRole = "agent" | "app" | "guest" | "person";

/**
 * The same answer as {@link proposalRequester}, kept in its parts so a surface
 * can draw each role as its own mark (the agent's glyph, the person's avatar)
 * instead of one sentence.
 */
export interface ProposalRequesterParts {
  actor: { role: ProposalActorRole; name: string } | null;
  /**
   * The person the actor acts for: `name` when the pod resolved one, and
   * `text` as the line reads it ("for Antoine", "owner unknown").
   */
  forWhom: { name: string | null; text: string } | null;
}

/** "for Antoine" — or "owner unknown"; nothing for an agent acting as itself. */
function principalFor(
  principal: ProposalPrincipalView | null | undefined
): ProposalRequesterParts["forWhom"] {
  if (!principal) return null;
  if (principal.kind === "unresolved")
    return { name: null, text: "owner unknown" };
  if (principal.kind === "global") return null;
  return principal.name
    ? { name: principal.name, text: `for ${principal.name}` }
    : { name: null, text: "for another user" };
}

export function proposalRequesterParts(
  p: ProposalRequesterFacts
): ProposalRequesterParts {
  if (p.appName) {
    return {
      actor: { role: "app", name: p.appName },
      forWhom: p.authorName
        ? { name: p.authorName, text: `for ${p.authorName}` }
        : null,
    };
  }
  if (p.agentActorName) {
    if (p.actorKind === "guest") {
      return {
        actor: { role: "guest", name: p.agentActorName },
        forWhom: null,
      };
    }
    return {
      actor: { role: "agent", name: p.agentActorName },
      forWhom: principalFor(p.principal),
    };
  }
  return {
    actor: p.authorName ? { role: "person", name: p.authorName } : null,
    forWhom: null,
  };
}

/**
 * "Claude Code on devbox, for Antoine" · "Acme, for Antoine" · "Guest, through
 * Form: Contact" · "Antoine". Null when the pod resolved no name — never an id,
 * never a guess.
 */
export function proposalRequester(p: ProposalRequesterFacts): string | null {
  const { actor, forWhom } = proposalRequesterParts(p);
  if (!actor) return null;
  if (actor.role === "guest") {
    return `${resolveProvenanceLabel("guest")}, through ${actor.name}`;
  }
  return forWhom ? `${actor.name}, ${forWhom.text}` : actor.name;
}
