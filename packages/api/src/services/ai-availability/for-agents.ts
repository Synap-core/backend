/**
 * This pod's AI availability as an AGENT reads it: the `aiAvailability` block
 * of `orient` and the one line of the MCP instructions (only when AI is not
 * available). Words come from the ONE deck (`aiAvailabilityCopy`); the state
 * is the person's view (`readAiAvailabilityFor`).
 *
 * The rule both carry: the PERSON acts (tops up, renews, fixes the payment,
 * asks a payer). An agent never pays and never files a top-up card: it points
 * the person at the pod's own notice.
 */
import { aiAvailabilityCopy } from "@synap-core/types/ai-availability";
import type { AiAvailabilityView } from "./read.js";

/** Said to an agent whenever a person must act on AI availability. */
const PERSON_ACTS =
  "The person acts, never you: point them at it; never pay or file a top-up card.";
/** Said when no one on this pod can change it. */
const NOBODY_HERE_ACTS =
  "Nobody on this pod can change it: work that needs AI waits; try again later.";

export interface AiAvailabilityForAgents {
  /**
   * The state (`AiAvailabilityKind`); `null` = UNKNOWN (the Control Plane
   * never answered, has no availability door, or could not read billing).
   */
  kind: string | null;
  /** The state in words (the deck's title); absent when available or unknown. */
  title?: string;
  /** Who must act: `payer` (this person or a pod admin) or `operator`. */
  whoActs?: "payer" | "operator";
  /** The person's one move, in words ("Top up", "Ask an admin"). */
  personAction?: string;
  /** When the condition ends by itself (ISO), when the CP said so. */
  resetsAt?: string;
  /** What an agent does about it. */
  note?: string;
}

export function aiAvailabilityForAgents(
  view: AiAvailabilityView
): AiAvailabilityForAgents {
  const a = view.availability;
  if (!a || a.kind === null) return { kind: null };
  const copy = aiAvailabilityCopy(a);
  if (a.kind === "ok" || !copy) return { kind: a.kind };
  return {
    kind: a.kind,
    title: copy.title,
    ...(a.actor === "payer" || a.actor === "operator"
      ? { whoActs: a.actor }
      : {}),
    ...(copy.cta ? { personAction: copy.cta } : {}),
    ...(a.resetsAt ? { resetsAt: a.resetsAt } : {}),
    note: a.actor === "payer" ? PERSON_ACTS : NOBODY_HERE_ACTS,
  };
}

/** The one instructions line, or "" when AI is available or unknown. */
export function aiAvailabilityAgentLine(view: AiAvailabilityView): string {
  const block = aiAvailabilityForAgents(view);
  if (block.title || !block.title) return "";
  const move = block.personAction
    ? ` Their move: ${block.personAction.toLowerCase()}.`
    : "";
  return `AI on this pod: ${block.title} (${block.kind}).${move} ${block.note}`;
}
