/**
 * A `runner` chosen AT RUN (spec 7111934d §2.4, slice 2): the person, or an
 * agent starting a run, names who runs THIS run with the same grammar a
 * playbook uses (`PlaybookRunner`). It maps onto what the run already takes:
 *   - one agent by id       → `handToAgentId` (refused by name, as before);
 *   - Synap AI              → `runOn: "synap_ai"` (+ its persona as
 *                             `agentType` when the caller named none);
 *   - a role, an engine or a list → resolved NOW through `resolveRunner`
 *                             (the route, the wake marks, the tools), then
 *                             one of the two above.
 * A choice made at Run never falls through to the playbook's runner or the
 * person's remembered one: nobody it names can take the run → refused, with
 * who was passed over and why.
 *
 * And the offer the founder asked for (D1 flipped, via the lead, 9 Nov 2026):
 * a playbook that names its own runner beats the person's remembered choice,
 * so remembering a different one would rarely apply. The run reply then
 * OFFERS to make it the playbook's runner — `playbooks.update { runner }`,
 * the governed definition door (a person applies; an agent proposes).
 */

import { TRPCError } from "@trpc/server";
import type { RunChoice } from "@synap-core/types/agents";
import { runnerChoices, type PlaybookRunner } from "@synap/playbooks";
import type { Playbook } from "@synap/database/schema";
import { resolveRunner } from "../agent-dispatch/runner.js";
import { requiresOf } from "./requires-of.js";

/** What a Run-time `runner` maps to on the run input. */
export interface RunnerAtRun {
  handToAgentId?: string;
  runOn?: "synap_ai";
  agentType?: string;
}

export async function mapRunnerAtRun(input: {
  ownerId: string;
  runner: PlaybookRunner;
  playbook: Pick<Playbook, "executor"> & Partial<Pick<Playbook, "requires">>;
}): Promise<RunnerAtRun> {
  const choices = runnerChoices(input.runner);
  const only = choices.length === 1 ? choices[0] : undefined;
  // One agent by id: the hand-off door, which refuses it by name.
  if (only && typeof only === "object" && "agentId" in only) {
    return { handToAgentId: only.agentId };
  }
  if (only === "synap_ai") return { runOn: "synap_ai" };
  const resolved = await resolveRunner({
    ownerId: input.ownerId,
    runner: input.runner,
    requires: requiresOf(input.playbook),
    synapAiAllowed: input.playbook.executor !== "external-agent",
  });
  const chosen = resolved.chosen;
  if (!chosen) {
    const why = resolved.passedOver
      .map(
        (p) =>
          `choice ${p.choice + 1}${p.name ? ` (${p.name})` : ""}: ${p.why.replace(/_/g, " ")}`
      )
      .join("; ");
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `None of the runners you chose can take this run${why ? ` — ${why}` : ""}. Choose another agent, or Synap AI.`,
    });
  }
  if (chosen.kind === "synap_ai") {
    return {
      runOn: "synap_ai",
      ...(chosen.persona ? { agentType: chosen.persona } : {}),
    };
  }
  return { handToAgentId: chosen.agentUserId };
}

/** The offer a remembered choice gets when the playbook names its own runner. */
export interface RunnerOffer {
  kind: "set_playbook_runner";
  /** What `playbooks.update { runner }` would write. */
  runner: PlaybookRunner;
  message: string;
}

/**
 * The offer to make `choice` the playbook's runner, or `null` when the
 * playbook names none (the remembered choice then decides, as before) or
 * already names exactly this one.
 */
export function runnerOfferFor(
  playbook: Pick<Playbook, "runner">,
  choice: RunChoice
): RunnerOffer | null {
  if (playbook.runner === null || playbook.runner === undefined) return null;
  const runner: PlaybookRunner =
    choice.executor === "is-agent"
      ? "synap_ai"
      : { agentId: choice.agentUserId };
  if (JSON.stringify(playbook.runner) === JSON.stringify(runner)) return null;
  return {
    kind: "set_playbook_runner",
    runner,
    message:
      "This process names who runs it, and that comes before your remembered choice. To run it this way every time, make this its runner (playbooks.update { runner }).",
  };
}
