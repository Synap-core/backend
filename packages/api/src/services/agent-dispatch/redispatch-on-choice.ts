/**
 * "Choose an agent" answered ⇒ the run that owed it is RE-DISPATCHED, through
 * the same executor path (`resolveExecutor("external-agent").run(ctx)` + the
 * ONE result writer `recordExecutorResult`), on the SAME run row.
 *
 * The external-agent executor failed the run and owed the person one
 * `CHOOSE_AGENT_SLOT_LABEL` slot; answering it writes `agentUserId` into the
 * session's params (the answer door, `answer-slot.ts`), which the executor
 * reads as the run param. This reactor listens for that answer's side effect
 * (`focus_session` / `slot_answered`) and dispatches again.
 *
 * IDEMPOTENT: the run is CLAIMED `failed → running` (WHERE status = 'failed'
 * AND external_agent IS NULL) before the executor runs — a second delivery of
 * the event, or a second answer, finds nothing to claim.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  desc,
  eq,
  drizzleSql,
  entities,
  focusSessions,
  playbookRuns,
} from "@synap/database";
import { registerReactor, type Reactor } from "@synap/events";
import type { PlaybookStage, RunResult } from "@synap/playbooks";
import { PARAM_SLOT_KIND } from "@synap-core/types/focus-sessions";
import { resolveExecutor } from "../playbooks/executors/registry.js";
import { recordExecutorResult } from "../playbooks/run-playbook.js";
import { runPromptFor } from "../playbooks/playbook-lifecycle.js";
import {
  getLinksFor,
  resolveGrantedCapabilities,
} from "../links/links-service.js";
import { CHOOSE_AGENT_SLOT_LABEL } from "../playbooks/executors/external-agent-executor.js";
import { normalizeExpectedLabel } from "../focus-sessions/expected-label.js";
import { asRecord } from "./binding-call.js";

const logger = createLogger({ module: "agent-dispatch/redispatch" });

export type RedispatchOutcome =
  | { status: "redispatched"; runId: string; runStatus: RunResult["status"] }
  | { status: "nothing_to_redispatch" };

export async function redispatchAfterAgentChoice(
  sessionId: string
): Promise<RedispatchOutcome> {
  const [failed] = await db
    .select({ id: playbookRuns.id })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, sessionId),
        eq(playbookRuns.executor, "external-agent"),
        eq(playbookRuns.status, "failed"),
        drizzleSql`${playbookRuns.externalAgent} IS NULL`
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  if (!failed) return { status: "nothing_to_redispatch" };

  // CLAIM — only the claimer dispatches.
  const [run] = await db
    .update(playbookRuns)
    .set({ status: "running", error: null, completedAt: null })
    .where(
      and(
        eq(playbookRuns.id, failed.id),
        eq(playbookRuns.status, "failed"),
        drizzleSql`${playbookRuns.externalAgent} IS NULL`
      )
    )
    .returning();
  if (!run) return { status: "nothing_to_redispatch" };

  const session = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, sessionId),
  });
  if (!session) {
    await recordExecutorResult(run.id, {
      status: "failed",
      error: "re-dispatch: the session no longer exists",
    });
    return { status: "redispatched", runId: run.id, runStatus: "failed" };
  }
  let subjectName: string | undefined;
  let subjectProfile: string | undefined;
  if (session.subjectEntityId) {
    const subj = await db.query.entities.findFirst({
      columns: { title: true, type: true },
      where: eq(entities.id, session.subjectEntityId),
    });
    subjectName = subj?.title ?? undefined;
    subjectProfile = subj?.type ?? undefined;
  }
  const playbookLinks = await getLinksFor(
    run.createdBy,
    "playbook",
    run.playbookId
  );
  const capabilities = await resolveGrantedCapabilities(playbookLinks, {
    linkType: "grants",
    fromType: "playbook",
  });
  const snapshot = asRecord(run.definitionSnapshot);

  let result: RunResult;
  try {
    result = await resolveExecutor("external-agent").run({
      workspaceId: run.workspaceId ?? session.workspaceId ?? "",
      userId: run.createdBy,
      playbookId: run.playbookId,
      sessionId: session.id,
      channelId: session.channelId ?? null,
      goal: runPromptFor(session),
      ...(session.subjectEntityId
        ? { subjectId: session.subjectEntityId, subjectName, subjectProfile }
        : {}),
      stages: Array.isArray(snapshot.stages)
        ? (snapshot.stages as PlaybookStage[])
        : [],
      currentStage: session.currentStage,
      input: { ...asRecord(run.input), runId: run.id },
      capabilities,
    });
  } catch (err) {
    result = {
      status: "failed",
      error: err instanceof Error ? err.message : "Executor threw",
    };
  }
  await recordExecutorResult(run.id, result);
  return { status: "redispatched", runId: run.id, runStatus: result.status };
}

export const agentChoiceRedispatchReactor: Reactor = {
  id: "agent-choice-redispatch",
  match: (payload) =>
    payload.subjectType === "focus_session" &&
    payload.action === "slot_answered" &&
    payload.data?.kind === PARAM_SLOT_KIND &&
    normalizeExpectedLabel(
      payload.data?.expectedLabel as string | undefined
    ) === normalizeExpectedLabel(CHOOSE_AGENT_SLOT_LABEL),
  async handler(payload) {
    try {
      const out = await redispatchAfterAgentChoice(payload.subjectId);
      logger.info(
        { sessionId: payload.subjectId, ...out },
        "agent chosen — run re-dispatch"
      );
    } catch (err) {
      logger.error(
        { err, sessionId: payload.subjectId },
        "agent chosen — re-dispatching the run FAILED"
      );
    }
  },
};

let registered = false;

/** Register the reactor. Called once at API boot (`apps/api/src/index.ts`). */
export function registerAgentChoiceRedispatchReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(agentChoiceRedispatchReactor);
  logger.info("Registered agent-choice re-dispatch reactor");
}
