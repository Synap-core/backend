/**
 * `playbook_run` step executor — a thin shim over the ONE playbook-run spine
 * reached through the `registerPlaybookRunner` IoC slot.
 */
import { db, eq, entities } from "@synap/database";
import { getPlaybookRunner } from "../capability-dispatch.js";
import { guardProducerEffect } from "../../utils/automation-governance.js";
import { resolveInputMapping, resolveTemplate } from "../template-resolve.js";
import { logger } from "../automation-executor-logger.js";
import type {
  StepContext,
  ExecutionPayload,
} from "../automation-executor-types.js";

/**
 * Execute a playbook_run step — a THIN SHIM over the ONE playbook-run spine
 * (`runPlaybook`, @synap/api) reached through the `registerPlaybookRunner` IoC
 * slot (@synap/jobs can't statically import @synap/api — circular dep).
 *
 * What STAYS here (needs the automation StepContext, which @synap/api can't see):
 *   - params: `resolveInputMapping(paramsMapping, context)`.
 *   - subject resolution + workspace-visibility IDOR guard (reads the trigger
 *     payload; the column has no FK).
 *   - goal: passed as a `goalResolver` closing over `context`, so the spine
 *     resolves `playbook.goalTemplate` against the StepContext AFTER it loads the
 *     playbook — preserving the old `resolveTemplate(goalTemplate, context) || raw`.
 *
 * Everything else the old local implementation did — id/name resolution, the
 * cross-workspace guard, session/channel/run creation, the governance +
 * chain-context session stamps, definitionSnapshot, enrollment, idempotency-by-
 * subject, and the is-agent kickoff — now lives in runPlaybook. Crucially the
 * kickoff there goes through `triggerAutoRespond` (the ONE door) via the executor
 * spine, so a scheduled `external-agent` / `hybrid` playbook now dispatches
 * correctly instead of being silently forced through the is-agent flow. This
 * shim NO LONGER inlines the A2AI enqueue.
 */
export async function executePlaybookRun(
  data: {
    playbookId?: string;
    playbookName?: string;
    paramsMapping?: Record<string, string>;
  },
  context: StepContext,
  workspaceId: string,
  ownerId: string,
  // F2 safety floor: the chain context of the automation run spawning this
  // playbook's agent — forwarded to the spine, which stamps it onto the session.
  automationContext?: ExecutionPayload["automationContext"],
  // CONFUSED-DEPUTY GUARD: the causal-chain producer. A playbook_run launches an
  // IS agent session AS the owner (`userId: ownerId`); an agent-produced trigger
  // firing a HUMAN-owned automation would launder that agent kickoff through
  // owner-bypass. Fail closed when an agent is in the chain and the producer's
  // ladder would not auto-execute. Absent → owner-only behavior, unchanged.
  producerAgentUserId?: string | null
): Promise<Record<string, unknown>> {
  const guard = await guardProducerEffect({
    producerAgentUserId,
    principalUserId: ownerId,
    workspaceId,
    subjectType: "playbook",
    action: "run",
  });
  if ("block" in guard) {
    throw new Error(
      guard.kind === "deny"
        ? `playbook_run denied by producer-agent governance (confused-deputy guard): ${guard.reason ?? "capability denied"}`
        : `playbook_run cannot auto-execute: an agent produced this trigger, so a human-owned automation may not launch it ungoverned (confused-deputy guard).`
    );
  }

  const playbookRunner = getPlaybookRunner();
  if (!playbookRunner) {
    throw new Error(
      "Playbook runner not registered — apps/api must call registerPlaybookRunner() at boot"
    );
  }

  // Params resolved from prior step outputs / trigger payload (StepContext).
  const resolvedParams = data.paramsMapping
    ? resolveInputMapping(data.paramsMapping, context)
    : {};

  // Resolve subject entity id from params or trigger payload (canonical source).
  // entityId is the loop-context alias for the iterated entity; subjectId is the
  // explicit override; trigger.payload.subjectId is the fallback.
  const candidateSubjectId =
    (resolvedParams.entityId as string | undefined) ??
    (resolvedParams.subjectId as string | undefined) ??
    (context.trigger.payload.subjectId as string | undefined) ??
    null;

  // Bind the subject ONLY if it's an entity the run can legitimately see — its
  // own workspace OR a pod-wide (workspaceId NULL) entity. A crafted
  // paramsMapping / trigger payload must not bind a session to an entity in
  // another workspace (write-side IDOR guard; the column has no FK).
  let resolvedSubjectId: string | undefined;
  if (candidateSubjectId) {
    const subj = await db.query.entities.findFirst({
      columns: { id: true, workspaceId: true },
      where: eq(entities.id, candidateSubjectId),
    });
    if (
      subj &&
      (subj.workspaceId === workspaceId || subj.workspaceId === null)
    ) {
      resolvedSubjectId = subj.id;
    } else {
      logger.warn(
        { candidateSubjectId, workspaceId },
        "playbook_run: subject not visible in workspace — dropping subject binding"
      );
    }
  }

  // Delegate to the ONE spine. `idempotentBySubject` makes a scheduled run
  // start-if-missing/no-op-if-present. `goalResolver` resolves the playbook's
  // goalTemplate against the automation StepContext — the spine invokes it after
  // it loads the playbook — preserving the old `... || raw template` fallback.
  const result = await playbookRunner({
    playbookId: data.playbookId,
    playbookName: data.playbookName,
    workspaceId,
    userId: ownerId,
    params: resolvedParams,
    subjectId: resolvedSubjectId,
    idempotentBySubject: true,
    goalResolver: (goalTemplate) =>
      resolveTemplate(goalTemplate, context) || goalTemplate,
    chainContext: automationContext
      ? {
          automationRunId: automationContext.automationRunId,
          automationId: automationContext.automationId,
          chainDepth: automationContext.chainDepth ?? 0,
          rootRunId:
            automationContext.rootRunId ?? automationContext.automationRunId,
          chainAutomationIds: automationContext.chainAutomationIds ?? [],
        }
      : undefined,
  });

  // Preserve the step-output contract downstream nodes read
  // (steps.<id>.output.{runId|sessionId|status}, or the reuse shape).
  if (result.reused) {
    return {
      sessionId: result.session.id,
      channelId: result.session.channelId,
      status: "reused",
      reused: true,
    };
  }
  return {
    runId: result.run?.id,
    sessionId: result.session.id,
    status: result.run?.status ?? "running",
  };
}
