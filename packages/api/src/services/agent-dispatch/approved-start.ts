/**
 * A PROPOSED agent start that a person approved is tracked like a direct one.
 *
 * When governance turned the binding's `start` verb into a `capability.run`
 * proposal, the external-agent executor recorded the run as `proposed` and no
 * `externalAgent` (nothing had started). On approval the `capability.run`
 * executor runs the verb; this records the hand-off from THAT execution's
 * result — `externalAgent` on the run, the run back to `running`, a room
 * notice — so the status poll, the wake door and cancel see it.
 *
 * It only acts when the approved verb IS the start verb of the binding of the
 * agent that filed it, and the run named in its parameters is an
 * external-agent run still `proposed` with no `externalAgent` or the
 * executor's `pending_start` one (claimed in the WHERE clause, so a double
 * approve records once). Never throws: the approval
 * already ran the verb.
 */

import { createLogger } from "@synap-core/core";
import { db, and, eq, drizzleSql, playbookRuns } from "@synap/database";
import type { PlaybookRunExternalAgent } from "@synap/database/schema";
import { settleParentAutomationRunFromChild } from "@synap/jobs";
import { AgentBindingError, resolveAgentBinding } from "./agent-binding.js";
import { resolveServiceName } from "@synap-core/types/service-marks";
import {
  asOptionalString,
  agentDisplayName,
  asRecord,
  externalRefFromStartResult,
  noTaskIdMessage,
  postSessionNotice,
} from "./binding-call.js";

const logger = createLogger({ module: "agent-dispatch/approved-start" });

export type ApprovedStartOutcome =
  | { status: "recorded"; runId: string }
  /** The verb ran but returned no task id: the run was FAILED, not tracked. */
  | { status: "failed"; runId: string; error: string }
  | { status: "not_a_start" }
  | { status: "skipped"; reason: string };

export async function recordApprovedAgentStart(p: {
  proposal: { agentUserId?: string | null };
  verbId: string | null | undefined;
  parameters: Record<string, unknown>;
  result: unknown;
}): Promise<ApprovedStartOutcome> {
  try {
    const runId = asOptionalString(p.parameters.runId);
    const agentUserId =
      p.proposal.agentUserId ??
      asOptionalString(asRecord(p.parameters.agent).agentUserId);
    if (!runId || !agentUserId || !p.verbId) return { status: "not_a_start" };

    let binding;
    try {
      binding = await resolveAgentBinding(agentUserId);
    } catch (err) {
      if (err instanceof AgentBindingError) {
        return { status: "skipped", reason: err.message };
      }
      throw err;
    }
    if (!binding || binding.verbs.start !== p.verbId) {
      return { status: "not_a_start" };
    }

    const { externalId, url } = externalRefFromStartResult(p.result);
    const service = resolveServiceName(binding.provider);
    // Claimed in the WHERE clause, so a double approve records once.
    const claimable = and(
      eq(playbookRuns.id, runId),
      eq(playbookRuns.executor, "external-agent"),
      eq(playbookRuns.status, "proposed"),
      // Nothing recorded yet, or the PENDING start the executor recorded
      // (`status: 'pending_start'`) — never a hand-off already recorded.
      drizzleSql`(${playbookRuns.externalAgent} IS NULL OR ${playbookRuns.externalAgent}->>'status' = 'pending_start')`
    );
    if (!externalId) {
      // Same decision as the direct start: no task id ⇒ nothing to poll, answer
      // or cancel, so the run FAILS rather than sitting `running` untracked.
      const error = noTaskIdMessage(await agentDisplayName(agentUserId), url);
      const failedRun = await db
        .update(playbookRuns)
        .set({
          status: "failed",
          completedAt: new Date(),
          error,
          externalAgent: null,
        })
        .where(claimable)
        .returning({ id: playbookRuns.id, sessionId: playbookRuns.sessionId });
      if (failedRun.length === 0) {
        return {
          status: "skipped",
          reason: "run is not a proposed external-agent start",
        };
      }
      // A failed child of an automation run: settle the parent from it, as
      // every terminal writer must (tripwire playbook-run-terminal-settles-parent).
      await settleParentAutomationRunFromChild({ playbookRunId: runId });
      await postSessionNotice(
        failedRun[0]!.sessionId,
        `Could not hand this run to an agent: ${error}`,
        `external-agent:${runId}:start-no-task-id`
      );
      return { status: "failed", runId, error };
    }
    const ref: PlaybookRunExternalAgent = {
      agentUserId,
      toolId: binding.toolId,
      provider: binding.provider,
      externalId,
      url,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    const summary = `dispatched to ${service} (${externalId})`;
    const claimed = await db
      .update(playbookRuns)
      .set({
        status: "running",
        completedAt: null,
        summary,
        externalAgent: ref,
      })
      .where(claimable)
      .returning({ id: playbookRuns.id, sessionId: playbookRuns.sessionId });
    if (claimed.length === 0) {
      return {
        status: "skipped",
        reason: "run is not a proposed external-agent start",
      };
    }
    await postSessionNotice(
      claimed[0]!.sessionId,
      `Approved — handed to the ${service} agent.`,
      `external-agent:${runId}:started`
    );
    return { status: "recorded", runId };
  } catch (err) {
    logger.error(
      { err },
      "approved agent start: recording the hand-off failed — the verb already ran"
    );
    return {
      status: "skipped",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
