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
 * WHO may cancel is decided HERE, for both transports (tRPC
 * `playbookRuns.cancelRun`, Hub `POST /runs/:runId/cancel`): the person who
 * owns the run's session — nobody else, and never a run with no session. A run
 * that is not yours reads exactly like a missing one (`not_found`, no oracle).
 * The transports refuse agent / internal principals before calling.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  eq,
  focusSessions,
  playbookRuns,
  liveRunStatusWhere,
  isLiveRunStatus,
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
  /** The person cancelling — must own the run's session. */
  userId: string;
}): Promise<CancelRunResult> {
  const run = await db.query.playbookRuns.findFirst({
    where: eq(playbookRuns.id, p.runId),
  });
  const session = run?.sessionId
    ? await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, run.sessionId),
        columns: { userId: true, channelId: true },
      })
    : null;
  // THE cancel floor: the session owner only.
  if (!run || !session || session.userId !== p.userId) {
    return { status: "not_found" };
  }
  if (!isLiveRunStatus(run.status)) {
    return { status: "not_live", runStatus: run.status };
  }
  const ownerId = session.userId;
  const channelId = session.channelId ?? null;
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
