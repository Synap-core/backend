/**
 * HybridExecutor — IS + BYOA together (Phase 3, partial).
 *
 * A `hybrid` playbook runs the IS-native path AND delegates external-kind
 * capabilities to the BYOA executor. THIS slice ships the IS-native half: it
 * kicks the IS in the session channel via `IsAgentExecutor`. The delegation
 * loop — routing each external-kind granted capability to `ExternalAgentExecutor`
 * and reconciling the two result streams — is the P3.4 follow-up.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.4).
 */

import type { Executor, RunContext, RunResult } from "@synap/playbooks";
import { IsAgentExecutor } from "./is-agent-executor.js";

export class HybridExecutor implements Executor {
  readonly ref = "hybrid" as const;

  private readonly isAgent = new IsAgentExecutor();

  async run(ctx: RunContext): Promise<RunResult> {
    // TODO(P3.4): delegate external-kind capabilities (ctx.capabilities whose
    // tool/skill executor === "external-agent") to ExternalAgentExecutor and
    // reconcile both result streams. For now hybrid runs the IS-native path
    // only — the IS still works the channel; external delegation is a no-op.
    const result = await this.isAgent.run(ctx);
    return {
      ...result,
      summary: result.summary
        ? `${result.summary} (hybrid: external delegation deferred to P3.4)`
        : "hybrid run via IS (external delegation deferred to P3.4)",
    };
  }
}
