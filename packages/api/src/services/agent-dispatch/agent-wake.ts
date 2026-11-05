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
 * The harnesses whose agent template carries a `wake` block (plan v2 §2.1:
 * Claude Code `claude -p`, Codex `codex exec`). Hermes has no harness row yet:
 * it arrives as a catalog template.
 */
const WAKEABLE_HARNESSES: ReadonlySet<AgentHarnessSlug> =
  new Set<AgentHarnessSlug>(["claude-code", "codex"]);

/**
 * THE seam the catalog replaces. Until agent templates are a catalog kind
 * installed on the pod (plan v2 slices 2-3), an agent's template is its
 * harness registry row (`AGENT_HARNESSES`), built in, so `version` is `null`.
 * Slice 3 makes this read the installed `agent_templates` row (version = its
 * `marketSource.packageVersion`, `wakes` = it has a `wake` block); no caller
 * changes. `null` = the agent's type names no template.
 */
export function resolveAgentTemplate(
  agentType: string | null | undefined
): ResolvedAgentTemplate | null {
  const harness = resolveHarness(agentType);
  if (!harness) return null;
  return {
    slug: harness.slug,
    label: harness.label,
    version: null,
    wakes: WAKEABLE_HARNESSES.has(harness.slug as AgentHarnessSlug),
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
