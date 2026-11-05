/**
 * RUN CHOICE: who runs a playbook for a person, asked once and remembered
 * (plan v2 "Agent templates as a catalog kind", pod document 66d229dc, slice
 * 5a; founder answer Q1: "ask once, save as the playbook's list").
 *
 * The choice is written in the playbook's own executor words, so it adds no
 * second vocabulary for "who runs it": Synap AI is `is-agent` (the pod's own
 * AI, on the Intelligence Service), an agent is `external-agent` + its agent
 * user id. The pod stores it as the person's assignment on the playbook (one
 * per person per playbook) and resolves every run through ONE function
 * (`resolveRunChoice`), which records what it decided on the run (`RunOn`).
 * Surfaces draw these fields with the vocabulary door
 * (`resolveRunChoiceViaLabel`, `SYNAP_AI_LABEL`); none re-derives them.
 */

import type {
  RUN_CHOICE_PROVIDER_KEY_LABELS,
  RUN_CHOICE_VIA_LABELS,
} from "../vocabulary/index.js";
import type { AgentWake, AgentWakeRefusal } from "./wake.js";

/** What a person can choose: Synap AI, or one of their agents. */
export type RunChoice =
  | { executor: "is-agent" }
  | { executor: "external-agent"; agentUserId: string };

/**
 * How a run's runner was decided, first match wins:
 *   named    — chosen for THIS run (the launch's pick, or `handToAgentId`);
 *   stored   — the person's remembered choice for the playbook;
 *   fallback — the remembered agent could not take it now, so Synap AI did;
 *   default  — nothing chosen: the playbook's own executor.
 */
export const RUN_CHOICE_VIAS = [
  "named",
  "stored",
  "fallback",
  "default",
] as const;
export type RunChoiceVia = (typeof RUN_CHOICE_VIAS)[number];

/**
 * What the pod decided for one run, recorded on it (`playbook_runs.run_on`).
 * `agentUserId` is the agent that took it; `null` = Synap AI, or, for a
 * playbook that only runs on agents, the executor's own pick.
 */
export interface RunOn {
  executor: "is-agent" | "external-agent" | "hybrid";
  agentUserId: string | null;
  via: RunChoiceVia;
  /** Only `fallback`: the remembered agent, and why it could not take it. */
  passedOver: {
    agentUserId: string;
    name: string | null;
    why: AgentWakeRefusal | "not_awake" | "refused";
  } | null;
}

/** One answer the person can pick, in the order the pod offers them. */
export interface RunChoiceOption {
  choice: RunChoice;
  /** The agent's name; `null` for Synap AI (the vocabulary says its name). */
  name: string | null;
  /**
   * The words a surface shows for it, drawn by the pod through the vocabulary
   * door (`SYNAP_AI_LABEL`, the agent's name), so an app with no copy of the
   * vocabulary never writes its own.
   */
  label: string;
  /** Its wake mark; `null` for Synap AI (always awake, the pod runs it). */
  wake: AgentWake | null;
  /**
   * The line under it: an agent's mark ("Can't wake · Computer offline"), or
   * how Synap AI runs ("Runs in Synap").
   */
  wakeLabel: string | null;
  /** At most one: Synap AI when the playbook allows it, else none. */
  recommended: boolean;
  /**
   * Only on Synap AI: the AI provider it runs on, ONE global choice per pod
   * (founder, run choice v3, 2026-11-05: the provider replaces the IS default
   * AI, it is never chosen per playbook). `null` for an agent.
   */
  provider: RunChoiceProvider | null;
}

/**
 * Whose key Synap AI runs on: the person's own, their space's, the pod's
 * (`ai_providers`), or none of theirs, so it runs on Synap credits.
 */
export const RUN_CHOICE_PROVIDER_KEYS = [
  "person",
  "space",
  "pod",
  "synap",
] as const;
export type RunChoiceProviderKey = (typeof RUN_CHOICE_PROVIDER_KEYS)[number];

/** The provider Synap AI uses now, read by the IS default's own rule. */
export interface RunChoiceProvider {
  /** `ai_providers.provider_id`; `null` = Synap credits. */
  providerId: string | null;
  /** The provider's name ("Anthropic"), or the Synap credits words. */
  name: string;
  key: RunChoiceProviderKey;
}

/**
 * Agents the person has that cannot run it now, grouped by the one reason
 * (decision D3: an option that cannot apply is absent, and the ask says why).
 */
export interface RunChoiceHidden {
  why: AgentWakeRefusal;
  /** The reason's words (`resolveAgentWakeRefusalLabel`). */
  label: string;
  count: number;
  /** Their labels, as the options would show them. */
  names: string[];
  /** Their agent user ids, in the order of `names`. */
  agentUserIds: string[];
}

/** `playbooks.runChoice` / Hub `GET /playbooks/:id/run-choice`. */
export interface PlaybookRunChoice {
  playbookId: string;
  /** The person's remembered choice; `null` = never chosen. */
  stored: RunChoice | null;
  /**
   * Ask before the run: nothing is stored and something can run it (decision
   * D4, "never a silent default": even with one option, even with no agent).
   * A launch that asks passes its answer with `remember: true`. A headless run
   * (an automation, a schedule) never asks: it takes the playbook's default
   * and records `via: "default"` on the run.
   */
  ask: boolean;
  /** Synap AI may run it (`executor` is `is-agent` or `hybrid`). */
  synapAiAllowed: boolean;
  /** Synap AI (when allowed), then the agents that are awake or can wake. */
  options: RunChoiceOption[];
  /** The person's agents that cannot run it now, largest group first. */
  hidden: RunChoiceHidden[];
  /** "2 more can't run now"; `null` when nothing is hidden. */
  hiddenLabel: string | null;
  /** What the next run would do, by the same rule the run uses. */
  next: RunOn;
}

// Coverage floor: a via without its words fails the build, and so does a word
// for a via this union does not have.
type _ViaWords =
  Exclude<RunChoiceVia, keyof typeof RUN_CHOICE_VIA_LABELS> extends never
    ? Exclude<keyof typeof RUN_CHOICE_VIA_LABELS, RunChoiceVia> extends never
      ? true
      : never
    : never;
const _viaWords: _ViaWords = true;
void _viaWords;

// The same floor for whose key Synap AI runs on.
type _ProviderKeyWords =
  Exclude<
    RunChoiceProviderKey,
    keyof typeof RUN_CHOICE_PROVIDER_KEY_LABELS
  > extends never
    ? Exclude<
        keyof typeof RUN_CHOICE_PROVIDER_KEY_LABELS,
        RunChoiceProviderKey
      > extends never
      ? true
      : never
    : never;
const _providerKeyWords: _ProviderKeyWords = true;
void _providerKeyWords;
