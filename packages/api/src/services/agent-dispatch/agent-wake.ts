/**
 * Agent wake: THE rule for "can the pod get this agent working now, and if
 * not, why" (plan v2, pod document 66d229dc, §3), and the one seam that names
 * an agent's template.
 *
 * Read ONLY by the hand-off roster (`readAgentsForHandoff`, `agentUsers.roster`),
 * which already holds every input: reach + binding health, paused, the
 * runner's served stamp (`nobodyRuns`), the computer. Surfaces draw the
 * result; none re-derives it.
 */

import { resolveHarness } from "@synap-core/types/agents";
import type { InstalledAgentTemplate } from "../agent-templates/installed.js";
import type {
  AgentHarnessSlug,
  AgentReach,
  AgentTemplateRef,
  AgentWake,
} from "@synap-core/types/agents";

/**
 * An agent's template, as the roster serves it, plus whether the template can
 * start the agent headless (`wake`).
 */
export interface ResolvedAgentTemplate extends AgentTemplateRef {
  /** The template carries a `wake` block: a runner could start it. */
  wakes: boolean;
}

/**
 * The harnesses whose BUILT-IN template carries a `wake` block (plan v2 §2.1:
 * Claude Code `claude -p`, Codex `codex exec`). Read only on the fallback
 * below, for a pod whose catalog has not installed the agent's template yet.
 */
const WAKEABLE_HARNESSES: ReadonlySet<AgentHarnessSlug> =
  new Set<AgentHarnessSlug>(["claude-code", "codex"]);

/** The agent as the template seam reads it. */
export interface AgentTemplateSubject {
  agentType: string | null | undefined;
  /** `users.agent_template_slug`: the agent's link to its template. */
  templateSlug?: string | null;
}

/**
 * THE seam that names an agent's template. In order:
 *   1. its link (`users.agent_template_slug`) to an INSTALLED template;
 *   2. the installed template whose `harness` is its type (an agent the
 *      self-healing pass has not linked yet);
 *   3. the built-in harness registry row (`AGENT_HARNESSES`), `version: null`
 *      = built in, for a pod whose catalog has not installed it yet (the
 *      official ones are installed by the catalog, founder decision D8).
 * `version` is the catalog version the template was installed at; `wakes` =
 * the template carries a `wake` block. `null` = no template names it.
 * Pure: the caller reads the installed templates once
 * (`loadInstalledAgentTemplates`).
 */
export function resolveAgentTemplate(
  agent: AgentTemplateSubject,
  installed: readonly InstalledAgentTemplate[] = []
): ResolvedAgentTemplate | null {
  const fromInstalled = (t: InstalledAgentTemplate): ResolvedAgentTemplate => ({
    slug: t.slug,
    label: t.name,
    version: t.version,
    wakes: t.wakes,
    wake: t.wake,
  });
  if (agent.templateSlug) {
    const linked = installed.find((t) => t.slug === agent.templateSlug);
    if (linked) return fromInstalled(linked);
  }
  if (agent.agentType) {
    const byHarness = installed.find((t) => t.harness === agent.agentType);
    if (byHarness) return fromInstalled(byHarness);
  }
  const harness = resolveHarness(agent.agentType);
  if (!harness) return null;
  return {
    slug: harness.slug,
    label: harness.label,
    version: null,
    wakes: WAKEABLE_HARNESSES.has(harness.slug as AgentHarnessSlug),
    // Built in: the pod holds no wake block to serve (a runner falls back to its own catalog copy).
    wake: null,
  };
}

/**
 * What can start agents on a computer: its runner, online or not, and the
 * computer's "Wakes agents" switch. `null` = nothing on it can start agents.
 */
export interface ComputerWaker {
  online: boolean;
  wakesAgents: boolean;
}

export interface AgentWakeInput {
  reach: AgentReach;
  paused: boolean;
  /** dispatch only: the binding cannot be used (`summary.binding.error`). */
  bindingBroken: boolean;
  /**
   * `nobodyRunsOf`: `false` = a runner served it within the live window;
   * `true` = not within it; `null` = not measured or not applicable.
   */
  nobodyRuns: boolean | null;
  template: ResolvedAgentTemplate | null;
  onComputer: boolean;
  waker: ComputerWaker | null;
}

/**
 * THE wake rule, first match wins:
 *   1. paused                                  → cant_wake, paused
 *   2. reach pod                               → awake, built_in
 *   3. dispatch, binding broken                → cant_wake, binding_broken
 *   4. dispatch                                → awake, binding
 *   5. pull, a runner served it in the window  → awake
 *   6. pull, no template                       → cant_wake, no_template
 *   7. pull, template cannot start it          → cant_wake, no_template_wake
 *   8. pull, no computer                       → cant_wake, no_computer
 *   9. nothing on its computer starts agents   → cant_wake, no_waker
 *  10. its runner is offline                   → cant_wake, computer_offline
 *  11. its "Wakes agents" switch is off        → cant_wake, wakes_off
 *  12. otherwise                               → can_wake, runner
 * A key used recently is NOT awake: an interactive conversation on the same
 * identity takes no handed work (`agent-presence.ts`); only the runner's own
 * stamp says something runs it.
 */
export function deriveAgentWake(i: AgentWakeInput): AgentWake {
  const pullHow = i.template?.wakes ? ("runner" as const) : null;
  const how =
    i.reach === "pod"
      ? ("built_in" as const)
      : i.reach === "dispatch"
        ? ("binding" as const)
        : pullHow;
  const cant = (why: AgentWake["why"]): AgentWake => ({
    state: "cant_wake",
    how,
    why,
  });
  if (i.paused) return cant("paused");
  if (i.reach === "pod") return { state: "awake", how, why: null };
  if (i.reach === "dispatch") {
    return i.bindingBroken
      ? cant("binding_broken")
      : { state: "awake", how, why: null };
  }
  // A runner serves it: that runner is what gets it working, template or not.
  if (i.nobodyRuns === false) {
    return { state: "awake", how: "runner", why: null };
  }
  if (!i.template) return cant("no_template");
  if (!i.template.wakes) return cant("no_template_wake");
  if (!i.onComputer) return cant("no_computer");
  if (!i.waker) return cant("no_waker");
  if (!i.waker.online) return cant("computer_offline");
  if (!i.waker.wakesAgents) return cant("wakes_off");
  return { state: "can_wake", how, why: null };
}
