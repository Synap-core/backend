/**
 * "Who runs it": the read a launch asks before a playbook runs (slice 5a,
 * plan v2 66d229dc; founder Q1: ask once, then remember).
 *
 * Every fact here comes from a door that already owns it:
 *   - the remembered choice   `readStoredRunChoice` (the assignment edge);
 *   - the agents to offer     `readAgentsForHandoff` (the roster, with each
 *                             agent's wake mark and whether a hand-off naming
 *                             it would be admitted);
 *   - what the next run does  `resolveRunChoice`, the SAME rule the run uses;
 *   - what Synap AI runs on   `readActiveAiProvider` (the IS default's rule,
 *                             one global choice, never per playbook).
 * Only agents that are awake or can wake are offered; the others are listed
 * in `hidden`, grouped by why (decision D3). The ask happens whenever nothing
 * is stored (decision D4). Surfaces draw the result; none re-derives it.
 */

import type {
  AgentWake,
  AgentWakeRefusal,
  PlaybookRunChoice,
  RunChoiceHidden,
  RunChoiceOption,
} from "@synap-core/types/agents";
import {
  resolveAgentReachLabel,
  resolveRunChoiceHiddenLabel,
  resolveSynapAiProviderLabel,
  resolveAgentWakeHowLabel,
  resolveAgentWakeRefusalLabel,
  resolveAgentWakeStateLabel,
} from "@synap-core/types/vocabulary";
import type { Playbook } from "@synap/database/schema";
import { readStoredRunChoice } from "../agent-dispatch/agent-assignment.js";
import { readAgentsForHandoff } from "../agent-dispatch/agents-for-handoff.js";
import { readActiveAiProvider } from "./active-provider.js";
import { resolveRunChoice } from "./run-playbook.js";

/** A wake mark's words: its state, and the reason when it cannot wake. */
function wakeWords(wake: AgentWake): string {
  const state = resolveAgentWakeStateLabel(wake.state);
  return wake.why
    ? `${state} · ${resolveAgentWakeRefusalLabel(wake.why)}`
    : state;
}

/** What names one agent among the person's, as the roster serves it. */
export interface AgentLabelInput {
  agentUserId: string;
  name: string | null;
  /** Its computer's name (`HandoffAgent.computer.name`); null = none. */
  computer: string | null;
  reach: string;
}

/**
 * Each agent's label in the ask, telling apart agents that share a name (two
 * "Claude Code", one per computer: founder's pod, 2026-11-05, finding
 * 2288ffce). A name nobody else has stays as it is. Shared names carry what
 * tells them apart, in order: the computer ("Claude Code · MacBook"); with no
 * computer, how the pod reaches it (the reach words, e.g. "Synap sends it
 * work" for a connector) or "No computer"; agents still alike get an ordinal
 * ("(2)"), in roster order. Pure; words through the vocabulary door.
 */
export function distinctAgentLabels(
  agents: readonly AgentLabelInput[]
): Map<string, string> {
  const base = (a: AgentLabelInput) => a.name?.trim() || "Agent";
  const count = new Map<string, number>();
  for (const a of agents) count.set(base(a), (count.get(base(a)) ?? 0) + 1);
  const firstPass = agents.map((a) => {
    const name = base(a);
    if ((count.get(name) ?? 0) < 2) return { id: a.agentUserId, label: name };
    const where = a.computer?.trim()
      ? a.computer.trim()
      : a.reach === "dispatch"
        ? resolveAgentReachLabel("dispatch")
        : resolveAgentWakeRefusalLabel("no_computer");
    return { id: a.agentUserId, label: `${name} · ${where}` };
  });
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const f of firstPass) total.set(f.label, (total.get(f.label) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const f of firstPass) {
    if ((total.get(f.label) ?? 0) < 2) {
      out.set(f.id, f.label);
      continue;
    }
    const n = (seen.get(f.label) ?? 0) + 1;
    seen.set(f.label, n);
    out.set(f.id, n === 1 ? f.label : `${f.label} (${n})`);
  }
  return out;
}

export async function readPlaybookRunChoice(p: {
  userId: string;
  playbook: Pick<Playbook, "id" | "executor" | "workspaceId">;
}): Promise<PlaybookRunChoice> {
  const synapAiAllowed = p.playbook.executor !== "external-agent";
  const [stored, roster, decided, provider] = await Promise.all([
    readStoredRunChoice({ ownerId: p.userId, playbookId: p.playbook.id }),
    readAgentsForHandoff(p.userId),
    resolveRunChoice({ userId: p.userId, playbook: p.playbook }),
    synapAiAllowed
      ? readActiveAiProvider({
          userId: p.userId,
          workspaceId: p.playbook.workspaceId ?? null,
        })
      : Promise.resolve(null),
  ]);
  // The person's own agents a hand-off could reach: the pod's own agents are
  // Synap AI, offered once as such, never one row per persona. An agent that
  // is not theirs to send work to (not owned, not in the room, the wrong
  // reach) is no option at all; one that is theirs but paused or unable to
  // wake is hidden, with its reason.
  const theirs = roster.agents.filter(
    (a) => a.reach !== "pod" && (a.canTakeYourWork || a.whyNot === "paused")
  );
  const canRun = (a: (typeof theirs)[number]) =>
    a.canTakeYourWork && a.wake.state !== "cant_wake";
  const offered = theirs.filter(canRun);
  const labels = distinctAgentLabels(
    theirs.map((a) => ({
      agentUserId: a.agentUserId,
      name: a.name,
      computer: a.computer?.name ?? null,
      reach: a.reach,
    }))
  );
  const agentOptions: RunChoiceOption[] = offered.map((a) => ({
    choice: { executor: "external-agent", agentUserId: a.agentUserId },
    name: a.name,
    label: labels.get(a.agentUserId) ?? (a.name?.trim() || "Agent"),
    wake: a.wake,
    wakeLabel: wakeWords(a.wake),
    recommended: false,
    provider: null,
  }));
  const hidden = groupHidden(
    theirs
      .filter((a) => !canRun(a))
      .map((a) => ({
        why: a.wake.why ?? "paused",
        name: labels.get(a.agentUserId) ?? (a.name?.trim() || "Agent"),
      }))
  );
  const options: RunChoiceOption[] = provider
    ? [
        {
          choice: { executor: "is-agent" },
          name: null,
          label: resolveSynapAiProviderLabel(provider),
          wake: null,
          // Its line beside the agents' marks: the pod runs it itself.
          wakeLabel: resolveAgentWakeHowLabel("built_in"),
          recommended: true,
          provider,
        },
        ...agentOptions,
      ]
    : agentOptions;
  // An agent assigned before choices were remembered per person (an edge with
  // no owner) is still the one the route hands runs to: it reads as stored.
  const remembered =
    stored ??
    (decided.runOn.via === "stored" && decided.runOn.agentUserId
      ? {
          executor: "external-agent" as const,
          agentUserId: decided.runOn.agentUserId,
        }
      : decided.runOn.via === "fallback" && decided.runOn.passedOver
        ? {
            executor: "external-agent" as const,
            agentUserId: decided.runOn.passedOver.agentUserId,
          }
        : null);
  return {
    playbookId: p.playbook.id,
    stored: remembered,
    // Never a silent default (D4): with nothing stored, a launch asks, even
    // when Synap AI is the only way it can run.
    ask: remembered === null && options.length > 0,
    synapAiAllowed,
    options,
    hidden,
    hiddenLabel: resolveRunChoiceHiddenLabel(
      hidden.reduce((n, h) => n + h.count, 0)
    ),
    next: decided.runOn,
  };
}

/** Hidden agents by reason, largest group first, then roster order. */
function groupHidden(
  agents: readonly { why: AgentWakeRefusal; name: string }[]
): RunChoiceHidden[] {
  const groups = new Map<AgentWakeRefusal, string[]>();
  for (const a of agents) {
    const names = groups.get(a.why) ?? [];
    names.push(a.name);
    groups.set(a.why, names);
  }
  return [...groups.entries()]
    .map(([why, names]) => ({
      why,
      label: resolveAgentWakeRefusalLabel(why),
      count: names.length,
      names,
    }))
    .sort((a, b) => b.count - a.count);
}
