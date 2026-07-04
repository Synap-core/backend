/**
 * ExternalAgentExecutor — the BYOA executor (Phase 3).
 *
 * "Bring Your Own Agent": a Playbook whose `executor` is `external-agent`
 * dispatches the run to an external agent (Claude Code, a CLI, a friend's
 * scraper). The verifiable cut shipped here is the WEBHOOK path: if the run
 * carries a webhook URL, POST the run envelope to it (fire-and-forget, bounded
 * timeout). The external agent then does its work with ITS OWN skills and
 * CAPTURES RESULTS BACK through the Hub Protocol (`POST /runs/:id/capture`) —
 * never with direct DB access.
 *
 * The webhook URL is read from the RunContext input (`webhookUrl`), which the
 * runner threads through from the playbook/tool config. `callbackUrl` in the
 * envelope tells the agent where to capture back.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.4,
 * external-agent executor; security: BYOA acts only through the Hub Protocol).
 */

import type { Executor, RunContext, RunResult } from "@synap/playbooks";
import { validateExternalUrl } from "@synap/shared-utils";

/** Fire-and-forget POST with a hard timeout; never throws. */
async function postWebhook(url: string, body: unknown): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export class ExternalAgentExecutor implements Executor {
  readonly ref = "external-agent" as const;

  async run(ctx: RunContext): Promise<RunResult> {
    // The runner threads the BYOA target config onto the input as `webhookUrl`
    // (+ optional `callbackUrl`). When present, the webhook path is the
    // verifiable BYOA dispatch.
    const input = (ctx.input ?? {}) as {
      webhookUrl?: string;
      callbackUrl?: string;
      runId?: string;
    };

    if (input.webhookUrl) {
      // SSRF guard — the canonical server-side outbound-fetch validator (same
      // one channels.ts uses before relaying to an external channel). Blocks
      // loopback / private / metadata (169.254.169.254) targets. Fail the run
      // rather than POST the envelope to an internal address.
      const check = validateExternalUrl(input.webhookUrl);
      if (!check.valid) {
        return {
          status: "failed",
          error: `external-agent webhook URL rejected: ${check.reason}`,
        };
      }

      // Fire-and-forget — the external agent works async and captures back via
      // POST {pod}/api/hub/runs/{runId}/capture. We await only the delivery.
      void postWebhook(input.webhookUrl, {
        runId: input.runId ?? null,
        sessionId: ctx.sessionId,
        channelId: ctx.channelId ?? null,
        goal: ctx.goal,
        // The bound subject — the external agent scopes its work to this entity.
        subject: ctx.subjectId
          ? {
              id: ctx.subjectId,
              name: ctx.subjectName ?? null,
              profile: ctx.subjectProfile ?? null,
            }
          : null,
        capturePath: input.runId
          ? `/api/hub/runs/${input.runId}/capture`
          : null,
        capabilities: ctx.capabilities,
        // Stage context so the external agent can scope to the active stage.
        // ADVISORY only — stage-scoped-grant ENFORCEMENT is a deliberate
        // follow-up (stage.grants are not yet intersected into `capabilities`).
        stages: ctx.stages ?? [],
        currentStage: ctx.currentStage ?? null,
      });
      return {
        status: "running",
        summary: "dispatched to external agent via webhook",
      };
    }

    // NEEDS-DOGFOOD (P3.3): devplane WS spawn — driving Claude Code via the
    // `/api/devplane/claude-code` WS handler is the other BYOA dispatch path.
    // NOT implemented here (no process spawning in P3); a playbook that targets
    // external-agent without a webhookUrl currently records a running run with
    // no dispatch. Wire the devplane spawn in a follow-up.
    return {
      status: "running",
      summary:
        "external-agent run created; no webhookUrl — devplane spawn is P3.3 (not yet wired)",
    };
  }
}
