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

/** "for Antoine" — or "owner unknown"; nothing for an agent acting as itself. */
function principalClause(
  principal: ProposalPrincipalView | null | undefined
): string | null {
  if (!principal) return null;
  if (principal.kind === "unresolved") return "owner unknown";
  if (principal.kind === "global") return null;
  return principal.name ? `for ${principal.name}` : "for another user";
}

/**
 * "Claude Code on devbox, for Antoine" · "Acme, for Antoine" · "Guest, through
 * Form: Contact" · "Antoine". Null when the pod resolved no name — never an id,
 * never a guess.
 */
export function proposalRequester(p: ProposalRequesterFacts): string | null {
  if (p.appName) {
    return p.authorName ? `${p.appName}, for ${p.authorName}` : p.appName;
  }
  if (p.agentActorName) {
    if (p.actorKind === "guest") {
      return `${resolveProvenanceLabel("guest")}, through ${p.agentActorName}`;
    }
    const clause = principalClause(p.principal);
    return clause ? `${p.agentActorName}, ${clause}` : p.agentActorName;
  }
  return p.authorName ?? null;
}
