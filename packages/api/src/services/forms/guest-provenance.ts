/**
 * GUEST PROVENANCE (Sites W4) — the one server-side rule that says a proposal
 * was filed by a public form's guest, not by an AI.
 *
 * A guest proposal carries a real `agentUserId` (the form's own actor — that is
 * what gives it a per-form cap, rule and scorecard), so every renderer that
 * keys "AI" on `agentUserId` shows it as AI. That is wrong: nobody's model
 * wrote it, a stranger on the internet did. The discriminator is the ACTOR ROW
 * (`users.agent_type = 'form:<formId>'`, written only by the forms door), never
 * a field in `proposals.data` — the anonymous body cannot reach this.
 *
 * WIRING IS A HANDOFF: the presentation derivation lives in
 * `routers/proposals/display.ts`, which a peer is editing (W4 report,
 * GREENLIGHT BLOCKER). The intended call is `guestProvenanceFor(agentType)` on
 * the resolved author row, emitted as `actorKind: "guest"` + `formId`.
 */

import { FORM_ACTOR_TYPE_PREFIX, isFormActorType } from "./form-definition.js";

export type ProposalActorKind = "human" | "agent" | "guest";

export interface GuestProvenance {
  actorKind: "guest";
  /** The form's `tools.id` — the door the review UI opens. */
  formId: string;
}

/** `{ actorKind: "guest", formId }` for a form actor's agentType, else null. */
export function guestProvenanceFor(
  agentType: string | null | undefined
): GuestProvenance | null {
  if (!isFormActorType(agentType)) return null;
  const formId = (agentType as string).slice(FORM_ACTOR_TYPE_PREFIX.length);
  return formId ? { actorKind: "guest", formId } : null;
}

/** The actor kind a proposal row should render with. */
export function proposalActorKind(input: {
  agentUserId: string | null | undefined;
  agentType: string | null | undefined;
}): ProposalActorKind {
  if (!input.agentUserId) return "human";
  return guestProvenanceFor(input.agentType) ? "guest" : "agent";
}
