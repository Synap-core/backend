/**
 * "Who runs it": the read a launch asks before a playbook runs (slice 5a,
 * plan v2 66d229dc; founder Q1: ask once, then remember).
 *
 * Every fact here comes from a door that already owns it:
 *   - the remembered choice   `readStoredRunChoice` (the assignment edge);
 *   - the agents to offer     `readAgentsForHandoff` (the roster, with each
 *                             agent's wake mark and whether a hand-off naming
 *                             it would be admitted);
 *   - what the next run does  `resolveRunChoice`, the SAME rule the run uses.
 * Surfaces draw the result; none re-derives it.
 */

import type {
  AgentWake,
  PlaybookRunChoice,
  RunChoiceOption,
} from "@synap-core/types/agents";
import {
  SYNAP_AI_LABEL,
  resolveAgentWakeRefusalLabel,
  resolveAgentWakeStateLabel,
} from "@synap-core/types/vocabulary";
import type { Playbook } from "@synap/database/schema";
import { readStoredRunChoice } from "../agent-dispatch/agent-assignment.js";
import { readAgentsForHandoff } from "../agent-dispatch/agents-for-handoff.js";
import { resolveRunChoice } from "./run-playbook.js";

/** A wake mark's words: its state, and the reason when it cannot wake. */
function wakeWords(wake: AgentWake): string {
  const state = resolveAgentWakeStateLabel(wake.state);
  return wake.why
    ? `${state} · ${resolveAgentWakeRefusalLabel(wake.why)}`
    : state;
}

export async function readPlaybookRunChoice(p: {
  userId: string;
  playbook: Pick<Playbook, "id" | "executor">;
}): Promise<PlaybookRunChoice> {
  const synapAiAllowed = p.playbook.executor !== "external-agent";
  const [stored, roster, decided] = await Promise.all([
    readStoredRunChoice({ ownerId: p.userId, playbookId: p.playbook.id }),
    readAgentsForHandoff(p.userId),
    resolveRunChoice({ userId: p.userId, playbook: p.playbook }),
  ]);
  // The person's own agents a hand-off could reach: the pod's own agents are
  // Synap AI, offered once as such, never one row per persona.
  const agentOptions: RunChoiceOption[] = roster.agents
    .filter((a) => a.reach !== "pod" && a.canTakeYourWork)
    .map((a) => ({
      choice: { executor: "external-agent", agentUserId: a.agentUserId },
      name: a.name,
      label: a.name?.trim() || "Agent",
      wake: a.wake,
      wakeLabel: wakeWords(a.wake),
      recommended: false,
    }));
  const options: RunChoiceOption[] = synapAiAllowed
    ? [
        {
          choice: { executor: "is-agent" },
          name: null,
          label: SYNAP_AI_LABEL,
          wake: null,
          wakeLabel: null,
          recommended: true,
        },
        ...agentOptions,
      ]
    : agentOptions;
  return {
    playbookId: p.playbook.id,
    stored,
    // A real choice only: something to pick besides the one way it can run.
    ask: stored === null && agentOptions.length > 0 && options.length > 1,
    synapAiAllowed,
    options,
    next: decided.runOn,
  };
}
