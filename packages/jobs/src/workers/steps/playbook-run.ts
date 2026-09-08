/**
 * `playbook_run` step executor — a thin shim over the ONE playbook-run spine
 * reached through the `registerPlaybookRunner` IoC slot.
 */
import { db, eq, entities } from "@synap/database";
import {
  getPlaybookRunner,
  getSessionScheduler,
} from "../capability-dispatch.js";
import {
  guardProducerEffect,
  PolicyBlockedError,
} from "../../utils/automation-governance.js";
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
    /**
     * AGENT SELECTOR — the `agents.slug` of the agent that should answer this
     * run ("ask <agent> to …"). Optional: absent ⇒ the default orchestrator
     * ("meta"), which is what every existing node does. Forwarded verbatim; the
     * `is-agent` executor resolves it against the `agents` catalog and fails the
     * run on an unknown slug rather than quietly using the orchestrator.
     */
    agentType?: string;
    /**
     * WHAT this node materializes at its slot.
     *
     * - absent / `"run"` — an unattended RUN: session + channel + `playbook_runs`
     *   row + agent kickoff. Every node authored before this field existed lands
     *   here, unchanged.
     * - `"appointment"` — an APPOINTMENT: one `focus_sessions` row with
     *   `status: 'scheduled'`, waiting for the HUMAN. No channel, no run row, and
     *   crucially NO agent kickoff — the branch below never reaches the runner,
     *   so there is no suppression flag that could be forgotten.
     *
     * Set by `buildPlaybookRunFlowDefinition` from the playbook's
     * `schedule.mode`; see `normalizePlaybookScheduleMode` (@synap/playbooks),
     * the ONE place that decides what an absent/unknown mode means.
     */
    mode?: "run" | "appointment";
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
    throw new PolicyBlockedError(
      guard.kind,
      guard.kind === "deny"
        ? `playbook_run denied by producer-agent governance (confused-deputy guard): ${guard.reason ?? "capability denied"}`
        : `playbook_run cannot auto-execute: an agent produced this trigger, so a human-owned automation may not launch it ungoverned (confused-deputy guard).`
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

  // `goalResolver` resolves the playbook's goalTemplate against the automation
  // StepContext — the spine invokes it after it loads the playbook — preserving
  // the old `... || raw template` fallback. Hoisted out of the call so BOTH
  // materializations (run and appointment) resolve the goal identically; a second
  // copy of this grammar fork is how the two would drift.
  const goalResolver = (goalTemplate: string): string | undefined => {
    const resolved = resolveTemplate(goalTemplate, context);
    // `resolveTemplate` speaks ONLY {{mustache}}. A goalTemplate authored in
    // the command-template grammar (`@{arg:name:type}`) contains no `{{ }}`,
    // so it comes back BYTE-FOR-BYTE — and handing that on as a "resolved"
    // goal is how 49 sessions were born reading a literal
    // "Advance @{arg:company:entity} through …". It never counted as a miss,
    // so every existing diagnostic stayed silent. Returning undefined says
    // "wrong resolver for this grammar" and lets the spine's resolveGoal —
    // which DOES speak it — substitute against `params`.
    if (resolved === goalTemplate && goalTemplate.includes("@{arg:")) {
      return undefined;
    }
    // A template mixing both grammars cannot be fully resolved by either side
    // alone. Don't guess — resolve what we can and make the remainder LOUD,
    // since silence is what let the original bug run 49 times.
    if (resolved.includes("@{arg:")) {
      logger.warn(
        { playbookId: data.playbookId, playbookName: data.playbookName },
        "playbook_run: goal mixes {{...}} and @{arg:...} grammars — the @{arg:...} references will not be substituted"
      );
    }
    return resolved || goalTemplate;
  };

  const chainContext = automationContext
    ? {
        automationRunId: automationContext.automationRunId,
        automationId: automationContext.automationId,
        chainDepth: automationContext.chainDepth ?? 0,
        rootRunId:
          automationContext.rootRunId ?? automationContext.automationRunId,
        chainAutomationIds: automationContext.chainAutomationIds ?? [],
      }
    : undefined;

  // ── APPOINTMENT: materialize a `scheduled` session and STOP. ───────────────
  // Not a run. No channel, no `playbook_runs` row, and — the point of the whole
  // mode — no agent kickoff: this branch RETURNS before reaching the playbook
  // runner, which is where the executor spine's `triggerAutoRespond` dispatch
  // lives. A scheduled session is waiting for the human, so nothing must answer
  // it for them.
  if (data.mode === "appointment") {
    const sessionScheduler = getSessionScheduler();
    if (!sessionScheduler) {
      throw new Error(
        "Session scheduler not registered — apps/api must call registerSessionScheduler() at boot"
      );
    }

    // The slot this appointment is FOR. The cron scheduler stamps the due moment
    // onto the trigger payload as `scheduledAt`
    // (automation-cron-scheduler.ts: `triggerPayload.scheduledAt`); read THAT
    // rather than the clock, so a worker that picked the job up late still
    // records the scheduled moment. Any other trigger origin (manual test-run,
    // an event) has no such stamp and falls back to now, which is the honest
    // answer for "materialize this appointment right now".
    const scheduledAtRaw = context.trigger.payload.scheduledAt;
    const parsed =
      typeof scheduledAtRaw === "string" ? new Date(scheduledAtRaw) : null;
    const scheduledFor =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();

    const scheduled = await sessionScheduler({
      playbookId: data.playbookId,
      playbookName: data.playbookName,
      workspaceId,
      userId: ownerId,
      params: resolvedParams,
      subjectId: resolvedSubjectId ?? null,
      scheduledFor,
      goalResolver,
      // Provenance: WHAT materialized this appointment. Deliberately handed to
      // the scheduler as `scheduledBy` rather than merged into `metadata` as
      // top-level `automationId`/`automationRunId` — those exact keys are the
      // ones `session-kind.ts` reads to classify a row as `kind:'run'`.
      scheduledBy: automationContext
        ? {
            automationId: automationContext.automationId,
            automationRunId: automationContext.automationRunId,
          }
        : undefined,
      // `automationChainContext` is NESTED, so the F2 depth floor still reads it
      // while the top-level automation keys stay absent.
      metadata: chainContext ? { automationChainContext: chainContext } : {},
    });

    // Same step-output contract downstream nodes already read
    // (steps.<id>.output.{sessionId|status}). `status` is the SESSION's status,
    // deliberately: there is no run, so reporting "running" would be a lie a
    // downstream condition could branch on.
    return {
      sessionId: scheduled.session.id,
      channelId: scheduled.session.channelId,
      status: "scheduled",
      outcome: scheduled.outcome,
      missedCount: scheduled.missedCount,
    };
  }

  // ── RUN: delegate to the ONE playbook-run spine. ───────────────────────────
  // `idempotentBySubject` makes a scheduled run start-if-missing/no-op-if-present.
  const playbookRunner = getPlaybookRunner();
  if (!playbookRunner) {
    throw new Error(
      "Playbook runner not registered — apps/api must call registerPlaybookRunner() at boot"
    );
  }

  const result = await playbookRunner({
    playbookId: data.playbookId,
    playbookName: data.playbookName,
    workspaceId,
    userId: ownerId,
    params: resolvedParams,
    subjectId: resolvedSubjectId,
    idempotentBySubject: true,
    agentType: data.agentType,
    goalResolver,
    chainContext,
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
