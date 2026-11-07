/**
 * Agent WAKE: can the pod get an agent working now, and if not, why
 * (plan v2 "Agent templates as a catalog kind", pod document 66d229dc, §3).
 *
 * The pod derives it ONCE, in the hand-off roster (`readAgentsForHandoff`,
 * served as `agentUsers.roster`), and every surface draws these fields with
 * the vocabulary door (`resolveAgentWakeStateLabel`, `…HowLabel`,
 * `…RefusalLabel`). No client derives a wake state.
 */

import type { AgentTemplateWake } from "./agent-template.js";
import type {
  AGENT_WAKE_HOW_LABELS,
  AGENT_WAKE_REFUSAL_LABELS,
  AGENT_WAKE_STATE_LABELS,
} from "../vocabulary/index.js";

/**
 * awake     — something answers it now (the pod, a healthy connector, or a
 *             runner that served it within the live window);
 * can_wake  — not running, and the pod can start it (its computer's runner);
 * cant_wake — neither; `why` says the one reason.
 */
export const AGENT_WAKE_STATES = ["awake", "can_wake", "cant_wake"] as const;
export type AgentWakeState = (typeof AGENT_WAKE_STATES)[number];

/** What gets, or would get, it working. */
export const AGENT_WAKE_HOWS = ["built_in", "binding", "runner"] as const;
export type AgentWakeHow = (typeof AGENT_WAKE_HOWS)[number];

/** The one reason a `cant_wake` agent cannot be woken, first match wins. */
export const AGENT_WAKE_REFUSALS = [
  "paused",
  "binding_broken",
  "no_template",
  "no_template_wake",
  "no_computer",
  "no_waker",
  "computer_offline",
  "wakes_off",
] as const;
export type AgentWakeRefusal = (typeof AGENT_WAKE_REFUSALS)[number];

export interface AgentWake {
  state: AgentWakeState;
  /** What gets it working; `null` when nothing could (no template wake). */
  how: AgentWakeHow | null;
  /** Only when `cant_wake`. */
  why: AgentWakeRefusal | null;
}

/**
 * The agent template an agent is an instance of. `version` is the catalog
 * version the pod installed it at; `null` = built in (not installed from the
 * catalog).
 */
export interface AgentTemplateRef {
  slug: string;
  label: string;
  version: string | null;
  /**
   * How a computer starts it on handed work, as the INSTALLED template holds
   * it (`agent_templates.wake`): the pod is the one source a runner reads.
   * `null` = the installed template carries none, or the template is built in
   * (the pod holds no wake block for it).
   */
  wake: AgentTemplateWake | null;
}

// Coverage floors: a state, path or reason without its words fails the build,
// and so does a word for a value these unions do not have.
type Covers<U extends string, L> =
  Exclude<U, keyof L> extends never
    ? Exclude<keyof L, U> extends never
      ? true
      : never
    : never;
const _stateWords: Covers<AgentWakeState, typeof AGENT_WAKE_STATE_LABELS> =
  true;
const _howWords: Covers<AgentWakeHow, typeof AGENT_WAKE_HOW_LABELS> = true;
const _refusalWords: Covers<
  AgentWakeRefusal,
  typeof AGENT_WAKE_REFUSAL_LABELS
> = true;
void _stateWords;
void _howWords;
void _refusalWords;
