/**
 * Resume-state seeding + the per-step / per-node RETRY-SAFETY floor. Extracted
 * as a leaf: depends only on `@synap/database` types, `@synap/intelligence-client`,
 * and `graph-topology.ts` (never on the worker or a `steps/*` module) so the
 * run-loop can import it without a circular dependency.
 */
import type {
  AutomationNode,
  AutomationEdge,
  RunPathTaken,
} from "@synap/database";
import { isRetryableError } from "@synap/intelligence-client";
import {
  markDescendantsSkipped,
  computeLoopBodyNodeIds,
} from "./graph-topology.js";
import type { LedgerStepRow } from "./automation-executor-types.js";

/**
 * Wave 4.R resume seed: reconstruct a run's progress from BOTH the crash/delay
 * `completedNodeIds` (job.data) AND the durable step-run ledger, so a redelivered
 * run skips finished steps instead of re-executing every side effect.
 *
 * Why the ledger union matters: a worker death mid-run makes pg-boss redeliver
 * the ORIGINAL job.data (completedNodeIds undefined) — without reading the ledger
 * the executor would re-run ALL steps (the F1 duplicate-effect bug). The
 * delay-resume path already proved the reload machinery; this makes it
 * unconditional.
 *
 * A step row seeds `context.steps` only when it is `completed` AND carries an
 * output. Loop caveat: a loop writes ONE step row — a completed loop row skips
 * the whole loop (correct); an incomplete one re-runs it (accepted at-least-once).
 *
 * A `skipped` row is a DECISION, not telemetry: it says a condition/switch pruned
 * that node on an earlier pass. Dropping it (as this did before) meant a resumed
 * pass rebuilt `skippedNodes` EMPTY and re-executed a node the run had already
 * decided against — real side effects on a dead branch. So skipped rows are
 * returned too, and `seedPruningState` turns them back into pruning.
 *
 * Precedence when a node is BOTH: `completed` wins and the node is not reported
 * skipped. It shouldn't happen (a node that ran had a live parent), but the safe
 * reading of "it already ran" is never to run it again, which is what the walk's
 * already-completed check does first.
 *
 * Pure so it can be unit-tested; the executor passes the ledger rows it loaded.
 */
export function seedResumeState(
  completedNodeIds: string[] | undefined,
  ledgerRows: LedgerStepRow[]
): {
  completed: Set<string>;
  skipped: Set<string>;
  priorSteps: Record<string, { output: Record<string, unknown> }>;
} {
  const completed = new Set(completedNodeIds ?? []);
  const skipped = new Set<string>();
  const priorSteps: Record<string, { output: Record<string, unknown> }> = {};
  for (const row of ledgerRows) {
    if (row.status === "skipped") {
      skipped.add(row.nodeId);
      continue;
    }
    if (row.status !== "completed") continue;
    completed.add(row.nodeId);
    if (row.output) {
      priorSteps[row.nodeId] = {
        output: row.output as Record<string, unknown>,
      };
    }
  }
  for (const nodeId of completed) skipped.delete(nodeId);
  return { completed, skipped, priorSteps };
}

/**
 * Rebuild a resumed run's BRANCH PRUNING from what earlier passes durably
 * recorded, so the walk inherits the decisions instead of re-deriving them from
 * nothing.
 *
 * Why this is needed at all: the condition/switch node that did the pruning is
 * `completed`, so a resumed pass skips it — and with it the
 * `markDescendantsSkipped` call that produced `skippedNodes`. Without a seed the
 * set starts empty and every pruned node downstream of the suspension executes.
 *
 * TWO sources, because neither alone is complete:
 *  - `ledgerSkipped` — nodes the first pass WALKED PAST and wrote a `skipped`
 *    row for. Their out-edges are pruned here so the cascade below can reach
 *    descendants the walk never got to.
 *  - `previousPathTaken.prunedEdgeIds` — the exact edges the condition/switch
 *    pruned, frozen at the delay suspension. This is the only record of a
 *    pruned node that sorts AFTER the delay node (topo order interleaves
 *    branches, so that happens), which has no ledger row at all.
 *
 * The cascade re-runs `markDescendantsSkipped` — the SAME function the main pass
 * uses — with the whole pruned set seeded first, so the diamond rule (a join
 * reachable from the taken branch survives) still decides every node. A node
 * that already completed always has a live parent, so the cascade cannot reach
 * one and mistakenly prune its descendants.
 *
 * Pure — unit-testable without a database.
 */
export function seedPruningState(
  edges: AutomationEdge[],
  ledgerSkipped: Set<string>,
  previousPathTaken: RunPathTaken | null | undefined
): { skippedNodes: Set<string>; prunedEdges: Set<AutomationEdge> } {
  const skippedNodes = new Set<string>();
  const prunedEdges = new Set<AutomationEdge>();

  const prunedIds = new Set(previousPathTaken?.prunedEdgeIds ?? []);
  for (const edge of edges) {
    if (edge.id && prunedIds.has(edge.id)) prunedEdges.add(edge);
  }
  for (const nodeId of ledgerSkipped) {
    skippedNodes.add(nodeId);
    for (const edge of edges) {
      if (edge.source === nodeId) prunedEdges.add(edge);
    }
  }
  for (const edge of [...prunedEdges]) {
    markDescendantsSkipped(edge.target, edges, skippedNodes, prunedEdges);
  }

  return { skippedNodes, prunedEdges };
}

/** Why a failed attempt will not be tried again. */
export type StepRetryDecision =
  | { retry: true }
  | { retry: false; reason: "non-retryable" | "attempts-exhausted" };

/**
 * The per-step retry decision — the ONE place the executor's attempt loop asks
 * "again?". Pure, so it is unit-testable without a DB (the loop it drives lives
 * inside `executeAutomationFlow`).
 *
 * WHY IT EXISTS (2026-08-03). The loop used to be error-type BLIND: it
 * re-attempted every failure identically. That makes `maxRetries` actively
 * harmful for a DETERMINISTIC failure — that day two `ai.generate` steps died
 * with `finishReason=length · completionTokens=701 · maxTokens=700`, and the
 * same prompt at the same ceiling truncates the same way every time. Retrying it
 * is 3× the tokens and 3× the latency for the identical error.
 *
 * The shape is the durable-execution consensus (Temporal `nonRetryableErrorTypes`,
 * Restate `TerminalError`, Inngest `NonRetriableError`): **retry is the DEFAULT
 * and the PRODUCER of the error declares the opt-out.** `isRetryableError`
 * (@synap/intelligence-client — the same module that builds the attributed
 * message, so terminality is decided where the finish reason is known) is that
 * declaration; an error it does not recognise is assumed transient.
 *
 * `attempts-exhausted` and `non-retryable` are distinguished on purpose: the
 * caller logs the second one, so an operator reading the run can tell "we gave
 * up after N tries" from "trying again could not have helped".
 */
export function decideStepRetry(
  err: unknown,
  attempt: number,
  maxRetries: number
): StepRetryDecision {
  // Terminality is checked FIRST, before attempts: on the LAST attempt the
  // distinction is still worth reporting, and it costs nothing.
  if (!isRetryableError(err)) return { retry: false, reason: "non-retryable" };
  if (attempt >= maxRetries)
    return { retry: false, reason: "attempts-exhausted" };
  return { retry: true };
}

/** Whether re-running a node's effect is safe, and if not, why not. */
export type NodeRetrySafety = { safe: true } | { safe: false; reason: string };

/** HTTP methods a `fetch` node may re-issue without risking a second effect. */
const RETRY_SAFE_HTTP_METHODS = /^(GET|HEAD)$/i;

/**
 * `output` types whose re-execution produces a SECOND irreversible effect.
 *   - entity_create: no idempotency receipt at all. `outputIdemId` (the
 *     deterministic (runId, nodeId, loopIndex) id that makes `notification` and
 *     `channel_message` exactly-once) is NOT applied here; the only guard is the
 *     OPTIONAL, single-property, read-then-write `dedupeBy` — absent on most
 *     nodes and racy when present. This is the exact duplication that forced the
 *     job-level `retryLimit: 0`.
 *   - webhook: an outbound POST to a third party with no receipt, no dedup key
 *     and no read-back. A retry is a second delivery, user-visible and
 *     irreversible.
 */
const RETRY_UNSAFE_OUTPUT_TYPES = new Set<string>(["entity_create", "webhook"]);

/**
 * THE RETRY-SAFETY FLOOR — may this node's effect be re-executed?
 *
 * WHY A FLOOR AND NOT A VALIDATOR (2026-08-03). `errorHandling.maxRetries` is
 * authored per-node in a stored `flowDefinition`. An author-time check cannot
 * reach a flow that was authored BEFORE the check existed, nor one seeded or
 * imported around the door — and this repo has the documented failure mode of
 * validators returning `{valid:true}` over a real defect. So the executor
 * itself refuses, exactly like the governance floors: a stored config may
 * NARROW the retry budget, never widen it past what the effect can survive.
 *
 * The verdict is derived from what each node ACTUALLY does (see the audit in
 * this wave), not from a hand-maintained allowlist of "dangerous" names:
 *   safe    — pure reads/compute (`condition`, `transform`, `query`,
 *             `entity_read`, `related_entities`, `guard`, `compute`, `select`,
 *             `switch`, `*_query`, `delay`), the CAS `claim` node (its second
 *             insert conflicts and replays the winner), `output` types that
 *             re-write the same value (`entity_update`, `set_state`,
 *             `facet_*`, `relation_create`) or carry a deterministic
 *             (runId, nodeId, loopIndex) id + `onConflictDoNothing`
 *             (`notification`, `channel_message`), and `skill`/`capability` —
 *             those route through `executeCapability`, which runs any
 *             external-effect verb through the `capability_run_receipts` CAS
 *             (`runDirectWriteVerbOnce`) keyed on a CONTENT hash, so an
 *             immediate retry collapses onto the prior claim.
 *   unsafe  — everything below, each for a reason stated in its branch.
 *
 * PURE (no DB, no I/O) so the floor is unit-testable, and total: an unknown
 * node type is treated as safe because every node type not enumerated here is
 * a read/compute node — the effectful ones are all named.
 */
export function assessNodeRetrySafety(
  node: AutomationNode,
  flow?: { nodes: AutomationNode[]; edges: AutomationEdge[] }
): NodeRetrySafety {
  const data = (node.data ?? {}) as Record<string, unknown>;

  switch (node.type) {
    case "command":
      // Dispatches a free-form task to the Intelligence Service. Whatever the
      // agent wrote back into the pod during the attempt that "failed" (a
      // client-perceived timeout is the common case) is already committed —
      // there is no receipt, no correlation key, nothing to collapse a second
      // dispatch onto.
      return {
        safe: false,
        reason:
          "a `command` node dispatches an IS task with no idempotency receipt — a retry re-runs the agent and duplicates whatever it already wrote",
      };

    case "fetch": {
      const method = String(data.method ?? "GET");
      if (RETRY_SAFE_HTTP_METHODS.test(method)) return { safe: true };
      return {
        safe: false,
        reason: `a \`fetch\` node issuing ${method.toUpperCase()} is an outbound write with no idempotency key — a retry is a second request`,
      };
    }

    case "output": {
      const outputType = String(data.outputType ?? "");
      if (RETRY_UNSAFE_OUTPUT_TYPES.has(outputType)) {
        return {
          safe: false,
          reason:
            outputType === "entity_create"
              ? "an `entity_create` output has no idempotency receipt (only the optional, racy `dedupeBy`) — a retry creates a second entity"
              : "a `webhook` output POSTs to a third party with no idempotency receipt — a retry is a second delivery",
        };
      }
      // `session_update` is idempotent for stage/grantStatus (it SETS them),
      // but `addOutput` is an unconditional read-modify-APPEND onto
      // `focus_sessions.expected_outputs` — a retry appends a duplicate row.
      if (outputType === "session_update") {
        const config = (data.config ?? {}) as Record<string, unknown>;
        if (config.addOutput) {
          return {
            safe: false,
            reason:
              "a `session_update` output with `addOutput` APPENDS to expectedOutputs — a retry appends a duplicate entry",
          };
        }
      }
      return { safe: true };
    }

    case "sub_automation":
      // `const childRunId = randomUUID()` is minted INSIDE the attempt, so a
      // retry starts a whole second child run — and because the child's own
      // `outputIdemId` is keyed on `automationRunId`, the fresh id also defeats
      // the child's notification/channel_message deduplication. A key derived
      // per attempt is decoration, not idempotency.
      return {
        safe: false,
        reason:
          "a `sub_automation` node mints a fresh child runId per attempt — a retry runs the entire child flow again AND defeats the child's own run-id-keyed idempotency",
      };

    case "playbook_run":
      // The spine's `idempotentBySubject` guard is CONDITIONAL:
      // `if (input.idempotentBySubject && input.subjectId)`. With no resolvable
      // subject — or one dropped by the cross-workspace visibility guard — each
      // attempt starts a fresh session/run.
      return {
        safe: false,
        reason:
          "a `playbook_run` node is only idempotent when a subject entity resolves (`idempotentBySubject && subjectId`) — with no subject a retry starts a second session",
      };

    case "loop": {
      // A loop node's attempt dispatches its WHOLE body over every item. A
      // retry after a mid-body failure re-runs the items that already
      // succeeded, so the loop is exactly as retry-safe as its least-safe body
      // node. Nested loops are traversal boundaries (see LOOP_BODY_NODE_TYPES),
      // so this recursion terminates.
      if (!flow) {
        return {
          safe: false,
          reason:
            "a `loop` node's retry safety is its body's, and the flow graph was not supplied to evaluate it",
        };
      }
      const bodyNodeIds = computeLoopBodyNodeIds(
        flow.nodes,
        flow.edges,
        node.id
      );
      for (const bodyNodeId of bodyNodeIds) {
        const child = flow.nodes.find((n) => n.id === bodyNodeId);
        if (!child) continue;
        const verdict = assessNodeRetrySafety(child, flow);
        if (!verdict.safe) {
          return {
            safe: false,
            reason: `a \`loop\` re-dispatches its whole body per attempt, and body node "${bodyNodeId}" is not retry-safe: ${verdict.reason}`,
          };
        }
      }
      return { safe: true };
    }

    default:
      return { safe: true };
  }
}
