/**
 * Does a slot's ask end with its session, and which ask does a slot resolve
 * through? The zod-free leaf of the ask rules.
 *
 * `./index.ts` builds the ask schemas with zod, and `./card.ts` reads it at
 * runtime. The needs-you rule (`../needs-you/rule.ts`) needs only
 * `askEndsWithSession`, and it sits in the graph of the `connections` leaf
 * that relay loads under Hermes, where a bare module such as `zod` must never
 * be reached. So these rules live here and import types only;
 * `./index.ts` and `./card.ts` re-export them, so no caller changes.
 * Guard: `../relay-leaves.bare-free.test.ts`.
 */

import type { Ask } from "./index.js";
import type { AskCardSlot } from "./card.js";
import { PARAM_SLOT_KIND } from "../focus-sessions/param-slot.js";
import { CRITERION_SLOT_KIND } from "../focus-sessions/criterion-slot.js";

/** The slot fields the decision-ask rule reads — structural, off `ExpectedOutput`. */
export interface DecisionAskSlotLite<A = Ask> {
  kind?: string | null;
  label: string;
  owner?: string | null;
  blockedReason?: string | null;
  why?: string | null;
  ask?: A | null;
}

/**
 * A DECISION is a choice, never a bare "done". A person-owed slot blocked on
 * `decision` with no ask would resolve `legacy` and offer a one-tap "I did
 * this", which closed a decision with nobody deciding anything. Such a slot
 * gets a `confirm` (Yes / No) instead, with NO prompt: the slot already says
 * what is asked (its label) and why (its `why`), and a prompt copied from
 * either is the same words drawn twice on the card (founder, 2026-10-26).
 *
 * A param slot (`PARAM_SLOT_KIND`) is exempt: its only ask-less form is a
 * credential-named param whose value is set on the run, and a yes/no there
 * would write a boolean into that param.
 *
 * `null` when the slot is not such a slot (or already carries an ask).
 */
export function deriveDecisionAsk(
  slot: DecisionAskSlotLite<unknown>
): Ask | null {
  if (slot.ask) return null;
  if (slot.owner !== "human" || slot.blockedReason !== "decision") return null;
  if (slot.kind === PARAM_SLOT_KIND) return null;
  return { mode: "confirm" };
}

/**
 * The ask a slot resolves through: its own, else the derived decision confirm
 * ({@link deriveDecisionAsk}). The ONE reading for every door and read that
 * hands a slot's ask to a person, so a decision slot stored before the rule
 * (no ask) answers Yes / No everywhere and is never attested bare.
 */
export function effectiveSlotAsk<A>(
  slot: DecisionAskSlotLite<A>
): A | Ask | null {
  return slot.ask ?? deriveDecisionAsk(slot);
}

/** The ask modes that end with their session (the `session_ended` rule). */
export const ASK_MODES_ENDING_WITH_SESSION = ["confirm", "choose"] as const;

/**
 * Does this slot's ask end with its session? Read through `effectiveSlotAsk`.
 * A CRITERION grade never does, though its ask is a `choose`: it is the
 * person's verdict on the agent's work, graded on the session's scorecard
 * after the session as before it — not the agent's need to go on. Nor does
 * an ask the closing agent kept owed past the session (`keptOwedAt`).
 */
export function askEndsWithSession(slot: AskCardSlot): boolean {
  if (slot.kind === CRITERION_SLOT_KIND || slot.criterionKey) return false;
  if (slot.keptOwedAt) return false;
  const mode = (effectiveSlotAsk(slot) as Ask | null)?.mode;
  return (ASK_MODES_ENDING_WITH_SESSION as readonly string[]).includes(
    mode ?? ""
  );
}
