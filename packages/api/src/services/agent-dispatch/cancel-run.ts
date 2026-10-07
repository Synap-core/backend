/**
 * Cancel a run — and, when it was handed to an external agent whose binding
 * can cancel, cancel the agent's task too.
 *
 *   supports.cancel  ⇒ the binding's `cancel` verb runs (governed, as the
 *                      agent). It must succeed before the run is marked
 *                      cancelled — a run that says "cancelled" while the agent
 *                      keeps pushing commits would be a lie.
 *   no cancel verb   ⇒ the run is marked cancelled, and the result + the room
 *                      SAY the agent could not be stopped from Synap.
 *   not dispatched   ⇒ the run is simply marked cancelled.
 *
 * Caller-gated (the Hub route governs the caller first).
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  eq,
  focusSessions,
  playbookRuns,
  liveRunStatusWhere,
  and,
} from "@synap/database";
import type { PlaybookRunExternalAgent } from "@synap/database/schema";
import { settleParentAutomationRunFromChild } from "@synap/jobs";
import { AgentBindingError, resolveAgentBinding } from "./agent-binding.js";
import { callBindingVerb, postDispatchNotice } from "./binding-call.js";

const logger = createLogger({ module: "agent-dispatch/cancel" });

export type CancelRunResult =
  | { status: "not_found" }
  | { status: "not_live"; runStatus: string }
  /** The agent's cancel verb failed — the run is NOT marked cancelled. */
  | { status: "cancel_failed"; message: string }
  | {
      status: "cancelled";
      /** true: the agent's task was cancelled too; false: it could not be. */
      externalCancelled: boolean | null;
      note?: string;
    };

export async function cancelRun(p: {
  runId: string;
  /** The human the cancel is for (verb attribution's owner). */
  userId: string;
}): Promise<CancelRunResult> {
  const run = await db.query.playbookRuns.findFirst({
    where: eq(playbookRuns.id, p.runId),
  });
  if (!run) return { status: "not_found" };
  if (run.status !== "running" && run.status !== "waiting_on_you") {
    return { status: "not_live", runStatus: run.status };
  }
  const session = run.sessionId
    ? await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, run.sessionId),
        columns: { userId: true, channelId: true },
      })
    : null;
  const ownerId = session?.userId ?? p.userId;
  const channelId = session?.channelId ?? null;
  const ext = run.externalAgent as PlaybookRunExternalAgent | null;

  let externalCancelled: boolean | null = null;
  let note: string | undefined;
  if (ext) {
    let canCancel = false;
    try {
      const binding = await resolveAgentBinding(ext.agentUserId);
      if (binding?.supports.cancel && binding.verbs.cancel) {
        canCancel = true;
        const res = await callBindingVerb({
          binding,
          verb: "cancel",
          agentUserId: ext.agentUserId,
          ownerId,
          parameters: {
            externalId: ext.externalId,
            runId: run.id,
            sessionId: run.sessionId,
          },
          sessionId: run.sessionId,
          channelId,
          idempotencyKey: `agent-cancel:${run.id}`,
        });
        if (res.status !== "ok") {
          const message =
            res.status === "proposed"
              ? `cancelling the ${ext.provider} task needs approval: ${res.reviewUrl}`
              : res.status === "unsupported" || res.status === "failed"
                ? res.message
                : "unknown";
          logger.warn({ runId: run.id, message }, "external cancel failed");
          await postDispatchNotice({
            channelId,
            ownerId,
            content: `Could not cancel the ${ext.provider} task: ${message}`,
            idempotencyKey: `external-agent:${run.id}:cancel-failed:${Date.now()}`,
          });
          return { status: "cancel_failed", message };
        }
        externalCancelled = true;
      }
    } catch (err) {
      if (!(err instanceof AgentBindingError)) throw err;
      note = `The agent's binding is broken (${err.message}), so its task could not be cancelled from Synap.`;
    }
    if (!canCancel && externalCancelled === null) {
      externalCancelled = false;
      note ??= `The ${ext.provider} agent cannot be cancelled from Synap — its task may keep running until it finishes on its side.`;
    }
  }

  const externalAgentPatch = ext
    ? { externalAgent: { ...ext, status: "cancelled" as const } }
    : {};
  const [updated] = await db
    .update(playbookRuns)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      // Built outside this literal — the terminal-settles tripwire parses a
      // brace-free `.set({...})`.
      ...externalAgentPatch,
    })
    .where(
      and(eq(playbookRuns.id, run.id), liveRunStatusWhere(playbookRuns.status))
    )
    .returning({ id: playbookRuns.id });
  if (!updated) {
    const [now] = await db
      .select({ status: playbookRuns.status })
      .from(playbookRuns)
      .where(eq(playbookRuns.id, run.id));
    return { status: "not_live", runStatus: now?.status ?? "unknown" };
  }
  await settleParentAutomationRunFromChild({ playbookRunId: run.id });
  await postDispatchNotice({
    channelId,
    ownerId,
    content: note ? `Run cancelled. ${note}` : "Run cancelled.",
    idempotencyKey: `external-agent:${run.id}:cancelled`,
  });
  return {
    status: "cancelled",
    externalCancelled,
    ...(note ? { note } : {}),
  };
}
