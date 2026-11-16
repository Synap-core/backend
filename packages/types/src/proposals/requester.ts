/**
 * WHO IS ASKING for a proposal, in one line: the ONE derivation every surface
 * reads (pod admin's Review row, detail and history; the browser's
 * `delegationSentence` and relay's `attributionRows` name the same roles and
 * move here next, plan d717d6ac §6 D1). Moved from pod admin
 * `app/proposal/[id]/proposal-requester.ts`, which re-exports it.
 *
 * The pod resolves the roles separately (`routers/proposals/display.ts`):
 * `agentActorName` is the agent that filed it, `principal` whether a person's
 * identity is behind that agent, `appName` an Application whose key filed it,
 * `actorKind: "guest"` a stranger through a public form. `authorName` is the
 * LEGACY COALESCE (`agentUserId ?? createdBy ?? sourceId`): it cannot say
 * which role its name plays, so it is read only for a person's own proposal
 * and as the person an app acts for.
 *
 * Pure. Names are content (printed as resolved); the words around them are
 * this folder's catalog (`./copy.ts`).
 */

import type { Locale } from "../i18n/index.js";
import { resolveProvenanceLabel } from "../vocabulary/index.js";
import { proposalsT } from "./copy.js";

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
  forWhom: {
    name: string | null;
    text: string;
    /** Which of the three it is, so the one line picks its own sentence. */
    kind: "named" | "unknown" | "another";
  } | null;
}

/** "for Antoine", or "owner unknown"; nothing for an agent acting as itself. */
function principalFor(
  principal: ProposalPrincipalView | null | undefined,
  locale: Locale | undefined
): ProposalRequesterParts["forWhom"] {
  if (!principal) return null;
  const t = proposalsT(locale);
  if (principal.kind === "unresolved") {
    return {
      name: null,
      text: t("proposals.requester.ownerUnknown"),
      kind: "unknown",
    };
  }
  if (principal.kind === "global") return null;
  return principal.name
    ? {
        name: principal.name,
        text: t("proposals.requester.for", { name: principal.name }),
        kind: "named",
      }
    : {
        name: null,
        text: t("proposals.requester.forAnother"),
        kind: "another",
      };
}

export function proposalRequesterParts(
  p: ProposalRequesterFacts,
  opts: { locale?: Locale } = {}
): ProposalRequesterParts {
  const t = proposalsT(opts.locale);
  if (p.appName) {
    return {
      actor: { role: "app", name: p.appName },
      forWhom: p.authorName
        ? {
            name: p.authorName,
            text: t("proposals.requester.for", { name: p.authorName }),
            kind: "named",
          }
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
      forWhom: principalFor(p.principal, opts.locale),
    };
  }
  return {
    actor: p.authorName ? { role: "person", name: p.authorName } : null,
    forWhom: null,
  };
}

/**
 * "Claude Code on devbox, for Antoine" · "Acme, for Antoine" · "Guest, through
 * Form: Contact" · "Antoine". Null when the pod resolved no name: never an id,
 * never a guess.
 */
export function proposalRequester(
  p: ProposalRequesterFacts,
  opts: { locale?: Locale } = {}
): string | null {
  const { actor, forWhom } = proposalRequesterParts(p, opts);
  if (!actor) return null;
  const t = proposalsT(opts.locale);
  if (actor.role === "guest") {
    return t("proposals.requester.guestThrough", {
      guest: resolveProvenanceLabel("guest"),
      form: actor.name,
    });
  }
  if (!forWhom) return actor.name;
  if (forWhom.kind === "unknown") {
    return t("proposals.requester.actorOwnerUnknown", { actor: actor.name });
  }
  if (forWhom.kind === "another") {
    return t("proposals.requester.actorForAnother", { actor: actor.name });
  }
  return t("proposals.requester.actorFor", {
    actor: actor.name,
    name: forWhom.name ?? "",
  });
}

/** The plan's name for it (d717d6ac §6): who is asking, as one sentence. */
export const requesterSentence = proposalRequester;
