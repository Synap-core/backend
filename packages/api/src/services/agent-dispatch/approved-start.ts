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
 * external-agent run still `proposed` with no `externalAgent` (claimed in the
 * WHERE clause, so a double approve records once). Never throws: the approval
 * already ran the verb.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  drizzleSql,
  focusSessions,
  playbookRuns,
} from "@synap/database";
import type { PlaybookRunExternalAgent } from "@synap/database/schema";
import { AgentBindingError, resolveAgentBinding } from "./agent-binding.js";
import {
  asOptionalString,
  asRecord,
  externalRefFromStartResult,
  postDispatchNotice,
} from "./binding-call.js";

const logger = createLogger({ module: "agent-dispatch/approved-start" });

export type ApprovedStartOutcome =
  | { status: "recorded"; runId: string }
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
    const ref: PlaybookRunExternalAgent = {
      agentUserId,
      toolId: binding.toolId,
      provider: binding.provider,
      externalId,
      url,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    const summary = `dispatched to ${binding.provider}${externalId ? ` (${externalId})` : ""}`;
    const claimed = await db
      .update(playbookRuns)
      .set({
        status: "running",
        completedAt: null,
        summary,
        externalAgent: ref,
      })
      .where(
        and(
          eq(playbookRuns.id, runId),
          eq(playbookRuns.executor, "external-agent"),
          eq(playbookRuns.status, "proposed"),
          drizzleSql`${playbookRuns.externalAgent} IS NULL`
        )
      )
      .returning({ id: playbookRuns.id, sessionId: playbookRuns.sessionId });
    if (claimed.length === 0) {
      return {
        status: "skipped",
        reason: "run is not a proposed external-agent start",
      };
    }
    const sessionId = claimed[0]!.sessionId;
    if (sessionId) {
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, sessionId),
        columns: { userId: true, channelId: true },
      });
      if (session) {
        await postDispatchNotice({
          channelId: session.channelId,
          ownerId: session.userId,
          content: `Approved — handed to the ${binding.provider} agent${url ? ` — ${url}` : ""}.`,
          idempotencyKey: `external-agent:${runId}:started`,
        });
      }
    }
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
