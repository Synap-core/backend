/**
 * Executor Registry — resolve an ExecutorRef to its Executor implementation.
 *
 * The single dispatch point of the executor spine (Phase 3). A Playbook names
 * an `ExecutorRef`; `runPlaybook` resolves it here and dispatches. This is what
 * makes "IS, or BYOA, or both" a config choice rather than a code fork.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.3-4.4).
 */

import type { Executor, ExecutorRef } from "@synap/playbooks";
import { IsAgentExecutor } from "./is-agent-executor.js";
import { ExternalAgentExecutor } from "./external-agent-executor.js";

const isAgent = new IsAgentExecutor();
const externalAgent = new ExternalAgentExecutor();

/** Map an ExecutorRef to its singleton Executor implementation. */
export function resolveExecutor(ref: ExecutorRef): Executor {
  switch (ref) {
    case "is-agent":
    case "hybrid": // a stub that ran the IS path alone; stored rows keep that behaviour
      return isAgent;
    case "external-agent":
      return externalAgent;
    case "generate":
      // A one-shot playbook never dispatches on a session: `executeSingleRun`
      // runs it through `executeGenerateRun` (one `ai.generate` call, a
      // proposal on the subject) before any session exists. Reaching here
      // means a door skipped that branch: refuse rather than start an agent.
      throw new Error(
        "A one-shot (generate) playbook runs without a session: start it through runPlaybook, never through a session executor."
      );
    default: {
      // Exhaustiveness guard — a new ExecutorRef must add a branch here.
      const _exhaustive: never = ref;
      throw new Error(`Unknown executor ref: ${String(_exhaustive)}`);
    }
  }
}
