/**
 * Automation Executor Worker
 *
 * Walks the automation DAG (flow_definition), executing steps in topological order.
 * Each step creates an automation_step_run record.
 *
 * Step types:
 *   - trigger: no-op (already fired)
 *   - command: calls Intelligence Hub to execute the command
 *   - condition: evaluates expression, picks yes/no branch
 *   - delay: re-enqueues remaining DAG with pg-boss startAfter
 *   - output: executes output action (notification, entity CRUD, webhook, channel message)
 *   - loop: iterates over collection, executing child steps per item
 *   - transform: applies a pipe-style expression to a prior step value
 *   - fetch: makes an HTTP request (GET/POST/PUT/DELETE/PATCH)
 *   - query: queries entities in the workspace by profile slug
 *   - switch: routes execution to branches based on an expression value
 *
 * Per-node error handling (data.errorHandling):
 *   - continueOnError: record error but continue execution
 *   - maxRetries (0–3): retry failed nodes before giving up
 *   - retryDelay (ms): wait between retries
 *
 * Events emitted by output steps carry automationContext so the trigger
 * matcher can detect and prevent circular chains.
 *
 * This file owns the RUN-LOOP + DISPATCH (`executeAutomationFlow`,
 * `handleAutomationExecute`, `evaluateCondition`, `computePathTaken`) plus a
 * handful of tiny top-level helpers (`resolveExecutionActor`, `shouldRunFlow`,
 * `buildRunDefinitionSnapshot`). Every step-family executor, the retry-safety
 * floor, template resolution, and the query DSL live in co-located modules
 * (`steps/*.ts`, `retry-safety.ts`, `template-resolve.ts`, `query-dsl.ts`,
 * `graph-topology.ts`, `capability-dispatch.ts`) and are re-exported below so
 * every existing `from "./automation-executor.js"` import keeps working
 * unchanged.
 */

import { randomUUID } from "crypto";
import {
  db,
  eq,
  and,
  isNull,
  automations,
  automationRuns,
  automationStepRuns,
  automationClaims,
  users,
  focusSessions,
  drizzleSql,
  openRunSession,
} from "@synap/database";
import type {
  FlowDefinition,
  AutomationEdge,
  NodeErrorHandling,
  CommandNodeDef,
  OutputNodeDef,
  GuardNodeDef,
  RunPathTaken,
} from "@synap/database";
import {
  beginStepDiagnostics,
  UNRESOLVED_REFS_KEY,
  type UnresolvedReferenceCollector,
} from "./unresolved-references.js";
import { getBoss } from "@synap/events";
import {
  postRunSummary,
  resolveRunChannel,
} from "../utils/post-run-summary.js";
import { subjectEntityIdFromPayload } from "../utils/run-subject.js";
import { RUN_NOT_DELAY_SUSPENDED } from "./automation-run-reaper.js";
import {
  beginAiUsageCapture,
  type AiUsageCollector,
} from "@synap/intelligence-client";
import { logger } from "./automation-executor-logger.js";

import {
  topoSort,
  getOutEdges,
  markDescendantsSkipped,
  computeLoopBodyNodeIds,
  collectLoopBindingRefs,
} from "./graph-topology.js";
import {
  seedResumeState,
  seedPruningState,
  decideStepRetry,
  assessNodeRetrySafety,
} from "./retry-safety.js";
import {
  resolveTemplate,
  deepResolveTemplates,
  resolveInputMapping,
} from "./template-resolve.js";
import { resolveReferencePath } from "./context-path.js";
import { evaluateCondition } from "./condition-eval.js";
import {
  executeCommandStep,
  executeSkillNode,
  executeCapabilityNode,
} from "./steps/command-skill-capability.js";
import { executeOutputStep } from "./steps/output.js";
import { executeTransformStep } from "./steps/transform.js";
import { executeFetchStep } from "./steps/fetch.js";
import { executeQueryStep } from "./steps/query.js";
import {
  executeEntityReadStep,
  executeRelatedEntitiesStep,
  executeClaimStep,
} from "./steps/entity-lookup.js";
import {
  executeGuardStep,
  executeComputeStep,
  executeSelectStep,
} from "./steps/control-flow.js";
import { executeMessagesQueryStep } from "./steps/messages-query.js";
import {
  executeRunsQueryStep,
  executeProposalsQueryStep,
} from "./steps/ledger-query.js";
import { executePlaybookRun } from "./steps/playbook-run.js";

import type {
  ExecutionPayload,
  StepContext,
} from "./automation-executor-types.js";

// ── Backward-compat re-exports ───────────────────────────────────────────────
// Every symbol this file used to define directly and export now lives in one
// of the co-located modules above. Re-exporting here means every existing
// `from "./automation-executor.js"` import (tests, sibling workers, and the
// production `await import("@synap/jobs/workers/automation-executor.js")` boot
// wiring in apps/api) keeps working unchanged.
export type {
  ExecutionPayload,
  StepContext,
  LedgerStepRow,
} from "./automation-executor-types.js";
export {
  topoSort,
  markDescendantsSkipped,
  computeLoopBodyNodeIds,
  collectLoopBindingRefs,
} from "./graph-topology.js";
export {
  seedResumeState,
  seedPruningState,
  decideStepRetry,
  assessNodeRetrySafety,
  type StepRetryDecision,
  type NodeRetrySafety,
} from "./retry-safety.js";
export {
  resolveTemplate,
  matchWholeStringReference,
  deepResolveTemplates,
} from "./template-resolve.js";
export { evaluateCondition } from "./condition-eval.js";
export {
  registerCapabilityExecutor,
  registerPlaybookRunner,
  type CapabilityExecutorInput,
  type PlaybookRunnerChainContext,
  type PlaybookRunnerInput,
  type PlaybookRunnerResult,
} from "./capability-dispatch.js";
export { executeOutputStep } from "./steps/output.js";
export { executeTransformStep } from "./steps/transform.js";
export { executeMessagesQueryStep } from "./steps/messages-query.js";
export {
  resolveQueryProfileSlug,
  parseQueryFilterConditions,
  parseQueryOrderBy,
  type QueryPropertyCondition,
  type QueryColumnCondition,
  type QueryCondition,
  type QueryOrderBy,
} from "./query-dsl.js";
export { executeGuardStep, executeSelectStep } from "./steps/control-flow.js";
export {
  parseMultiValueField,
  RUN_STATUS_VALUES,
  PROPOSAL_STATUS_VALUES,
  narrowStatuses,
  resolveSinceFilter,
} from "./steps/ledger-query.js";

/** Manual workflow writes act as the member who started the run; unattended
 * system/automation runs retain the automation owner as their authorized actor. */
export function resolveExecutionActor(
  triggeredBy: string | null | undefined,
  ownerId: string
): string {
  return typeof triggeredBy === "string" &&
    triggeredBy !== "system" &&
    triggeredBy !== "automation"
    ? triggeredBy
    : ownerId;
}

/**
 * Wave 4.V3 flow precondition: decide whether a run may proceed. Returns true
 * when there is no precondition (always run) or the precondition expression
 * evaluates true against the run context; false → the run finalizes `skipped`
 * before any step executes. Pure (delegates to the SAME `evaluateCondition`
 * grammar the condition node uses) so it can be unit-tested.
 *
 * A precondition that cannot be parsed throws (evaluateCondition is fail-closed)
 * — surfaced to the caller as a run failure, never silently treated as "run".
 */
export function shouldRunFlow(
  precondition: string | undefined,
  context: StepContext
): boolean {
  if (!precondition || !precondition.trim()) return true;
  return evaluateCondition(precondition, context);
}

/** Build the immutable execution contract stamped onto every new run. */
export function buildRunDefinitionSnapshot(
  version: number,
  flowDefinition: FlowDefinition
): { version: number; flowDefinition: FlowDefinition } {
  return { version, flowDefinition };
}

// ── Main Executor ───────────────────────────────────────────────────────────

/**
 * Core execution logic: walk the DAG and execute each step.
 * Extracted so sub_automation nodes can call it recursively.
 */
async function executeAutomationFlow(params: {
  automationId: string;
  runId: string;
  workspaceId: string;
  ownerId: string;
  payload: Record<string, unknown>;
  automationContext: ExecutionPayload["automationContext"];
  completedNodeIds?: string[];
  /** CONFUSED-DEPUTY GUARD: the causal-chain producer (see ExecutionPayload).
   *  Forwarded to `executeOutputStep` → `checkAutomationWriteOrPropose` so an
   *  agent-produced trigger governs a human-owned automation's THEN-actions.
   *  Inherited by `sub_automation` children — the chain is unbroken. */
  producerAgentUserId?: string | null;
}): Promise<Record<string, unknown>> {
  const {
    runId,
    automationId,
    workspaceId,
    ownerId,
    automationContext,
    completedNodeIds,
    producerAgentUserId,
  } = params;
  const alreadyCompleted = new Set(completedNodeIds ?? []);

  // Load automation definition
  const automation = await db.query.automations.findFirst({
    where: eq(automations.id, automationId),
  });

  if (!automation) {
    logger.error({ automationId }, "Automation not found for execution");
    await db
      .update(automationRuns)
      .set({
        status: "failed",
        errorMessage: "Automation not found",
        completedAt: new Date(),
      })
      .where(eq(automationRuns.id, runId));
    return {};
  }

  // Load run for trigger payload
  const run = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.id, runId),
  });

  if (!run) {
    logger.error({ runId }, "Automation run not found");
    return {};
  }
  // Manual runs execute under the authenticated workspace member who started
  // them. Scheduled/system runs retain the automation owner. This keeps the
  // generic workflow engine domain-agnostic while allowing shared workspaces
  // to update records created by another member through the normal write gate.
  const actingUserId = resolveExecutionActor(run.triggeredBy, ownerId);

  const flow = automation.flowDefinition as FlowDefinition;

  // `definitionSnapshot` unset is the exact "this is the run's FIRST execution"
  // signal (robust against BOTH delay-resume AND crash-redelivery, where
  // job.data is the original with completedNodeIds/focusSessionId unset) —
  // consumed by the precondition gate, then flipped by the snapshot stamp.
  const isFirstExecution = !run.definitionSnapshot;

  // ── Flow-level precondition (Wave 4.V3) ────────────────────────────────────
  // Evaluate BEFORE opening a session or running any step, so a precondition-
  // gated run finalizes `skipped` (honestly distinct from a `completed` run that
  // did work) without a single side effect. ONLY on the run's first execution
  // (isFirstExecution) — never on a delay-resume or crash-redelivery re-entry,
  // which have already passed the gate and may have run steps. The context here
  // is the trigger payload + the automation's snapshot state — the same values a
  // `condition` node reads.
  //
  // Ordering constraint: this gate MUST evaluate before the standalone snapshot
  // stamp below. A false verdict writes the snapshot and terminal status in ONE
  // update, so a skipped run still records what was evaluated without creating
  // a crash window in which a later delivery could execute it.
  if (isFirstExecution && flow.precondition) {
    const preconditionContext: StepContext = {
      trigger: {
        payload: (run.triggerPayload as Record<string, unknown>) ?? {},
      },
      steps: {},
      automation: {
        id: automation.id,
        state: (automation.state as Record<string, unknown> | null) ?? {},
      },
    };
    // shouldRunFlow throws on an unparseable precondition (fail-closed) — that
    // propagates out and the pg-boss handler's defensive finalizer marks the run
    // failed, never a silent "run".
    if (!shouldRunFlow(flow.precondition, preconditionContext)) {
      logger.info(
        { runId, automationId, precondition: flow.precondition },
        "Automation precondition evaluated false — finalizing run as skipped"
      );

      // Guarded on status='running' (same invariant the finalizer/reaper use).
      // Snapshot + verdict are atomic: observability never has to substitute the
      // automation's current definition for a skipped run.
      const [skippedRun] = await db
        .update(automationRuns)
        .set({
          definitionSnapshot: buildRunDefinitionSnapshot(
            automation.version,
            flow
          ),
          status: "skipped",
          completedAt: new Date(),
        })
        .where(
          and(
            eq(automationRuns.id, runId),
            eq(automationRuns.status, "running"),
            isNull(automationRuns.definitionSnapshot)
          )
        )
        .returning({ id: automationRuns.id });
      // Quiet narration: the `skipped` run row IS the record (surfaced in the
      // runs UI); postRunSummary short-circuits a skipped run (no chat summary).
      // Only the invocation that atomically wrote the verdict may finalize it.
      // A duplicate delivery that lost the first-write guard exits quietly.
      if (skippedRun) await postRunSummary(runId);
      return {};
    }
  }

  // D3c: snapshot the definition this run executed, once at first execution
  // (and only AFTER the precondition gate passed — see ordering note above).
  // Guarded on the existing value so a delay-resumption re-entry (same runId)
  // never re-stamps.
  if (isFirstExecution) {
    await db
      .update(automationRuns)
      .set({
        definitionSnapshot: buildRunDefinitionSnapshot(
          automation.version,
          flow
        ),
      })
      .where(
        and(
          eq(automationRuns.id, runId),
          isNull(automationRuns.definitionSnapshot)
        )
      );
  }

  // ── Open (or resume) a focus session for this run ──────────────────────────
  // Every non-playbook-delegate automation run gets a session so all proposals
  // it creates carry the session's id and group under one reviewable card, and
  // the automation's data lives ON the session (openRunSession's contract).
  //
  // A "playbook-delegate" automation is the single-node `playbook_run` flow
  // shape `buildPlaybookRunFlowDefinition` produces (e.g. a scheduled
  // playbook's backing cron automation) — `executePlaybookRun` already opens
  // its OWN session for that case, so we must not double-open here.
  const isPlaybookDelegate =
    flow.nodes.length === 1 && flow.nodes[0]?.type === "playbook_run";

  // `focusSessionId`/`focusSessionOwned` arrive already-set on `automationContext`
  // when this call is a delay-resumption of an in-flight run (see the "delay"
  // node case below) — reuse rather than reopen. Deliberately NOT inherited by
  // `sub_automation` children (they spread the raw `automationContext`, not
  // `runContext`) — each chained automation run is its own reviewable unit.
  let runSessionId = automationContext.focusSessionId;
  let sessionOwned = automationContext.focusSessionOwned ?? false;
  let runSuspended = false;

  if (!isPlaybookDelegate && !runSessionId) {
    const [ownerUser] = await db
      .select({ userType: users.userType })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);

    // Channel resolution — the ONE door shared with the run-narration path
    // (`resolveRunChannel`), switching on `metadata.resultRouting`: a per-entity
    // automation lands each run in its subject's own channel; otherwise an
    // explicit trigger-bound channel wins (e.g. a Discord-triggered automation
    // posts back to its source channel); otherwise THE automation's durable
    // per-type run channel so every run's activity lands in one room.
    const boundChannelId = await resolveRunChannel(automation, run);

    const opened = await openRunSession({
      userId: ownerId,
      workspaceId,
      goal: automation.name || `Automation run ${runId}`,
      source: "automation",
      automationId,
      automationRunId: runId,
      channelId: boundChannelId,
      agentUserId: ownerUser?.userType === "agent" ? ownerId : undefined,
    });
    runSessionId = opened.sessionId;
    sessionOwned = !opened.reused;
  }

  // Downstream propose calls and the delay-resumption re-enqueue thread THIS —
  // never the raw `automationContext` — so proposals carry the session id.
  const runContext: ExecutionPayload["automationContext"] = {
    ...automationContext,
    focusSessionId: runSessionId,
    focusSessionOwned: sessionOwned,
  };

  const closeSessionIfOwned = async (): Promise<void> => {
    if (sessionOwned && runSessionId && !runSuspended) {
      await db
        .update(focusSessions)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(focusSessions.id, runSessionId));
    }
  };

  if (!flow.nodes.length) {
    logger.warn({ automationId }, "Automation has no nodes — marking complete");
    await db
      .update(automationRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(automationRuns.id, runId));
    // Genuine finish (trivially) — close a freshly-opened session.
    await closeSessionIfOwned();
    // Narrate the terminal run (idempotent, non-throwing — Wave 3.N1).
    await postRunSummary(runId);
    return {};
  }

  // Sort nodes topologically
  const sortedNodes = topoSort(flow.nodes, flow.edges);
  // Fail LOUD on a cycle: Kahn's algorithm cannot order nodes in a cycle, so
  // they are dropped from `sortedNodes` and would otherwise silently never run.
  if (sortedNodes.length < flow.nodes.length) {
    const ordered = new Set(sortedNodes.map((n) => n.id));
    const cyclic = flow.nodes
      .filter((n) => !ordered.has(n.id))
      .map((n) => n.id);
    // Nothing will run — close a freshly-opened session before failing loud so
    // an unrunnable flow never leaks an orphaned active session.
    await closeSessionIfOwned();
    throw new Error(
      `Automation flow has a cycle — these nodes cannot be ordered and would never run: ${cyclic.join(", ")}`
    );
  }

  // Safety net: anything below that throws WITHOUT going through the per-node
  // retry/catch (e.g. an infra failure in a db update between nodes) must not
  // leak an orphaned active session — close it, then rethrow unchanged.
  try {
    return await executeSortedNodes();
  } catch (err) {
    await closeSessionIfOwned();
    throw err;
  }

  async function executeSortedNodes(): Promise<Record<string, unknown>> {
    // TS control-flow narrowing on `automation`/`run` (checked non-null above)
    // doesn't cross into this nested function's closure — assert locally.
    const loadedAutomation = automation!;
    const loadedRun = run!;
    // Build execution context
    const context: StepContext = {
      trigger: {
        payload: (loadedRun.triggerPayload as Record<string, unknown>) ?? {},
      },
      steps: {},
      // Snapshot of the automation's persistent state at trigger time. A
      // `set_state` output node merges changes back onto the row (see
      // executeOutputStep); the snapshot here is what templates read for this run.
      automation: {
        id: loadedAutomation.id,
        state: (loadedAutomation.state as Record<string, unknown> | null) ?? {},
      },
    };

    // Resume-from-ledger (Wave 4.R): reconstruct progress from the DURABLE step
    // ledger, not just job.data. A crash-redelivered job arrives with the
    // ORIGINAL job.data (completedNodeIds undefined), so we must load THIS run's
    // completed step rows to know what already ran — otherwise every side effect
    // re-executes (F1). Union them into `alreadyCompleted` (skips finished nodes
    // below) and rebuild the prior-output context (what later steps read). A
    // fresh run has no completed rows yet → this is a no-op.
    const ledgerRows = await db
      .select()
      .from(automationStepRuns)
      .where(eq(automationStepRuns.runId, runId));

    const seeded = seedResumeState(completedNodeIds, ledgerRows);
    for (const nodeId of seeded.completed) alreadyCompleted.add(nodeId);
    for (const [nodeId, entry] of Object.entries(seeded.priorSteps)) {
      context.steps[nodeId] = entry;
    }

    // Track which nodes to skip (condition branches not taken), and the edges on
    // an untaken condition/switch branch. A node is only pruned when ALL its
    // incoming edges are dead (pruned or from a skipped source) — this is what
    // keeps a join/merge node reachable from the TAKEN branch alive (diamond fix).
    //
    // SEEDED from the ledger's `skipped` rows and the run's stored `pathTaken`:
    // the condition node that pruned is `completed`, so a resumed pass never
    // re-derives its decision. Starting these empty made a pruned node execute
    // after a delay resumption — side effects on a branch the run rejected.
    const { skippedNodes, prunedEdges } = seedPruningState(
      flow.edges,
      seeded.skipped,
      loadedRun.pathTaken
    );
    let stepsCompleted = 0;
    let stepsFailed = 0;

    /**
     * Persist WHICH PATH this run took (D3d) — the one write of the branch
     * decisions the executor alone knows. Called at BOTH terminal points of the
     * node walk (the delay suspension AND the final status update, which a
     * fail-fast `break` also falls through to), so a run that dies midway still
     * stores whatever was decided before it died.
     *
     * Union-merged onto whatever the previous invocation stored (delay resume).
     * Non-throwing: this is a record of the run, never a reason to fail one.
     */
    const persistPathTaken = async (): Promise<void> => {
      try {
        const executedNodeIds = new Set<string>([
          ...alreadyCompleted,
          ...Object.keys(context.steps),
          ...sortedNodes.filter((n) => n.type === "trigger").map((n) => n.id),
        ]);
        const pathTaken = computePathTaken(
          flow.edges,
          prunedEdges,
          executedNodeIds,
          loadedRun.pathTaken
        );
        await db
          .update(automationRuns)
          .set({ pathTaken })
          .where(eq(automationRuns.id, runId));
      } catch (err) {
        logger.warn({ err, runId }, "Failed to persist automation run path");
      }
    };

    /**
     * Persist a step's unresolved-reference diagnostics (D-ref). Merged INTO
     * `resolved_inputs` under a reserved key rather than a new column: no
     * migration, and it sits exactly where a UI already looks for "what did
     * this step read". jsonb `||` merges server-side so it cannot clobber the
     * resolvedInputs a node wrote earlier in its own execution, whatever the
     * ordering.
     *
     * NOT written to `output`: the resume-from-ledger path rebuilds later
     * steps' context from `output`, so anything added there would leak into the
     * flow's data.
     *
     * Non-throwing and no-op when clean — a diagnostic is never a reason to
     * fail a run.
     */
    const persistStepDiagnostics = async (
      stepRunId: string,
      collector: UnresolvedReferenceCollector,
      nodeId: string
    ): Promise<void> => {
      if (collector.size === 0) return;
      const refs = collector.list();
      logger.warn(
        { runId, nodeId, unresolvedRefs: refs },
        "Automation step resolved references to nothing"
      );
      try {
        await db
          .update(automationStepRuns)
          // postgres.js `sql.json()` is broken on the pod image — JSON.stringify
          // + an explicit ::jsonb cast is the house pattern.
          .set({
            resolvedInputs: drizzleSql`coalesce(${automationStepRuns.resolvedInputs}, '{}'::jsonb) || ${JSON.stringify(
              { [UNRESOLVED_REFS_KEY]: refs }
            )}::jsonb`,
          })
          .where(eq(automationStepRuns.id, stepRunId));
      } catch (err) {
        logger.warn(
          { err, runId, nodeId },
          "Failed to persist step reference diagnostics"
        );
      }
    };

    /**
     * The AI-telemetry columns for a step row, or `{}` when the step made no IS
     * generation. Merged into the SAME `.set()` that closes the step so there is
     * no second UPDATE and no ordering hazard — and merged on BOTH the completed
     * and the failed branch, because an empty/truncated generation is precisely
     * the case whose `finish_reason` is the whole answer.
     *
     * Every field stays NULL when the provider reported nothing. Never a
     * fabricated 0.
     */
    const aiUsageColumns = (
      collector: AiUsageCollector
    ): {
      tokensIn?: number | null;
      tokensOut?: number | null;
      tokensUsed?: number | null;
      finishReason?: string | null;
    } => {
      if (collector.size === 0) return {};
      const t = collector.totals();
      return {
        tokensIn: t.tokensIn,
        tokensOut: t.tokensOut,
        tokensUsed: t.tokensTotal,
        finishReason: t.finishReason,
      };
    };

    for (const node of sortedNodes) {
      // Skip trigger node (already fired)
      if (node.type === "trigger") continue;

      // Skip already-completed nodes (delay resumption)
      if (alreadyCompleted.has(node.id)) continue;

      // Skip if this node was excluded by a condition branch. Record the
      // decision ONCE: a node an earlier pass already wrote a `skipped` row for
      // is being re-derived from that row here, not newly decided.
      if (skippedNodes.has(node.id)) {
        if (!seeded.skipped.has(node.id)) {
          await db.insert(automationStepRuns).values({
            runId,
            nodeId: node.id,
            status: "skipped",
          });
        }
        continue;
      }

      // Create step run record
      const [stepRun] = await db
        .insert(automationStepRuns)
        .values({
          runId,
          nodeId: node.id,
          commandId:
            node.type === "command"
              ? ((node.data as Record<string, unknown>).commandId as
                  string | undefined)
              : undefined,
          status: "running",
          startedAt: new Date(),
        })
        .returning({ id: automationStepRuns.id });

      // Open this step's unresolved-reference scope. Every `{{...}}` the node
      // resolves from here until the next node opens its own — including inside
      // loop bodies and array-pipe predicates — is attributed to THIS step.
      // Recording only; nothing here can fail or skip a step.
      const stepDiagnostics = beginStepDiagnostics();

      // Open this step's AI-usage scope. Any IS generation this node makes —
      // including inside a loop body or a retry — is attributed to THIS step and
      // drained onto its row below (success AND failure: an empty generation is
      // exactly the case whose finish reason we need). Recording only; nothing
      // here can fail or skip a step.
      const aiUsage = beginAiUsageCapture();

      // Resolve per-node error handling config
      const nodeErrorHandling = ((node.data as Record<string, unknown>)
        .errorHandling ?? {}) as NodeErrorHandling;
      const requestedRetries = Math.min(
        Math.max(Number(nodeErrorHandling.maxRetries ?? 0), 0),
        3
      );
      // RETRY-SAFETY FLOOR. A stored `errorHandling.maxRetries` may NARROW the
      // retry budget, never widen it past what the node's effect can survive:
      // re-running an un-receipted outbound/irreversible step is a double-send,
      // which is precisely why the JOB-level `retryLimit` is already 0. The
      // floor lives here (not only in an author-time validator) because a flow
      // authored, seeded or imported before any check exists still runs through
      // this loop. See `assessNodeRetrySafety` for the per-type reasoning.
      const retrySafety = assessNodeRetrySafety(node, {
        nodes: flow.nodes,
        edges: flow.edges,
      });
      if (requestedRetries > 0 && !retrySafety.safe) {
        logger.warn(
          {
            nodeId: node.id,
            nodeType: node.type,
            requestedRetries,
            reason: retrySafety.reason,
          },
          "Automation step declares maxRetries but is NOT retry-safe — flooring to 0 (retrying it risks a duplicate irreversible effect)"
        );
      }
      const maxRetries = retrySafety.safe ? requestedRetries : 0;
      const retryDelay = Math.max(Number(nodeErrorHandling.retryDelay ?? 0), 0);
      const continueOnError = nodeErrorHandling.continueOnError === true;

      let lastError: unknown = undefined;
      let succeeded = false;
      let output: unknown = {};

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          // Wait before retry
          if (retryDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
          }
          logger.info(
            { nodeId: node.id, attempt, maxRetries },
            "Retrying automation step"
          );
        }

        try {
          // LOOP-BINDING GUARD. `context.loop` exists ONLY while a loop
          // dispatches its body (it is deleted right after), so a node that
          // reaches THIS pass with a `{{loop.*}}` reference can never resolve
          // it — it is outside every loop's body (no edge from the loop, a
          // boundary node type between them, or an empty loop that leaked).
          // Left unguarded that resolves to `undefined`: a Zod
          // "expected string, received undefined" at best, and at worst a junk
          // entity/relation written with empty ids. Fail the STEP with the
          // actionable cause instead of letting undefined propagate.
          if (!context.loop) {
            const loopRefs = collectLoopBindingRefs(node.data);
            if (loopRefs.length > 0) {
              throw new Error(
                `Node "${node.id}" (${node.type}) references ${loopRefs
                  .map((r) => `\`${r}\``)
                  .join(
                    ", "
                  )} but is not inside a loop body, so there is no item to bind. Connect it downstream of a loop node (with no switch/delay/nested-loop node in between), or stop referencing {{loop.*}}.`
              );
            }
          }

          switch (node.type) {
            case "command": {
              const data = node.data as {
                commandId?: string;
                commandTitle?: string;
                inputMapping: Record<string, string>;
                promptOverride?: string;
              };

              const resolvedInputs = resolveInputMapping(
                data.inputMapping ?? {},
                context
              );

              await db
                .update(automationStepRuns)
                .set({ resolvedInputs })
                .where(eq(automationStepRuns.id, stepRun.id));

              // FOLLOW-UP (Wave 3b firewall): `intelligence_commands` has no
              // `approved` column, so there is no per-capability approval-state to
              // gate the command run on here. The command runs an IS task whose
              // pod write-backs remain proposal-governed, and any provider call it
              // makes funnels through Site 1's gate (triggerProviderAction). Full
              // capability-grant/exec-mode gating for commands awaits the gate
              // helper being extracted to a shared package (jobs cannot import
              // @synap/api — circular dep).
              output = await executeCommandStep(
                data,
                context,
                workspaceId,
                ownerId,
                producerAgentUserId
              );
              break;
            }

            case "condition": {
              const data = node.data as { expression: string };
              const result = evaluateCondition(data.expression, context);
              output = { result };

              // Mark nodes on the untaken branch as skipped
              const untakenHandle = result ? "no" : "yes";

              const untakenEdges = getOutEdges(
                flow.edges,
                node.id,
                untakenHandle
              );
              for (const edge of untakenEdges) prunedEdges.add(edge);
              for (const edge of untakenEdges) {
                markDescendantsSkipped(
                  edge.target,
                  flow.edges,
                  skippedNodes,
                  prunedEdges
                );
              }
              break;
            }

            case "delay": {
              const data = node.data as { duration: string };
              const delayMs = parseDuration(data.duration);
              const resumeAt = new Date(Date.now() + delayMs);

              logger.info(
                {
                  nodeId: node.id,
                  duration: data.duration,
                  resumeAt: resumeAt.toISOString(),
                },
                "Delay step — re-enqueueing with startAfter"
              );

              // Record this step as completed
              output = {
                status: "delayed",
                duration: data.duration,
                resumeAfter: resumeAt.toISOString(),
              };

              // Collect all completed node IDs up to this point
              const completedSoFar = [
                ...alreadyCompleted,
                ...sortedNodes
                  .filter((n) => n.type === "trigger" || context.steps[n.id])
                  .map((n) => n.id),
                node.id,
              ];

              // Re-enqueue the rest of the DAG with startAfter — carry runContext
              // (not the raw automationContext) so the resumed invocation reuses
              // this run's session instead of opening a second one.
              const boss = getBoss();
              await boss.send(
                "automation-execute",
                {
                  runId,
                  automationId,
                  workspaceId,
                  automationContext: runContext,
                  completedNodeIds: completedSoFar,
                  // CONFUSED-DEPUTY GUARD: carry the causal-chain producer across
                  // the delay boundary. Omitting it made the resumed invocation
                  // read `producerAgentUserId` as undefined → the guard saw no
                  // producer → an agent-produced trigger's post-delay THEN-actions
                  // auto-executed ungoverned under the human owner. Thread it so a
                  // `trigger → delay → entity_create` still PROPOSES after resume.
                  producerAgentUserId,
                },
                { startAfter: resumeAt }
              );
              // Suspended, not finished — leave the session open across the delay.
              runSuspended = true;

              // Mark step as completed and return early — execution will resume after delay
              context.steps[node.id] = { output };
              stepsCompleted++;

              await db
                .update(automationStepRuns)
                // jsonb column accepts any JSON; cast satisfies the Record type.
                .set({
                  status: "completed",
                  output: output as Record<string, unknown>,
                  completedAt: new Date(),
                })
                .where(eq(automationStepRuns.id, stepRun.id));

              // Update run to show partial progress
              await db
                .update(automationRuns)
                .set({ stepsCompleted })
                .where(eq(automationRuns.id, runId));

              // Freeze the branch decisions made BEFORE the suspension — the
              // resumed invocation unions its own on top.
              await persistPathTaken();
              // The delay node exits the walk early — drain its diagnostics
              // here or they are lost with the suspension.
              await persistStepDiagnostics(
                stepRun.id,
                stepDiagnostics,
                node.id
              );

              return {}; // Exit — execution resumes after delay
            }

            case "output": {
              const data = node.data as {
                label?: string;
                outputType: string;
                config: Record<string, unknown>;
              };

              const resolvedConfig = deepResolveTemplates(
                data.config,
                context
              ) as Record<string, unknown>;

              await db
                .update(automationStepRuns)
                .set({ resolvedInputs: resolvedConfig })
                .where(eq(automationStepRuns.id, stepRun.id));

              output = await executeOutputStep(
                data,
                context,
                workspaceId,
                runContext,
                ownerId,
                actingUserId,
                { nodeId: node.id, stepRunId: stepRun.id },
                run?.subjectEntityId,
                producerAgentUserId
              );
              break;
            }

            case "loop": {
              const data = node.data as {
                iteratorExpression: string;
                itemVariable: string;
              };

              // Resolve the collection to iterate over
              const collection = resolveReferencePath(
                data.iteratorExpression,
                context
              );
              const rawItems = Array.isArray(collection) ? collection : [];
              // Hard cap loop width. A loop child may be `playbook_run` (each spawns
              // a session + IS dispatch), and the iterator is an arbitrary context
              // path (could resolve a large fetch/trigger array) — without a cap a
              // single run could fan out into thousands of paid IS dispatches.
              // Aligned with the query-node limit (100).
              const MAX_LOOP_ITERATIONS = 100;
              const items = rawItems.slice(0, MAX_LOOP_ITERATIONS);
              if (rawItems.length > MAX_LOOP_ITERATIONS) {
                logger.warn(
                  {
                    nodeId: node.id,
                    requested: rawItems.length,
                    cap: MAX_LOOP_ITERATIONS,
                  },
                  "loop: iteration count exceeds cap — truncating"
                );
              }

              // The loop owns the CONTIGUOUS chain of SUPPORTED body nodes reachable
              // from it (LOOP_BODY_NODE_TYPES) — traversal STOPS at any node type
              // NOT in that set (switch, delay, a nested loop, sub_automation, …).
              // Those are BOUNDARIES: not owned by the loop, so they are neither
              // dispatched per-item nor marked skipped — they run ONCE in the main
              // topological pass. `condition`/`skill`/`capability` ARE body types:
              // a per-item `condition` filters this item (continue-semantics), and
              // skill/capability dispatch per item (MAX_LOOP_ITERATIONS caps the
              // paid IS/provider fan-out). This keeps a per-item body (e.g.
              // messages_query → condition → skill → entity_create) working while
              // never silently dropping downstream branch/merge/post-loop logic.
              // Computed BEFORE the empty-collection check because both the empty
              // and non-empty paths must suppress these nodes from the main pass.
              const bodyNodeIds = computeLoopBodyNodeIds(
                flow.nodes,
                flow.edges,
                node.id
              );

              // A loop that owns NOTHING is authoring breakage, not a no-op: the
              // per-item pass dispatches zero children (fast + green) while every
              // node that was MEANT to be the body leaks into the main pass with
              // no `context.loop`. Surfaced in the log and in the step output
              // (`bodyNodeCount`) so a run that "succeeded in 2ms" is legible.
              if (bodyNodeIds.size === 0) {
                logger.warn(
                  {
                    nodeId: node.id,
                    itemCount: items.length,
                  },
                  "loop: no body nodes reachable — the loop will dispatch nothing (check the loop's out-edges / that the body node types are loop-dispatchable)"
                );
              }

              // Empty collection: the loop dispatches nothing — but its body nodes
              // must STILL be suppressed from the main topological pass, exactly as
              // on the non-empty path (see the `skippedNodes` population after the
              // per-item loop). Without this, an empty loop leaks each body node into
              // the main pass, where it runs ONCE with no `context.loop` — resolving
              // `loop.item.*` to undefined (Zod errors, and worse: junk entities /
              // relations written with empty ids). Mark-then-break keeps the empty
              // path consistent with the non-empty one.
              if (items.length === 0) {
                for (const childId of bodyNodeIds) {
                  skippedNodes.add(childId);
                }
                output = {
                  status: "empty_collection",
                  itemCount: 0,
                  bodyNodeCount: bodyNodeIds.size,
                };
                break;
              }
              // Already topologically sorted — filter preserves the order so a
              // child's inputs (earlier nodes in the chain) run before it.
              const bodyNodes = sortedNodes.filter((n) =>
                bodyNodeIds.has(n.id)
              );

              // Execute the body subgraph for each item
              const iterationResults: unknown[] = [];
              for (let i = 0; i < items.length; i++) {
                // Set loop context
                context.loop = { item: items[i], index: i };

                // When a per-item `condition` filters THIS item out, we skip the
                // remaining body nodes for this item ONLY (continue the outer
                // for-loop). Signalled by this flag rather than a labeled break so
                // the per-item error handling (try/catch) stays intact.
                let itemFiltered = false;

                for (const childNode of bodyNodes) {
                  try {
                    let childOutput: unknown = {};

                    switch (childNode.type) {
                      case "command":
                        childOutput = await executeCommandStep(
                          childNode.data as CommandNodeDef["data"],
                          context,
                          workspaceId,
                          ownerId,
                          producerAgentUserId
                        );
                        break;
                      case "output":
                        childOutput = await executeOutputStep(
                          childNode.data as OutputNodeDef["data"],
                          context,
                          workspaceId,
                          runContext,
                          ownerId,
                          actingUserId,
                          { nodeId: childNode.id, stepRunId: stepRun.id },
                          run?.subjectEntityId,
                          producerAgentUserId
                        );
                        break;
                      case "condition": {
                        // PER-ITEM FILTER (continue-semantics). Evaluate the
                        // condition against THIS item's context and, when false,
                        // skip the rest of THIS item's body — do NOT touch
                        // `skippedNodes` (that is the main-pass path that prunes
                        // for the WHOLE run). Nodes AFTER the condition in the body
                        // chain simply don't run for this item.
                        const { expression } = childNode.data as {
                          expression: string;
                        };
                        const result = evaluateCondition(expression, context);
                        childOutput = { result };
                        if (!result) itemFiltered = true;
                        break;
                      }
                      case "skill":
                        childOutput = await executeSkillNode(
                          childNode.data as {
                            skillId?: string;
                            inputMapping?: Record<string, string>;
                          },
                          context,
                          { workspaceId, ownerId, producerAgentUserId }
                        );
                        break;
                      case "capability":
                        childOutput = await executeCapabilityNode(
                          childNode.data as {
                            capabilityId?: string;
                            verbId?: string;
                            inputMapping?: Record<string, string>;
                            connectionSelector?: {
                              connectionId?: string;
                              contextObjectId?: string;
                            };
                            connectionId?: string;
                          },
                          context,
                          { workspaceId, ownerId, producerAgentUserId }
                        );
                        break;
                      case "playbook_run":
                        childOutput = await executePlaybookRun(
                          childNode.data as {
                            playbookId?: string;
                            playbookName?: string;
                            paramsMapping?: Record<string, string>;
                          },
                          context,
                          workspaceId,
                          ownerId,
                          automationContext,
                          producerAgentUserId
                        );
                        break;
                      case "messages_query":
                        childOutput = await executeMessagesQueryStep(
                          childNode.data as {
                            subjectEntityId?: string;
                            channelId?: string;
                            limit?: number;
                            scope?: string;
                            channelTypes?: string[];
                            branchPurpose?: string;
                            includeDocuments?: boolean;
                          },
                          context,
                          workspaceId
                        );
                        break;
                      case "runs_query":
                        childOutput = await executeRunsQueryStep(
                          childNode.data as {
                            automationId?: string;
                            status?: string;
                            since?: string;
                            subjectEntityId?: string;
                            limit?: number;
                            includeSteps?: boolean;
                          },
                          context,
                          workspaceId,
                          ownerId
                        );
                        break;
                      case "proposals_query":
                        childOutput = await executeProposalsQueryStep(
                          childNode.data as {
                            status?: string;
                            targetType?: string;
                            changeType?: string;
                            correlationId?: string;
                            sessionId?: string;
                            proposalIds?: string | string[];
                            since?: string;
                            limit?: number;
                          },
                          context,
                          workspaceId,
                          ownerId
                        );
                        break;
                      case "query":
                        childOutput = await executeQueryStep(
                          childNode.data as {
                            profileSlug?: string;
                            filter?: string | Record<string, unknown>;
                            limit: number;
                            scope?: string;
                            orderBy?: string;
                            orderDir?: string;
                          },
                          context,
                          workspaceId,
                          ownerId
                        );
                        break;
                      case "fetch":
                        childOutput = await executeFetchStep(
                          childNode.data as {
                            method: string;
                            url: string;
                            headers: Record<string, string>;
                            body: string;
                          },
                          context,
                          ownerId
                        );
                        break;
                      case "transform":
                        childOutput = executeTransformStep(
                          childNode.data as { expression: string },
                          context
                        );
                        break;
                      default:
                        throw new Error(
                          `Loop child node type "${childNode.type}" is not supported inside a loop`
                        );
                    }

                    iterationResults.push({
                      iteration: i,
                      nodeId: childNode.id,
                      output: childOutput,
                    });

                    // Store under BOTH the per-iteration key AND the plain id, so
                    // a later node in the SAME iteration can reference it as
                    // {{steps.<id>.output...}} (the natural authoring form).
                    context.steps[`${childNode.id}_iter${i}`] = {
                      output: childOutput,
                    };
                    context.steps[childNode.id] = { output: childOutput };

                    // Per-item filter tripped false → skip the rest of THIS item's
                    // body (the condition's output is already recorded above).
                    if (itemFiltered) break;
                  } catch (err) {
                    logger.error(
                      { err, nodeId: childNode.id, iteration: i },
                      "Loop child step failed"
                    );
                    iterationResults.push({
                      iteration: i,
                      nodeId: childNode.id,
                      error: err instanceof Error ? err.message : "unknown",
                    });
                    // The body is a dependent chain — abort the rest of THIS
                    // item's steps and move to the next item.
                    break;
                  }
                }
              }

              // Clear loop context
              delete context.loop;

              // Mark body nodes as completed so the main loop skips them
              for (const childId of bodyNodeIds) {
                skippedNodes.add(childId);
              }

              output = {
                status: "completed",
                itemCount: items.length,
                bodyNodeCount: bodyNodeIds.size,
                results: iterationResults,
              };
              break;
            }

            case "transform": {
              const data = node.data as { expression: string };
              output = executeTransformStep(data, context);
              break;
            }

            case "fetch": {
              const data = node.data as {
                method: string;
                url: string;
                headers: Record<string, string>;
                body: string;
              };
              output = await executeFetchStep(data, context, ownerId);
              break;
            }

            case "query": {
              const data = node.data as {
                profileSlug?: string;
                filter?: string | Record<string, unknown>;
                limit: number;
                scope?: string;
                orderBy?: string;
                orderDir?: string;
              };
              output = await executeQueryStep(
                data,
                context,
                workspaceId,
                ownerId
              );
              break;
            }

            case "entity_read": {
              output = await executeEntityReadStep(
                node.data as { entityId: string },
                context,
                workspaceId,
                ownerId
              );
              break;
            }

            case "related_entities": {
              output = await executeRelatedEntitiesStep(
                node.data as {
                  entityId: string;
                  direction?: "outbound" | "inbound" | "both";
                  relationTypes?: string[];
                  propertyEquals?: Record<string, unknown>;
                  propertyAnyEquals?: Record<string, unknown[]>;
                  excludeEntityId?: string;
                  limit?: number;
                },
                context,
                workspaceId
              );
              break;
            }

            case "guard": {
              output = executeGuardStep(
                node.data as GuardNodeDef["data"],
                context
              );
              break;
            }

            case "compute": {
              output = executeComputeStep(
                node.data as {
                  operation:
                    | "add"
                    | "subtract"
                    | "multiply"
                    | "divide"
                    | "coalesce"
                    | "now";
                  left?: unknown;
                  right?: unknown;
                  values?: unknown[];
                },
                context
              );
              break;
            }

            case "select": {
              output = executeSelectStep(
                node.data as {
                  when: unknown;
                  ifTrue: unknown;
                  ifFalse: unknown;
                },
                context
              );
              break;
            }

            case "claim": {
              output = await executeClaimStep(
                node.data as { namespace: string; key: string },
                context,
                workspaceId,
                runId
              );
              break;
            }

            case "messages_query": {
              const data = node.data as {
                subjectEntityId?: string;
                channelId?: string;
                limit?: number;
                scope?: string;
                channelTypes?: string[];
                branchPurpose?: string;
                includeDocuments?: boolean;
              };
              output = await executeMessagesQueryStep(
                data,
                context,
                workspaceId
              );
              break;
            }

            case "runs_query": {
              output = await executeRunsQueryStep(
                node.data as {
                  automationId?: string;
                  status?: string;
                  since?: string;
                  subjectEntityId?: string;
                  limit?: number;
                  includeSteps?: boolean;
                },
                context,
                workspaceId,
                ownerId
              );
              break;
            }

            case "proposals_query": {
              output = await executeProposalsQueryStep(
                node.data as {
                  status?: string;
                  targetType?: string;
                  changeType?: string;
                  correlationId?: string;
                  sessionId?: string;
                  proposalIds?: string | string[];
                  since?: string;
                  limit?: number;
                },
                context,
                workspaceId,
                ownerId
              );
              break;
            }

            case "switch": {
              const data = node.data as {
                expression: string;
                cases: Array<{ value: string; label: string }>;
              };

              // Resolve the switch expression
              const resolvedValue = resolveTemplate(data.expression, context);

              // Find the matching case
              const matchedCase = (data.cases ?? []).find(
                (c) => c.value === resolvedValue
              );
              const matched = matchedCase?.value ?? null;

              output = { matched, value: resolvedValue };

              // Skip descendants of all non-matching case branches
              // Each case's edges have sourceHandle === case.value
              for (const c of data.cases ?? []) {
                if (c.value !== matched) {
                  const caseEdges = getOutEdges(flow.edges, node.id, c.value);
                  for (const edge of caseEdges) prunedEdges.add(edge);
                  for (const edge of caseEdges) {
                    markDescendantsSkipped(
                      edge.target,
                      flow.edges,
                      skippedNodes,
                      prunedEdges
                    );
                  }
                }
              }

              // If no case matched, skip all outgoing edges
              if (matched === null) {
                const allOutEdges = getOutEdges(flow.edges, node.id);
                for (const edge of allOutEdges) prunedEdges.add(edge);
                for (const edge of allOutEdges) {
                  markDescendantsSkipped(
                    edge.target,
                    flow.edges,
                    skippedNodes,
                    prunedEdges
                  );
                }
              }
              break;
            }

            case "skill": {
              output = await executeSkillNode(
                node.data as {
                  skillId?: string;
                  inputMapping?: Record<string, string>;
                },
                context,
                { workspaceId, ownerId, stepRun, producerAgentUserId }
              );
              break;
            }

            case "capability": {
              // ── Typed/governed Tool → Verb step (Process builder) ─────────────
              // A `capability` node is the structured sibling of the `skill` node:
              // the author picks a Tool (capabilityId) and a Verb on it (verbId).
              // A verb is BACKED BY A SKILL — its `id` is the requiring skill's
              // NAME (see ToolVerbCatalogEntry.id in schema/tools.ts). Dispatch
              // routes verb → the canonical `executeCapability` router (via the
              // in-process IoC slot), which resolves the backing skill, GATES, and runs
              // ALL 3 tiers (builtin / declarative / code) + a 1-of-N connection
              // selector. No parallel governance, no new tables: the router IS the
              // executor; the gate IS the door.
              output = await executeCapabilityNode(
                node.data as {
                  capabilityId?: string;
                  verbId?: string;
                  inputMapping?: Record<string, string>;
                  connectionSelector?: {
                    connectionId?: string;
                    contextObjectId?: string;
                  };
                  connectionId?: string;
                },
                context,
                { workspaceId, ownerId, stepRun, producerAgentUserId }
              );
              break;
            }

            case "sub_automation": {
              const data = node.data as {
                automationId?: string;
                payloadMapping?: Record<string, string>;
              };

              const targetId = data.automationId;
              if (!targetId)
                throw new Error("sub_automation node has no automationId");

              // Recursion guard
              const currentChainDepth = automationContext.chainDepth ?? 0;
              if (currentChainDepth >= 5) {
                throw new Error("Maximum automation chain depth (5) exceeded");
              }
              if (automationContext.chainAutomationIds?.includes(targetId)) {
                throw new Error(
                  `Circular automation reference detected: ${targetId}`
                );
              }

              // Resolve payload
              const payloadMapping = data.payloadMapping ?? {};
              const resolvedPayload = resolveInputMapping(
                payloadMapping,
                context
              );

              // Create a child run record.
              //
              // The child's subject is its OWN resolved payload's `entityId` when
              // the author mapped one — this is the flagship "cron parent →
              // for-each-client → per-client child" shape, where the loop item
              // maps onto `entityId` and each child must route to ITS client's
              // channel. With no per-child subject mapped, the child inherits the
              // parent run's subject: a chained automation is still "about" the
              // same entity. NULL (a bare cron parent with no mapping) correctly
              // degrades per_entity to the per-type feed.
              const childSubjectEntityId =
                subjectEntityIdFromPayload(resolvedPayload) ??
                run?.subjectEntityId;

              const childRunId = randomUUID();
              await db.insert(automationRuns).values({
                id: childRunId,
                automationId: targetId,
                workspaceId,
                subjectEntityId: childSubjectEntityId,
                triggeredBy: "automation",
                status: "running",
                triggerPayload: resolvedPayload,
                startedAt: new Date(),
              });

              // Look up the child automation owner
              const childAutomation = await db.query.automations.findFirst({
                where: eq(automations.id, targetId),
              });
              if (!childAutomation) {
                throw new Error(
                  `sub_automation: target automation ${targetId} not found`
                );
              }

              // Execute synchronously
              const childOutput = await executeAutomationFlow({
                automationId: targetId,
                runId: childRunId,
                workspaceId,
                ownerId: childAutomation.createdBy,
                payload: resolvedPayload,
                automationContext: {
                  ...automationContext,
                  chainDepth: currentChainDepth + 1,
                  chainAutomationIds: [
                    ...(automationContext.chainAutomationIds ?? []),
                    automationContext.automationId,
                  ],
                  automationRunId: childRunId,
                  automationId: targetId,
                },
                // The producer stays in the causal chain across sub_automation
                // delegation — a chained child's THEN-actions are still governed
                // against the agent that fired the ROOT trigger.
                producerAgentUserId,
              });

              // Return the child automation's output DIRECTLY (flat) — one rule.
              output = childOutput;
              break;
            }

            case "playbook_run": {
              const data = node.data as {
                playbookId?: string;
                playbookName?: string;
                paramsMapping?: Record<string, string>;
              };

              if (!data.playbookId && !data.playbookName)
                throw new Error(
                  "playbook_run node has no playbookId or playbookName"
                );

              output = await executePlaybookRun(
                {
                  playbookId: data.playbookId,
                  playbookName: data.playbookName,
                  paramsMapping: data.paramsMapping,
                },
                context,
                workspaceId,
                ownerId,
                automationContext,
                producerAgentUserId
              );
              break;
            }
          }

          // Step succeeded
          succeeded = true;
          lastError = undefined;
          break; // Exit retry loop
        } catch (err) {
          lastError = err;
          const decision = decideStepRetry(err, attempt, maxRetries);
          if (!decision.retry && decision.reason === "non-retryable") {
            logger.warn(
              {
                err,
                nodeId: node.id,
                attempt,
                maxRetries,
                attemptsSkipped: maxRetries - attempt,
              },
              "Automation step failed with a NON-RETRYABLE error — stopping early instead of burning the remaining attempts"
            );
            break;
          }
          if (decision.retry) {
            logger.warn(
              { err, nodeId: node.id, attempt, maxRetries },
              "Automation step failed — will retry"
            );
          }
        }
      } // end retry loop

      // Record what resolved to nothing — on the SUCCESS path too. That is the
      // whole point: the 2026-07-27 failure was a run in which every step
      // "succeeded" while its references silently emptied out.
      await persistStepDiagnostics(stepRun.id, stepDiagnostics, node.id);

      if (succeeded) {
        // Record step output
        context.steps[node.id] = { output };
        stepsCompleted++;

        await db
          .update(automationStepRuns)
          // jsonb column accepts any JSON (object/array/scalar); cast for the type.
          .set({
            status: "completed",
            output: output as Record<string, unknown>,
            completedAt: new Date(),
            ...aiUsageColumns(aiUsage),
          })
          .where(eq(automationStepRuns.id, stepRun.id));
      } else {
        // All attempts failed
        stepsFailed++;
        const errorMessage =
          lastError instanceof Error ? lastError.message : "Unknown error";

        logger.error(
          { err: lastError, nodeId: node.id, runId },
          "Automation step failed"
        );

        await db
          .update(automationStepRuns)
          .set({
            status: "failed",
            errorMessage,
            completedAt: new Date(),
            ...aiUsageColumns(aiUsage),
          })
          .where(eq(automationStepRuns.id, stepRun.id));

        if (!continueOnError) {
          // Stop execution on failure (fail-fast)
          break;
        }

        // continueOnError: record empty output and keep walking the DAG
        logger.info(
          { nodeId: node.id, runId },
          "Step failed but continueOnError=true — continuing execution"
        );
        context.steps[node.id] = { output: { error: errorMessage } };
      }
    }

    // The node walk is over (normally, or via the fail-fast `break`) — record
    // the path it took before writing the terminal verdict.
    await persistPathTaken();

    // Build outputSummary from the last completed step with output
    const completedStepEntries = Object.entries(context.steps);
    const lastCompletedWithOutput = completedStepEntries
      .reverse()
      .find(([, s]) => {
        if (s.output == null) return false;
        // Post-flatten a step's output can be a scalar (string/number) — still a
        // valid "last output"; only an empty object counts as no-output.
        if (typeof s.output === "object")
          return Object.keys(s.output).length > 0;
        return true;
      });
    const outputSummary: Record<string, unknown> | null =
      lastCompletedWithOutput
        ? {
            lastStepOutput: lastCompletedWithOutput[1].output,
            stepsCompleted,
            status: stepsFailed > 0 ? "failed" : "completed",
          }
        : null;

    // Update run with final status. Guarded on status='running' so a late
    // writer can never overwrite a verdict the finalizer/reaper already
    // recorded (an unguarded write here was the retry-overwrite hole).
    const finalStatus = stepsFailed > 0 ? "failed" : "completed";
    await db
      .update(automationRuns)
      .set({
        status: finalStatus,
        stepsCompleted,
        stepsFailed,
        completedAt: new Date(),
        ...(outputSummary ? { outputSummary } : {}),
      })
      .where(
        and(eq(automationRuns.id, runId), eq(automationRuns.status, "running"))
      );

    // Claims protect a live run from concurrent writers. Once a run has
    // terminally failed, release only the claims it owns so a new manual run
    // can retry the same idempotent graph instead of leaving the record stuck.
    if (finalStatus === "failed") {
      await db
        .delete(automationClaims)
        .where(eq(automationClaims.ownerRunId, runId));
    }

    // Update automation stats
    await db
      .update(automations)
      .set({
        lastRunAt: new Date(),
        runCount: drizzleSql`COALESCE(${automations.runCount}, 0) + 1`,
        ...(finalStatus === "completed"
          ? {
              successCount: drizzleSql`COALESCE(${automations.successCount}, 0) + 1`,
            }
          : {
              failureCount: drizzleSql`COALESCE(${automations.failureCount}, 0) + 1`,
            }),
        updatedAt: new Date(),
      })
      .where(eq(automations.id, automationId));

    logger.info(
      { runId, automationId, stepsCompleted, stepsFailed, status: finalStatus },
      "Automation run completed"
    );

    // Genuine finish (success or failure both land here) — close a
    // freshly-opened session; a channel-reused session is left for the channel.
    await closeSessionIfOwned();

    // Narrate the terminal run (idempotent, non-throwing — Wave 3.N1). Reads the
    // now-final run row itself, so success vs. failure is derived from the row.
    await postRunSummary(runId);

    return outputSummary ?? {};
  } // end executeSortedNodes
}

/**
 * pg-boss handler: parse the job payload and delegate to executeAutomationFlow.
 */
export async function handleAutomationExecute(job: {
  data: ExecutionPayload;
}): Promise<void> {
  const {
    runId,
    automationId,
    workspaceId,
    automationContext,
    completedNodeIds,
    producerAgentUserId,
  } = job.data;

  // Look up the automation owner for vault resolution
  const automation = await db.query.automations.findFirst({
    where: eq(automations.id, automationId),
  });
  if (!automation) {
    logger.error({ automationId }, "Automation not found for execution");
    await db
      .update(automationRuns)
      .set({
        status: "failed",
        errorMessage: "Automation not found",
        completedAt: new Date(),
      })
      .where(eq(automationRuns.id, runId));
    return;
  }

  const run = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.id, runId),
  });
  if (!run) {
    logger.error({ runId }, "Automation run not found");
    return;
  }
  // Duplicate-delivery guard: pg-boss retries this queue by default, and a
  // finalized run means the body already executed (or the finalizer/reaper
  // recorded an honest failure). Re-executing would duplicate side effects and
  // could overwrite that verdict — skip instead. Delay-resume is unaffected
  // (a suspended run's row stays 'running').
  if (run.status !== "running") {
    logger.warn(
      { runId, status: run.status },
      "Skipping automation execution: run already finalized"
    );
    return;
  }

  // Defensive finalizer (fail-fast honesty): if the flow throws before writing a
  // terminal status — a cycle throw, or an infra error in the setup window — mark
  // the run failed with the real error instead of leaving it "running" until the
  // reaper (the reaper is the guarantee; this just avoids a ~45-min lie). Guarded
  // on status still 'running' AND not delay-suspended (the delay path RETURNS, it
  // never throws, so a suspended run should never reach here — the guard is
  // belt-and-suspenders and keeps this write idempotent under pg-boss retry).
  try {
    await executeAutomationFlow({
      automationId,
      runId,
      workspaceId,
      ownerId: automation.createdBy,
      payload: (run.triggerPayload as Record<string, unknown>) ?? {},
      automationContext,
      completedNodeIds,
      producerAgentUserId,
    });
  } catch (err) {
    await db
      .update(automationRuns)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(
        and(
          eq(automationRuns.id, runId),
          eq(automationRuns.status, "running"),
          RUN_NOT_DELAY_SUSPENDED
        )
      );
    await db
      .delete(automationClaims)
      .where(eq(automationClaims.ownerRunId, runId));
    // Narrate the failed run before rethrow (idempotent, non-throwing — Wave
    // 3.N1). A run that threw before writing a terminal status never reached the
    // genuine-finish narration site, so this is its only summary hook.
    await postRunSummary(runId);
    throw err; // Rethrow so pg-boss still records the job failure.
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Freeze "which path did this run take" into a storable fact (D3d).
 *
 * Records ONLY what the executor actually decided:
 *  - `prunedEdgeIds` — the exact edges `markDescendantsSkipped`/the condition +
 *    switch cases pruned. Exact, never inferred.
 *  - `traversedEdgeIds` — live (non-pruned) edges whose SOURCE node executed,
 *    i.e. control was released along them.
 *
 * An edge whose source never ran — the run failed fast upstream, or a delay
 * suspended it — is in NEITHER list. That absence is the honest "undecided"
 * state and must render as unknown, not as "not taken".
 *
 * `previous` is the value already on the run row: a delay-resumed invocation
 * rebuilds `prunedEdges` from scratch (nodes it skips as already-completed do
 * not re-prune), so the two invocations are UNION-merged rather than clobbering.
 * Pure — unit-testable without a database.
 */
export function computePathTaken(
  edges: AutomationEdge[],
  prunedEdges: Set<AutomationEdge>,
  executedNodeIds: Set<string>,
  previous?: RunPathTaken | null
): RunPathTaken {
  const pruned = new Set<string>(previous?.prunedEdgeIds ?? []);
  const traversed = new Set<string>(previous?.traversedEdgeIds ?? []);

  for (const edge of prunedEdges) {
    if (edge.id) pruned.add(edge.id);
  }
  for (const edge of edges) {
    if (!edge.id || prunedEdges.has(edge) || pruned.has(edge.id)) continue;
    if (executedNodeIds.has(edge.source)) traversed.add(edge.id);
  }
  // A pruned decision always wins over a traversal claim — an edge can never be
  // both, and the prune is the explicit decision.
  for (const id of pruned) traversed.delete(id);

  return {
    traversedEdgeIds: [...traversed],
    prunedEdgeIds: [...pruned],
  };
}
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(ms|s|m|h|d|w)$/);
  if (!match) return 0;
  const [, value, unit] = match;
  const n = parseInt(value, 10);
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    case "w":
      return n * 604_800_000;
    default:
      return 0;
  }
}
