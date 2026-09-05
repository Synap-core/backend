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
 * The SIBLING dispatch shape is a LOCAL SPAWN: no webhookUrl ⇒ the pod starts
 * the coding CLI itself (DevPlane's `/api/devplane/claude-code` PTY), reached
 * through the `registerDevAgentSpawner` IoC slot because the spawn lives in
 * apps/api (node-pty + the DevPlane gate) and this package cannot import it.
 * Both shapes are fire-and-forget: the agent captures back via
 * `POST /api/hub/runs/:id/capture` exactly the same way.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.4,
 * external-agent executor; security: BYOA acts only through the Hub Protocol).
 */

import type { Executor, RunContext, RunResult } from "@synap/playbooks";
import { validateExternalUrl, safeExternalFetch } from "@synap/shared-utils";
import { getDevAgentSpawner } from "./dev-agent-spawner.js";

/** Fire-and-forget POST with a hard timeout; never throws. */
async function postWebhook(url: string, body: unknown): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    // safeExternalFetch re-validates every hop and rejects redirects, closing the
    // redirect-to-internal SSRF gap left by the pre-validate at the call site.
    const res = await safeExternalFetch(url, {
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

    // No webhookUrl ⇒ LOCAL SPAWN. The pod starts the workspace's coding CLI
    // itself, in the session's own checkout (dev-cwd.ts keys the working
    // directory on the SESSION, so two concurrent dev runs in one workspace
    // never share a tree). Fire-and-forget like the webhook branch: the agent
    // reports back via POST /api/hub/runs/:id/capture.
    const spawner = getDevAgentSpawner();
    if (!spawner) {
      // An unfilled slot is a severance. Fail loudly rather than record a
      // `running` run nothing will ever close — which is exactly what this
      // branch did before it was wired.
      return {
        status: "failed",
        error:
          "external-agent run has no webhookUrl and no local dev-agent spawner is registered — apps/api must call registerDevAgentSpawner() at boot",
      };
    }

    try {
      const spawned = await spawner({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        runId: input.runId ?? null,
        channelId: ctx.channelId ?? null,
        goal: ctx.goal,
        subject: ctx.subjectId
          ? {
              id: ctx.subjectId,
              name: ctx.subjectName ?? null,
              profile: ctx.subjectProfile ?? null,
            }
          : null,
      });
      return {
        status: "running",
        summary: `dispatched to local dev agent (pid ${spawned.pid}) in ${spawned.cwd}`,
      };
    } catch (err) {
      return {
        status: "failed",
        error: `local dev-agent spawn failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
}
