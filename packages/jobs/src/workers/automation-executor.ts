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
 */

import { randomUUID } from "crypto";
import {
  db,
  eq,
  and,
  or,
  isNull,
  isNotNull,
  inArray,
  gt,
  gte,
  lt,
  lte,
  ne,
  desc,
  asc,
  automations,
  automationRuns,
  automationStepRuns,
  automationClaims,
  entities,
  entityFacets,
  profiles,
  relations,
  users,
  messages,
  channels,
  documents,
  links,
  notifications,
  focusSessions,
  playbookEnrollments,
  proposals,
  drizzleSql,
  EntityRepository,
  EntityBodyService,
  materializeEntity,
  eventRepository,
  insertChannelMessage,
  openRunSession,
} from "@synap/database";
import {
  beginStepDiagnostics,
  recordUnresolvedReference,
  UNRESOLVED_REFS_KEY,
  type UnresolvedReferenceCollector,
  type UnresolvedReferenceReason,
} from "./unresolved-references.js";
import { ChannelType } from "@synap/database/schema";
import { ChannelRepository } from "@synap/database";
import type {
  FlowDefinition,
  AutomationNode,
  AutomationEdge,
  NodeErrorHandling,
  CommandNodeDef,
  OutputNodeDef,
  GuardNodeDef,
  RunPathTaken,
} from "@synap/database";
import type { Column, SQL } from "@synap/database";
import { getBoss, emitSideEffects } from "@synap/events";
import {
  resolveVaultReferences,
  isVaultReference,
} from "../utils/vault-resolver.js";
import { checkAutomationWriteOrPropose } from "../utils/automation-governance.js";
import { deterministicUuidV5 } from "../utils/deterministic-uuid.js";
import {
  postRunSummary,
  resolveRunChannel,
} from "../utils/post-run-summary.js";
import { subjectEntityIdFromPayload } from "../utils/run-subject.js";
import { entityQueryVisibilityWhere } from "./entity-query-scope.js";
import {
  runsQueryVisibilityWhere,
  proposalsQueryVisibilityWhere,
} from "./ledger-query-scope.js";
import { RUN_NOT_DELAY_SUSPENDED } from "./automation-run-reaper.js";
import { validateExternalUrl, safeExternalFetch } from "@synap/shared-utils";
import {
  getDefaultActiveService,
  requestTaskExecute,
} from "@synap/intelligence-client";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "automation-executor" });

interface ExecutionPayload {
  runId: string;
  automationId: string;
  workspaceId: string;
  automationContext: {
    automationRunId: string;
    automationId: string;
    chainDepth: number;
    rootRunId: string;
    chainAutomationIds: string[];
    /**
     * The focus session opened for this run (non-playbook-delegate automations
     * only — see `executeAutomationFlow`). Threaded through delay-resumption
     * re-enqueues so a suspended run reuses the SAME session on resume instead
     * of opening a second one. Deliberately NOT inherited by `sub_automation`
     * children — each chained automation run is its own reviewable unit and
     * gets its own session.
     */
    focusSessionId?: string;
    /** True when this run created the session fresh (vs. reusing a channel's
     *  existing active session) — only the owner closes it at genuine finish. */
    focusSessionOwned?: boolean;
  };
  /** For delay resumption: skip nodes that were already executed */
  completedNodeIds?: string[];
}

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

/** Context built up during execution — step outputs available to later steps */
export interface StepContext {
  trigger: {
    payload: Record<string, unknown>;
  };
  // `output` is the RAW result of the node (whatever the verb/skill/handler
  // returned — object, array, string, number). ONE rule for every node type:
  // templates read `steps.<id>.output.<field>`. No node double-wraps (the old
  // skill/capability/sub_automation `{ output: <result>, verbId }` envelope is
  // gone — provenance is not consumed downstream, so it is not re-nested here).
  steps: Record<string, { output: unknown }>;
  loop?: { item: unknown; index: number };
  // Set only inside array-pipe predicates/expressions (filter/map) so a
  // predicate can reference the current item as `{{item.<field>}}`.
  item?: unknown;
  // Per-automation persistent state, snapshotted at trigger time. Templates
  // resolve `{{automation.state.<key>}}`; the `set_state` output node reads
  // `automation.id` to know which row to merge back into.
  automation: {
    id: string;
    state: Record<string, unknown>;
  };
}

/**
 * Topological sort of nodes based on edges.
 * Returns nodes in execution order (parents before children).
 */
export function topoSort(
  nodes: AutomationNode[],
  edges: AutomationEdge[]
): AutomationNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: AutomationNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = nodeMap.get(id);
    if (node) sorted.push(node);

    for (const target of adjacency.get(id) ?? []) {
      const newDegree = (inDegree.get(target) ?? 1) - 1;
      inDegree.set(target, newDegree);
      if (newDegree === 0) queue.push(target);
    }
  }

  return sorted;
}

/** A completed-step-ledger row as far as resume seeding cares about it. */
export interface LedgerStepRow {
  nodeId: string;
  status: string;
  output: unknown;
}

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

/**
 * Resolve template variables in a string.
 * Supports: {{trigger.payload.field}}, {{steps.stepId.output.field}}, {{loop.item}}
 */
export function resolveTemplate(
  template: string,
  context: StepContext
): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, path: string) => {
    const { value: current, miss } = lookupContextPath(path, context);
    // UNCHANGED BEHAVIOR: anything that resolves to nothing still renders "".
    // Flows depend on it (an absent `{{trigger.payload.prompt}}` means "no
    // steer given"). We only stop being SILENT about it — see
    // unresolved-references.ts for why that mattered.
    if (miss) {
      recordUnresolvedReference(path.trim(), miss);
      return "";
    }
    // A Date renders as an ISO string (not JSON-quoted) — keep the old
    // human-readable passthrough for raw Date fields (e.g. a query step's
    // createdAt), since JSON.stringify would wrap it in quotes.
    if (current instanceof Date) return current.toISOString();
    // Other non-scalars (arrays/objects) are JSON-encoded, NOT String()-ed — a
    // bare `String({...})` yields "[object Object]", silently corrupting any
    // object interpolated into a prompt/config (e.g. graph relations to an AI step).
    if (typeof current === "object") return JSON.stringify(current);
    return String(current);
  });
}

/**
 * Is this string ONE whole-string `{{path}}` reference (a value binding), as
 * opposed to text that merely CONTAINS placeholders (an interpolation)?
 *
 * Returns the inner path for a value binding, or `null` for interpolation.
 *
 * WHY `[^{}]` AND NOT `.+?` — this is the fix for a silent data-loss bug.
 * The obvious pattern `/^\{\{(.+?)\}\}$/` looks non-greedy but is anchored at
 * BOTH ends, so the engine backtracks until the trailing `\}\}` lines up with
 * the LAST `}}` in the string. That means a genuine interpolation like
 *   "{{item.id}} · {{item.title}}"
 * MATCHES, and captures the nonsense path `item.id}} · {{item.title` — which
 * resolves to `undefined`. Not an error, not a warning: a null, silently, in
 * place of the user's data.
 *
 * Observed live 2026-07-27: every projection node in the report automation
 * emitted `[null, null, …]`, so all three AI rounds were handed empty lists and
 * faithfully reported "the workspace contains no data" — while the `query`
 * steps upstream had in fact returned 15 notes, 25 tasks, and so on, and every
 * step reported SUCCESS. The data was fetched, then destroyed in transit.
 *
 * Requiring the captured path to contain NO braces makes a value binding
 * exactly what it claims to be: one reference, nothing else. Any string with a
 * second placeholder in it is interpolation and takes the string path.
 */
export function matchWholeStringReference(value: string): string | null {
  const m = value.match(/^\{\{([^{}]+)\}\}$/);
  return m ? m[1] : null;
}

/**
 * Deep-resolve templates in any value (string, object, array).
 */
export function deepResolveTemplates(
  value: unknown,
  context: StepContext
): unknown {
  if (typeof value === "string") {
    // An exact placeholder is a value binding, not text interpolation. Preserve
    // its native number/boolean/object shape for governed output verbs; only an
    // embedded placeholder is rendered as a human string.
    const exactReference = matchWholeStringReference(value);
    return exactReference !== null
      ? resolveReferencePath(exactReference, context)
      : resolveTemplate(value, context);
  }
  if (Array.isArray(value))
    return value.map((v) => deepResolveTemplates(v, context));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = deepResolveTemplates(v, context);
    }
    return result;
  }
  return value;
}

/**
 * Resolve all input mappings for a command step.
 */
function resolveInputMapping(
  mapping: Record<string, string>,
  context: StepContext
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(mapping)) {
    resolved[key] = resolveTemplate(template, context);
  }
  return resolved;
}

/**
 * Discriminated result mirror of `@synap/api`'s `ExecuteCapabilityResult`. jobs
 * cannot import @synap/api (circular dep), so the shape is re-declared here.
 */
type CapabilityDispatchResult =
  | { kind: "run"; skillId: string; result: unknown }
  | { kind: "dry-run"; skillId: string }
  | { kind: "proposed"; proposalId: string }
  | { kind: "deny"; reason: string }
  // The verb RAN and its handler FAILED (code sandbox success:false / provider
  // error envelope). Inside an automation this is a node failure — the call-sites
  // THROW rather than storing the failure envelope as node output.
  | { kind: "error"; message: string }
  | { kind: "not_found"; message: string };

/**
 * IoC slot for the canonical capability router `executeCapability` (in @synap/api).
 *
 * The workers here run IN the backend (apps/api) process — pg-boss is started
 * in-process — but this package (@synap/jobs) cannot statically import @synap/api
 * (circular dep: api → jobs → database). So apps/api, the one place that may
 * import both, fills this slot at boot via `registerCapabilityExecutor()` — the
 * SAME IoC pattern as `registerImportCorpusHandler`. No HTTP, no shared secret.
 */
export type CapabilityExecutorInput = {
  verbId?: string;
  skillId?: string;
  parameters?: Record<string, unknown>;
  workspaceId: string | null;
  userId: string;
  connectionSelector?: {
    connectionId?: string;
    contextObjectId?: string;
  } | null;
  suppressProposal?: boolean;
};

type CapabilityExecutor = (
  input: CapabilityExecutorInput
) => Promise<CapabilityDispatchResult>;

let capabilityExecutor: CapabilityExecutor | null = null;

export function registerCapabilityExecutor(fn: CapabilityExecutor): void {
  capabilityExecutor = fn;
}

/**
 * IoC slot for the ONE playbook-run spine (`runPlaybook`, @synap/api). @synap/jobs
 * cannot statically import @synap/api (circular dep), so apps/api fills this slot
 * at boot via `registerPlaybookRunner()` — the SAME pattern as
 * `registerCapabilityExecutor`. `executePlaybookRun` below is a thin shim that
 * resolves the automation StepContext (goal/params) and delegates here, so
 * scheduled runs go through the executor spine (is-agent | external-agent |
 * hybrid) and the triggerAutoRespond ONE door — never a forked is-agent flow.
 *
 * Types mirror api's RunPlaybookInput/RunPlaybookResult structurally (not
 * imported — circular dep); the boot wiring `(input) => runPlaybook(input)`
 * type-checks against both.
 */
export interface PlaybookRunnerChainContext {
  automationRunId: string;
  automationId: string;
  chainDepth: number;
  rootRunId: string;
  chainAutomationIds: string[];
}

export interface PlaybookRunnerInput {
  playbookId?: string;
  playbookName?: string;
  workspaceId: string;
  userId: string;
  params?: Record<string, unknown>;
  subjectId?: string;
  idempotentBySubject?: boolean;
  goalResolver?: (goalTemplate: string) => string;
  chainContext?: PlaybookRunnerChainContext;
}

export interface PlaybookRunnerResult {
  run: { id: string; status: string } | null;
  session: { id: string; channelId: string | null };
  reused?: boolean;
}

type PlaybookRunner = (
  input: PlaybookRunnerInput
) => Promise<PlaybookRunnerResult>;

let playbookRunner: PlaybookRunner | null = null;

export function registerPlaybookRunner(fn: PlaybookRunner): void {
  playbookRunner = fn;
}

/**
 * Dispatch a capability (verb or skill) through the CANONICAL router
 * `executeCapability` — which routes all 3 tiers (builtin / declarative / code)
 * + connectionSelector and gates internally. In-process via the IoC slot above.
 *
 * Intentionally THROWS if the slot is unregistered — unlike the cron/signal-router
 * slots (which warn+skip), a dropped automation step must not silently vanish; it
 * surfaces as a step failure (pg-boss retries) rather than a no-op.
 */
async function dispatchViaCapabilityRouter(
  input: Omit<CapabilityExecutorInput, "suppressProposal">
): Promise<CapabilityDispatchResult> {
  if (!capabilityExecutor) {
    throw new Error(
      "Capability executor not registered — apps/api must call registerCapabilityExecutor() at boot"
    );
  }
  // Automations have NO interactive review surface — suppress proposal
  // persistence so a recurring run can't flood the proposal queue; an
  // unapproved verb returns a plain `deny` (fail-closed by the caller).
  return capabilityExecutor({ ...input, suppressProposal: true });
}

/**
 * Wave 4.V2 declarative output → verb bridge. The native facet/relation output
 * steps (facet_attach / facet_update / facet_detach / relation_create) never
 * hand-roll an insert — they dispatch the corresponding governed builtin verb
 * through the SAME canonical capability router a `capability` node uses, so the
 * facet one-door (FacetRepository, via entities.*Facet) and the relation door
 * (createLinks, via relations.create) stay the only write paths. Config is passed
 * as the verb's parameters (already template-resolved by executeOutputStep); the
 * verb's own Zod schema validates + strips. Maps the dispatch verdict to a node
 * output, failing CLOSED on a governance refusal exactly like the skill/capability
 * nodes (a mid-flow automation has no interactive review surface).
 */
async function dispatchOutputVerb(
  verbId: string,
  config: Record<string, unknown>,
  workspaceId: string,
  actingUserId: string
): Promise<Record<string, unknown>> {
  const dispatch = await dispatchViaCapabilityRouter({
    verbId,
    parameters: config,
    workspaceId,
    userId: actingUserId,
  });
  if (dispatch.kind === "deny") {
    throw new Error(`${verbId} refused by capability gate: ${dispatch.reason}`);
  }
  if (dispatch.kind === "proposed") {
    throw new Error(
      `${verbId} requires human approval and cannot run inside an automation; output step refused.`
    );
  }
  if (dispatch.kind === "not_found") {
    throw new Error(`${verbId} could not be dispatched: ${dispatch.message}`);
  }
  if (dispatch.kind === "error") {
    // The verb ran and FAILED — the node fails (never store the failure as output).
    throw new Error(`${verbId} failed: ${dispatch.message}`);
  }
  if (dispatch.kind === "dry-run") {
    return { status: "dry_run", verbId };
  }
  // kind === "run": surface the verb's own return flat (ONE `.output` rule) when
  // it is an object (e.g. { status:'attached', facet } / { status:'updated', … }),
  // else wrap a scalar/array so downstream steps always read `output.result`.
  const result = dispatch.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}

/**
 * Walk a dot-path from context, distinguishing WHY it produced nothing.
 *
 * `miss: "missing"` — a segment does not exist on the context (typo, a step
 * that never ran, or a junk path like the `item.id}} · {{item.title` a
 * mis-anchored regex once captured). `miss: "null"` — every segment existed and
 * the value is null/undefined. `miss: null` — a real value (possibly `""`).
 *
 * The early `in` check is NOT a behavior change: previously a missing segment
 * left `current === undefined`, and the next iteration's null-guard bailed with
 * the same result. It only lets us name the failure.
 */
function lookupContextPath(
  path: string,
  context: StepContext
): { value: unknown; miss: UnresolvedReferenceReason | null } {
  const parts = path.trim().split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current == null || typeof current !== "object")
      return { value: undefined, miss: "missing" };
    if (!(part in (current as Record<string, unknown>)))
      return { value: undefined, miss: "missing" };
    current = (current as Record<string, unknown>)[part];
  }
  return { value: current, miss: current == null ? "null" : null };
}

/**
 * Resolve a dot-path from context to its actual value (not stringified).
 *
 * Deliberately NON-recording: several callers use it as an EXISTENCE PROBE
 * (guard-node `check.path`, dedup candidate paths) where "absent" is a normal
 * answer, and recording those would drown the real signal. Sites that resolve a
 * reference the AUTHOR WROTE use `resolveReferencePath` below.
 */
function resolveContextPath(path: string, context: StepContext): unknown {
  return lookupContextPath(path, context).value;
}

/**
 * `resolveContextPath` + diagnostics. Use at every site that resolves a
 * user-authored `{{...}}` value binding (whole-string reference, pipe argument,
 * loop iterator) — the string-interpolation sites are covered by
 * `resolveTemplate`.
 */
function resolveReferencePath(path: string, context: StepContext): unknown {
  const { value, miss } = lookupContextPath(path, context);
  if (miss) recordUnresolvedReference(path.trim(), miss);
  return value;
}

/**
 * Get edges leaving a node, optionally filtered by sourceHandle.
 */
function getOutEdges(
  edges: AutomationEdge[],
  nodeId: string,
  sourceHandle?: string
): AutomationEdge[] {
  return edges.filter(
    (e) =>
      e.source === nodeId &&
      (sourceHandle === undefined || e.sourceHandle === sourceHandle)
  );
}

// ── Step Executors ──────────────────────────────────────────────────────────

/**
 * Execute a command step by calling the Intelligence Service.
 */
async function executeCommandStep(
  data: {
    commandId?: string;
    commandTitle?: string;
    inputMapping: Record<string, string>;
    promptOverride?: string;
  },
  context: StepContext,
  workspaceId: string,
  ownerId: string
): Promise<Record<string, unknown>> {
  let resolvedInputs = resolveInputMapping(data.inputMapping, context);

  // Resolve vault references in input values (e.g., API keys)
  const stringInputs: Record<string, string> = {};
  let hasVaultRefs = false;
  for (const [k, v] of Object.entries(resolvedInputs)) {
    const sv = String(v);
    stringInputs[k] = sv;
    if (isVaultReference(sv)) hasVaultRefs = true;
  }
  if (hasVaultRefs) {
    const resolved = await resolveVaultReferences(stringInputs, ownerId);
    resolvedInputs = resolved;
  }

  // Build the prompt from command title + resolved inputs
  let prompt = data.commandTitle ?? "Execute automation command";
  if (data.promptOverride) {
    prompt = resolveTemplate(data.promptOverride, context);
  }

  // Add resolved inputs as context
  const inputSummary = Object.entries(resolvedInputs)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  if (inputSummary) {
    prompt += `\n\nInputs:\n${inputSummary}`;
  }

  // Canonical IS credential resolution (decrypted DB key), not stale env.
  const { endpoint: isUrl, apiKey: isApiKey } = await getDefaultActiveService();

  // ── Generic command execution ──────────────────────────────────────────
  // IS transport (fetch + X-API-Key + 60s abort) is the SSOT
  // `requestTaskExecute` in @synap/intelligence-client — no raw fetch here.
  try {
    const result = await requestTaskExecute(isUrl, isApiKey, {
      taskId: data.commandId ?? "automation-command",
      action: prompt,
      context: resolvedInputs,
      // Attribute the IS work to the automation's owning principal
      // (automation.createdBy — the agent user id for AI-created automations)
      // instead of the unattributed "system". Writes the IS performs back to
      // the pod will then carry this identity through the governance gate.
      userId: ownerId,
      workspaceId,
    });
    return { ...result, resolvedInputs };
  } catch (err) {
    logger.error(
      { err, commandId: data.commandId },
      "Command step IS call failed"
    );
    throw err;
  }
}

/**
 * Execute a `skill` node — resolve its inputMapping and dispatch through the
 * CANONICAL router (all 3 tiers + gate). Extracted from the main switch so the
 * SAME path runs both in the top-level pass AND per-item inside a loop body
 * (where `context.loop` is set, so `{{loop.item}}` resolves per iteration).
 *
 * `stepRun` is only present in the main pass — when given, the resolved inputs
 * are persisted to the step-run record for observability. Loop children have no
 * per-child step-run row, so it is omitted there.
 */
async function executeSkillNode(
  data: {
    skillId?: string;
    inputMapping?: Record<string, string>;
  },
  context: StepContext,
  opts: {
    workspaceId: string;
    ownerId: string;
    stepRun?: { id: string };
  }
): Promise<unknown> {
  const skillId = data.skillId;
  if (!skillId) throw new Error("Skill node has no skillId");

  const inputMapping = data.inputMapping ?? {};
  // deepResolveTemplates (NOT resolveInputMapping) so an exact `{{step.x}}`
  // placeholder that resolves to an array/object reaches the skill as its NATIVE
  // shape. resolveInputMapping → resolveTemplate JSON-stringifies non-scalars,
  // which made a skill's zod `z.array(...)` param fail with "expected array,
  // received string". Output nodes already resolve this way; skill/capability
  // dispatch must match. (Embedded `"text {{x}}"` still renders to a string.)
  const resolvedInputs = deepResolveTemplates(inputMapping, context) as Record<
    string,
    unknown
  >;

  if (opts.stepRun) {
    await db
      .update(automationStepRuns)
      .set({ resolvedInputs })
      .where(eq(automationStepRuns.id, opts.stepRun.id));
  }

  // ── Canonical dispatch (all 3 tiers + gate) ────────────────────────
  // Route through `executeCapability` (via the in-process IoC slot) — it
  // resolves the skill, GATES internally, and runs builtin/declarative/
  // code tiers. An automation runs as the workspace OWNER (userId =
  // ownerId, no agent identity), so the gate resolves:
  //   • owner runs their OWN skill  → owner-bypass → run
  //   • non-owner-owned + approved  → auto         → run
  //   • non-owner-owned + UNapproved→ propose (FAILS CLOSED below)
  // A mid-flow automation has no interactive review surface, so a
  // propose/deny/not_found verdict FAILS CLOSED (throws); dry-run is
  // honored as a no-op preview.
  const skillDispatch = await dispatchViaCapabilityRouter({
    skillId,
    parameters: resolvedInputs,
    workspaceId: opts.workspaceId,
    userId: opts.ownerId,
  });
  if (skillDispatch.kind === "deny") {
    throw new Error(
      `Skill ${skillId} refused by capability gate: ${skillDispatch.reason}`
    );
  }
  if (skillDispatch.kind === "proposed") {
    throw new Error(
      `Skill ${skillId} requires human approval and cannot run inside an automation; automation skill node refused.`
    );
  }
  if (skillDispatch.kind === "not_found") {
    throw new Error(
      `Skill ${skillId} could not be dispatched: ${skillDispatch.message}`
    );
  }
  if (skillDispatch.kind === "error") {
    // The skill ran in the IS sandbox and FAILED (success:false) — the node fails
    // rather than storing the error envelope as node output.
    throw new Error(`Skill ${skillId} failed: ${skillDispatch.message}`);
  }
  if (skillDispatch.kind === "dry-run") {
    // Grant resolved to dry-run preview — no external side effect.
    return { dryRun: true, skillId: skillDispatch.skillId };
  }
  // kind === "run": return the skill's execution result DIRECTLY as the node
  // output (the IS SkillExecutionResult for a code skill, the handler/provider
  // return for builtin/declarative). Stored flat → `steps.<id>.output.<field>`.
  return skillDispatch.result;
}

/**
 * Execute a `capability` node — the typed/governed Tool → Verb sibling of the
 * `skill` node. A verb is BACKED BY A SKILL; dispatch routes verb → the
 * canonical `executeCapability` router (same door as `executeSkillNode`).
 * Extracted so the SAME path runs both in the main pass AND per-item in a loop.
 *
 * `stepRun` is only present in the main pass (see `executeSkillNode`).
 */
async function executeCapabilityNode(
  data: {
    capabilityId?: string;
    verbId?: string;
    inputMapping?: Record<string, string>;
    connectionSelector?: {
      connectionId?: string;
      contextObjectId?: string;
    };
    connectionId?: string;
  },
  context: StepContext,
  opts: {
    workspaceId: string;
    ownerId: string;
    stepRun?: { id: string };
  }
): Promise<unknown> {
  const verbId = data.verbId;
  if (!verbId) throw new Error("Capability node has no verbId");

  const capInputMapping = data.inputMapping ?? {};
  // deepResolveTemplates: preserve array/object params from an exact `{{...}}`
  // placeholder so a capability's zod schema (e.g. mail_triage `emails:
  // z.array(...)`) receives the native shape, not a JSON string. See the skill
  // node above — same bug class ("expected array, received string").
  const capResolvedInputs = deepResolveTemplates(
    capInputMapping,
    context
  ) as Record<string, unknown>;

  if (opts.stepRun) {
    await db
      .update(automationStepRuns)
      .set({ resolvedInputs: capResolvedInputs })
      .where(eq(automationStepRuns.id, opts.stepRun.id));
  }

  // Runtime 1-of-N connection selection (Wave 4): explicit selector, or
  // a bare connectionId shorthand. Absent → default/authBinding behavior.
  const connectionSelector =
    data.connectionSelector ??
    (data.connectionId ? { connectionId: data.connectionId } : null);

  // ── Canonical dispatch (SAME door as `case "skill"`) ──────────────
  // Runs as the workspace OWNER (userId = ownerId, no agent identity):
  //   • owner runs their OWN skill  → owner-bypass → run
  //   • non-owner-owned + approved  → auto         → run
  //   • non-owner-owned + UNapproved→ propose (FAILS CLOSED below)
  // A mid-flow automation has no interactive review surface, so a
  // propose/deny/not_found verdict throws; dry-run is honored as a no-op.
  const capDispatch = await dispatchViaCapabilityRouter({
    verbId,
    parameters: capResolvedInputs,
    workspaceId: opts.workspaceId,
    userId: opts.ownerId,
    connectionSelector,
  });
  if (capDispatch.kind === "deny") {
    throw new Error(
      `Capability ${verbId} refused by capability gate: ${capDispatch.reason}`
    );
  }
  if (capDispatch.kind === "proposed") {
    throw new Error(
      `Capability ${verbId} requires human approval and cannot run inside an automation; capability node refused.`
    );
  }
  if (capDispatch.kind === "not_found") {
    throw new Error(
      `Capability ${verbId} could not be dispatched: ${capDispatch.message}`
    );
  }
  if (capDispatch.kind === "error") {
    // The verb ran and its handler FAILED — the node fails (never store the
    // failure envelope as node output).
    throw new Error(`Capability ${verbId} failed: ${capDispatch.message}`);
  }
  if (capDispatch.kind === "dry-run") {
    // Grant resolved to dry-run preview — no external side effect.
    return { dryRun: true, verbId, skillId: capDispatch.skillId };
  }
  // kind === "run": return the verb result DIRECTLY as the node output. Stored
  // flat → `steps.<id>.output.<field>` (ONE rule, same as every other node).
  return capDispatch.result;
}

/**
 * Execute an output step action.
 */
export async function executeOutputStep(
  data: {
    outputType: string;
    config: Record<string, unknown>;
    label?: string;
  },
  context: StepContext,
  workspaceId: string,
  automationContext: ExecutionPayload["automationContext"],
  ownerId: string,
  actingUserId: string,
  // Workflow attribution (D3a): the executing flow node + its step-run row, so a
  // governed write becomes a proposal that traces back to the exact step. In a
  // loop body the step run is the loop node's (no per-child row), while nodeId
  // is the child node — the closest honest attribution.
  attribution?: { nodeId?: string; stepRunId?: string },
  // The run's subject entity, when the run was launched about one — lets the
  // `channel_message` node target `channelType:'subjectEntity'` (this run's
  // subject's channel) without hardcoding a channelId.
  runSubjectEntityId?: string | null
): Promise<Record<string, unknown>> {
  // Deep-resolve all template variables in config
  const config = deepResolveTemplates(data.config, context) as Record<
    string,
    unknown
  >;

  // Wave 4.R idempotency: the side-effecting output steps below (notification,
  // channel_message) derive their row id deterministically from (runId, nodeId,
  // loop iteration) so a crash-redelivered run re-inserts the SAME id and
  // conflicts on the primary key (onConflictDoNothing) instead of duplicating
  // the effect — exactly-once per (run, node, iteration). `context.loop.index`
  // is the loop iteration when this step runs inside a loop body, undefined
  // otherwise (it threads through the existing per-item loop context — no new
  // plumbing). `attribution.nodeId` is always supplied by both call sites; the
  // undefined-guard just falls back to a random id rather than crashing.
  const idemNodeId = attribution?.nodeId;
  const outputIdemId = (kind: string): string | undefined =>
    idemNodeId === undefined
      ? undefined
      : deterministicUuidV5(
          `${kind}:${automationContext.automationRunId}:${idemNodeId}:${context.loop?.index ?? "-"}`
        );

  switch (data.outputType) {
    case "entity_create": {
      const profileSlug = (config.profileSlug as string) ?? "note";
      const title = config.title as string;
      const properties = (config.properties ?? {}) as Record<string, unknown>;
      // Optional SYSTEM DATA — machine state stamped on the created row's
      // `entities.system_data` column, never rendered as a user-editable
      // property. This is what lets a generator mark the entity it just
      // produced (run id, source cursor, an idempotency stamp another worker
      // reads back) without polluting the entity's schema-validated
      // `properties`. Templates inside it resolve for free: the WHOLE `config`
      // object already went through `deepResolveTemplates` at the top of this
      // function, exactly like `properties`, so `{{steps.x.output}}` works at
      // any depth here with no extra plumbing.
      // Absent → `undefined` → `EntityRepository.create` applies its `{}`
      // default, i.e. byte-for-byte the previous behavior.
      // CREATE-ONLY: `entity_update` has no counterpart and must not grow one
      // (see MaterializeEntityInput.systemData for why).
      const rawSystemData = config.systemData;
      const systemData =
        rawSystemData &&
        typeof rawSystemData === "object" &&
        !Array.isArray(rawSystemData)
          ? (rawSystemData as Record<string, unknown>)
          : undefined;
      // Optional long-form BODY (markdown), e.g. `body: "{{steps.assemble.output}}"`.
      // When present it is materialized through the canonical body door
      // (EntityBodyService) into a `documents` row linked via
      // `entities.documentId` — or folded into `properties.content` when the
      // heuristic says it is too short to be worth a document. Absent (or
      // whitespace-only) → EVERY line below behaves exactly as before.
      const rawBody = config.body;
      const bodyText =
        typeof rawBody === "string" && rawBody.trim() ? rawBody : undefined;

      // Idempotency + empty-guard. When the node declares `dedupeBy` (a property
      // key, e.g. "url" for bookmarks) we (1) SKIP when that value is empty — so a
      // message with no real link never spawns a blank entity — and (2) SKIP when
      // an entity of this profile already carries that value — so the same link in
      // many messages (or a backfill replay, or the digest re-embedding the
      // conversation) never creates duplicates. We skip BEFORE the governance gate,
      // so a duplicate isn't even proposed. Pod-scoped profiles (bookmark is one)
      // can live with workspaceId NULL, so match either.
      const dedupeBy = config.dedupeBy as string | undefined;
      if (dedupeBy) {
        const rawVal = properties[dedupeBy];
        const dedupeStr = rawVal == null ? "" : String(rawVal).trim();
        if (!dedupeStr) {
          return {
            status: "skipped",
            reason: `empty ${dedupeBy} — not creating`,
          };
        }
        const [existing] = await db
          .select({ id: entities.id })
          .from(entities)
          .where(
            and(
              or(
                eq(entities.workspaceId, workspaceId),
                isNull(entities.workspaceId)
              ),
              eq(entities.type, profileSlug),
              isNull(entities.deletedAt),
              drizzleSql`${entities.properties}->>${dedupeBy} = ${dedupeStr}`
            )
          )
          .limit(1);
        if (existing) {
          return {
            status: "skipped",
            reason: "duplicate",
            entityId: existing.id,
          };
        }
      }

      // Governed by the same policy as chat-AI writes (see automation-governance.ts):
      // auto-approve, or a PENDING proposal attributed to the owning agent.
      const gate = await checkAutomationWriteOrPropose({
        ownerId,
        workspaceId,
        subjectType: "entity",
        action: "create",
        // The body travels WITH the proposal under `content` — the key the
        // approve path reads (`materializeEntity`'s `data.content`, and
        // approve-executors "entity/create"), so it is carried alongside
        // profileSlug/title/properties rather than being dropped at propose time.
        // Materializing at propose time instead would orphan a document + storage
        // object whenever the proposal is rejected.
        //
        // ⚠️ KNOWN PRE-EXISTING BUG, NOT INTRODUCED HERE, and it gates this
        // branch end-to-end: `proposeAutomationWrite` persists `data` FLAT
        // (jobs/src/utils/automation-governance.ts), while the entity/create
        // approve executor reads a NESTED envelope (`proposal.data?.data`,
        // approve-executors.ts) — the nesting the canonical chat door
        // (`checkPermissionOrPropose`) produces and the automation path bypasses.
        // Verified against live pod proposals, which are nested. So approving ANY
        // automation entity_create proposal currently throws "missing profileSlug",
        // body or not. Not reached on the default path because `entity.create` IS
        // in DEFAULT_AUTO_APPROVE (automations execute entity writes directly);
        // it bites `forceProposeWrites` sessions and tightened workspaces.
        // When the shape is fixed, `content` must land at `data.data.content` —
        // it sits alongside the other keys here, so a nesting fix carries it.
        data: {
          profileSlug,
          title,
          properties,
          ...(bodyText ? { content: bodyText } : {}),
          // Carried on the proposal so a force-propose workspace doesn't
          // SILENTLY lose the stamp. ⚠️ The entity/create approve executor
          // (api, approve-executors.ts) does not read this key yet — same
          // situation as `content` above; when the flat-vs-nested payload bug
          // there is fixed, `systemData` must be read alongside it. Omitted
          // entirely when unset, so the payload is unchanged for every
          // existing flow.
          ...(systemData ? { systemData } : {}),
        },
        reasoning: "Automation proposed creating an entity.",
        subjectProfileSlug: profileSlug,
        automationRunId: automationContext.automationRunId,
        correlationId: automationContext.rootRunId,
        sessionId: automationContext.focusSessionId,
        stepRunId: attribution?.stepRunId,
        nodeId: attribution?.nodeId,
      });
      if ("denied" in gate) {
        throw new Error(`entity_create denied by governance: ${gate.reason}`);
      }
      if ("proposed" in gate) {
        // SAFETY: a proposal was created — do NOT direct-write. The change
        // awaits human review, attributed to the owning agent. The body is NOT
        // materialized here (there is no entity id yet, and a document written
        // now would be an orphan if the proposal is rejected): it is carried on
        // the proposal payload as `content` (above) and materialized by the
        // approve path. `bodyDeferred` makes that visible in the step output.
        return {
          status: "proposed",
          proposalId: gate.proposalId,
          ...(bodyText ? { bodyDeferred: true } : {}),
        };
      }

      // Attribution: this write is authored by the automation's owning
      // principal (`ownerId`). For AI-created automations that principal IS an
      // agent user; for manual automations it is a human. Resolve which, so the
      // materialized row's provenance is honest (previously it defaulted to
      // "human", mis-attributing agent-authored automation writes). We only
      // reach this direct-write branch after the governance gate GRANTED.
      const [ownerUser] = await db
        .select({ userType: users.userType })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1);
      // `correlationId` is carried on the SAME provenance object the document
      // path already uses, so the entity and its body land with identical run
      // attribution — "which run produced this?" is answerable for both.
      const provenance =
        ownerUser?.userType === "agent"
          ? {
              createdByKind: "ai_agent" as const,
              agentUserId: ownerId,
              createdByUserId: ownerId,
              correlationId: automationContext.rootRunId,
            }
          : {
              createdByKind: "system" as const,
              createdByUserId: ownerId,
              correlationId: automationContext.rootRunId,
            };

      // BODY (optional) — materialized through the canonical door BEFORE the
      // entity row is inserted, with the row id pre-minted, exactly like the
      // proposal materializer (materializer.ts:327-353). Rationale: the service
      // only needs the id to namespace the storage object (it never reads the
      // entity row), so pre-minting lets the entity be created ONCE already
      // carrying `documentId` — no post-create UPDATE, no window in which the
      // entity exists bodyless, and no second write to fail halfway.
      // FAILURE ISOLATION: setBody's text path catches its own storage/repo
      // failures and folds back to `{ inlineContent }` (entity-body-service.ts
      // :246-254), so a materialization failure degrades to inline content on
      // the entity instead of failing the step or orphaning a document. We add
      // no second layer — doing so would only convert a degraded-but-complete
      // write into a step failure, and pg-boss would retry it into a duplicate
      // entity.
      let documentId: string | undefined;
      let entityProperties = properties;
      // Only pre-mint (and pass) an id on the body path — the no-body path keeps
      // its DB-minted uuid, byte-for-byte the previous behavior.
      const preMintedEntityId = bodyText ? randomUUID() : undefined;

      if (bodyText && preMintedEntityId) {
        const body = await new EntityBodyService(db, eventRepository).setBody({
          entityId: preMintedEntityId,
          userId: ownerId,
          workspaceId: workspaceId ?? null,
          title: title || undefined,
          text: bodyText,
          // Provenance travels verbatim onto the `documents` row — the same
          // agent/system attribution the entity row gets, plus the run's
          // correlation id. Never re-labelled "human".
          provenance: {
            ...provenance,
            createdByUserId: ownerId,
            correlationId: automationContext.rootRunId,
          },
        });
        if (body.documentId) {
          documentId = body.documentId;
        } else if (body.inlineContent !== undefined) {
          // Short body → stays inline on the entity (no document row created).
          entityProperties = { ...properties, content: body.inlineContent };
        }
      }

      // materializeEntity wraps EntityRepository.create: profile resolution,
      // pod-wide scoping, property indexing, event emission — plus provenance.
      const { entity } = await materializeEntity(
        {
          ...(preMintedEntityId ? { id: preMintedEntityId } : {}),
          profileSlug,
          title,
          properties: entityProperties,
          ...(systemData ? { systemData } : {}),
          ...(documentId ? { documentId } : {}),
          workspaceId,
          userId: ownerId,
          skipValidation: true,
        },
        {
          db,
          eventRepo: eventRepository,
          provenance,
        }
      );

      return {
        status: "created",
        entityId: entity.id,
        title: entity.title,
        ...(documentId ? { documentId } : {}),
      };
    }

    case "entity_update": {
      const entityId = config.entityId as string;
      const properties = (config.properties ?? {}) as Record<string, unknown>;

      if (!entityId)
        throw new Error("entity_update requires entityId in config");

      // Look up the target entity's profile slug so profile-scoped governance
      // rules (e.g. "note=auto, lead=propose") can match on UPDATE the same way
      // they already do on CREATE. `entities.type` IS the profile slug — it's
      // populated from `profile.slug` at create time (entity-repository.ts) and
      // used as the profile-slug filter elsewhere (e.g. `eq(entities.type, profileSlug)`
      // in listEntities). Entity-not-found just leaves this undefined, which the
      // gate treats as "no profile match" — never a hard failure.
      const [targetEntity] = await db
        .select({ type: entities.type })
        .from(entities)
        .where(eq(entities.id, entityId))
        .limit(1);

      // Governed — same gate as entity_create above.
      const gate = await checkAutomationWriteOrPropose({
        ownerId,
        workspaceId,
        subjectType: "entity",
        action: "update",
        data: { entityId, properties },
        reasoning: "Automation proposed updating an entity.",
        subjectProfileSlug: targetEntity?.type,
        automationRunId: automationContext.automationRunId,
        correlationId: automationContext.rootRunId,
        sessionId: automationContext.focusSessionId,
        stepRunId: attribution?.stepRunId,
        nodeId: attribution?.nodeId,
      });
      if ("denied" in gate) {
        throw new Error(`entity_update denied by governance: ${gate.reason}`);
      }
      if ("proposed" in gate) {
        // SAFETY: a proposal was created — do NOT direct-write. The change
        // awaits human review, attributed to the owning agent.
        return { status: "proposed", proposalId: gate.proposalId };
      }

      // Route through EntityRepository so validation, entity_property_index
      // reindex, and the workspace-scoped property lens (Phase 2) all run.
      // `skipEvent: true` prevents double-emission — we emit our own
      // automation-context event via emitSideEffects() below, which carries
      // the automationContext metadata the repo doesn't know about.
      const entityRepo = new EntityRepository(db, eventRepository);
      await entityRepo.update(
        entityId,
        {
          properties,
          workspaceId,
          skipEvent: true,
        },
        actingUserId
      );

      await emitSideEffects({
        subjectType: "entity",
        action: "update",
        subjectId: entityId,
        userId: ownerId,
        workspaceId,
        data: { updatedProperties: Object.keys(properties) },
        automationContext,
      });

      return { status: "updated", entityId };
    }

    case "webhook": {
      const url = config.url as string;
      let headers = (config.headers ?? {}) as Record<string, string>;
      const body = config.body ?? config;

      if (!url) throw new Error("webhook output requires url in config");

      // SSRF guard: reject internal/reserved targets BEFORE resolving any
      // vault secrets into headers (never leak a secret to a private address).
      const webhookUrlCheck = validateExternalUrl(url);
      if (!webhookUrlCheck.valid) {
        throw new Error(`webhook output blocked: ${webhookUrlCheck.reason}`);
      }

      // Resolve vault references in headers (e.g., Authorization: vault://secret-id)
      const hasVaultHeaders = Object.values(headers).some(isVaultReference);
      if (hasVaultHeaders) {
        headers = await resolveVaultReferences(headers, ownerId);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);

      try {
        const response = await safeExternalFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        return {
          status: response.ok ? "sent" : "error",
          statusCode: response.status,
          url,
        };
      } catch (err) {
        clearTimeout(timer);
        throw new Error(
          `Webhook POST to ${url} failed: ${err instanceof Error ? err.message : "unknown"}`
        );
      }
    }

    case "notification": {
      // Accepts: config.title + config.body (or config.message as body fallback)
      // Optional: config.entityId (person/entity to link to — stored as sourceId)
      //           config.category ('governance'|'data'|'ai'|'system'|'inbox') — default 'ai'
      //           config.priority ('low'|'normal'|'high'|'urgent') — default 'normal'
      //           config.groupKey — for collapsing similar notifications in the bell panel
      const body = (config.body ?? config.message) as string | undefined;
      const title = (config.title ?? "Automation notification") as string;
      const category = (config.category ?? "ai") as string;
      const priority = (config.priority ?? "normal") as string;
      const entityId = config.entityId as string | undefined;
      const groupKey =
        (config.groupKey as string | undefined) ??
        (entityId
          ? `automation.${automationContext.automationId}.${entityId}`
          : undefined);

      if (!body) {
        logger.warn(
          { workspaceId },
          "notification output missing body/message"
        );
        return { status: "skipped" };
      }

      // Deterministic id (Wave 4.R) so a crash-redelivered run re-inserts the
      // same notification and conflicts on the PK instead of duplicating it.
      await db
        .insert(notifications)
        .values({
          id: outputIdemId("notification") ?? randomUUID(),
          workspaceId,
          userId: ownerId,
          type: "automation.notification",
          title,
          body,
          category: category as any,
          priority: priority as any,
          status: "unread",
          sourceType: "automation",
          // entityId takes priority as sourceId so frontend can deep-link to the entity
          sourceId: entityId ?? automationContext.automationId,
          ...(groupKey ? { groupKey } : {}),
        })
        .onConflictDoNothing({ target: notifications.id });

      return { status: "sent", title, body };
    }

    case "channel_message": {
      // The output channel is CONTEXT-DERIVED, resolved in this precedence:
      //   (a) explicit `config.channelId` → use it, but ONLY after re-validating
      //       it is reachable from the automation's OWN workspace at RUN time
      //       (see the scope check below).
      //   (b) `config.channelEntityRef` (a template expr deep-resolved above to an
      //       ENTITY ID) → the find-or-create INTERNAL channel bound to that entity
      //       (ensureEntityChannel EXCLUDES the external client-comms surface —
      //       "the internal team channel for this entity", never the client↔us one).
      //   (c) `config.channelType`:
      //         'personal_thread' → user's personal thread (channelType=PERSONAL)
      //         'proactive'       → user's feed channel (channelType='feed', feedScope='user')
      //         'subjectEntity'   → THIS run's subject's own channel (== channelEntityRef
      //                             of the run's subjectEntityId; per-client recap spine)
      //   (d) DEFAULT (none of the above) → the automation's own run/session channel
      //       (ensureAutomationRunChannel) — a targetless channel_message NEVER errors.
      let channelId = config.channelId as string | undefined;
      const content = config.content as string;
      const metadata = (config.metadata ?? {}) as Record<string, unknown>;

      if (!content) {
        throw new Error("channel_message requires content");
      }

      // (a) SCOPE RE-VALIDATION — the security boundary for the ONLY branch that
      // takes a caller-supplied destination verbatim. Every other branch derives
      // the channel from run context through a ChannelRepository resolver, and
      // `channelEntityRef` already proves its entity is in scope before
      // resolving; an explicit `config.channelId` skipped ALL of that and the
      // sink (`insertChannelMessage`) is a bare insert with no visibility check,
      // so a definition naming an arbitrary channel uuid posted into it at run
      // time under the owner's identity — surviving lens changes, workspace
      // moves and membership revocation, because nothing re-checked.
      //
      // The predicate is the WRITE twin of the `messages_query` READ check
      // (`executeMessagesQueryStep`): the channel must live in the automation's
      // own workspace or be pod-wide. POD-WIDE AUTOMATION (`workspaceId` null at
      // run time — the cron scheduler dispatches `automation.workspaceId`
      // verbatim, which the payload type under-declares as `string`) names no
      // workspace, so NULL must NOT mean "anything goes": it is restricted to
      // pod-wide channels only. Such a flow reaches a workspace channel via the
      // context-derived paths (`channelEntityRef` / `channelType`), which
      // resolve against the run's own scope.
      //
      // FAIL LOUD rather than falling through to the run channel: a destination
      // the author cannot legitimately reach is a wiring fault, not a transient,
      // and silently redirecting the content to a different channel would hide
      // the misconfiguration while still delivering the payload somewhere the
      // author did not name. This matches the two sibling cross-workspace
      // guards in this file (`messages_query`, `session_update`), which both
      // throw. The "targetless channel_message NEVER errors" contract is
      // untouched — it is about the absence of a target, not an out-of-scope one.
      if (channelId) {
        const inScopeChannel = await db.query.channels.findFirst({
          where: and(
            eq(channels.id, channelId),
            workspaceId
              ? or(
                  eq(channels.workspaceId, workspaceId),
                  isNull(channels.workspaceId)
                )
              : isNull(channels.workspaceId)
          ),
          columns: { id: true },
        });
        if (!inScopeChannel) {
          throw new Error(
            `channel_message: channel ${channelId} is not reachable from ${
              workspaceId
                ? `workspace ${workspaceId}`
                : "this pod-wide automation (pod-wide automations may only target pod-wide channels; use channelEntityRef or channelType instead)"
            } — refusing to post. Re-select the destination channel on this automation.`
          );
        }
      }

      // (b) CONTEXT-DERIVED override: an entity ref (deep-resolved above to a
      // native id — so an exact `{{...}}` placeholder resolved to an entity id
      // works) routes into that entity's INTERNAL channel. Same resolver the
      // 'subjectEntity' channelType uses below — reuse-first, THREAD-on-create,
      // never client-comms.
      if (!channelId && config.channelEntityRef != null) {
        const entityId =
          typeof config.channelEntityRef === "string"
            ? config.channelEntityRef.trim()
            : "";
        // A channelEntityRef that did NOT resolve to a real entity id — empty, an
        // unresolved `{{...}}` placeholder, or a stale/wrong id — must not dangle a
        // channel bound to a nonexistent entity, nor throw the whole run. It falls
        // through to the DEFAULT run channel (d) below, consistent with the
        // "targetless channel_message never errors" contract. We route to the
        // entity's channel ONLY when the entity actually exists in this scope.
        if (entityId) {
          const [entityRow] = await db
            .select({ id: entities.id })
            .from(entities)
            .where(
              and(
                eq(entities.id, entityId),
                or(
                  eq(entities.workspaceId, workspaceId),
                  isNull(entities.workspaceId)
                ),
                isNull(entities.deletedAt)
              )
            )
            .limit(1);
          if (entityRow) {
            channelId = (
              await new ChannelRepository(db).ensureEntityChannel(
                entityId,
                ownerId,
                workspaceId
              )
            ).id;
          }
          // else: unknown/unresolved ref → leave channelId unset so the default
          // run channel (d) receives the message rather than a dangling void.
        }
      }

      // Resolve personal thread / proactive feed via the canonical race-safe
      // ChannelRepository resolvers (dedup against the 0182 unique indexes) — not
      // hand-rolled findFirst+insert, which duped and diverged from the api side.
      if (!channelId && config.channelType === "personal_thread") {
        channelId = (
          await new ChannelRepository(db).ensureUserPersonalChannel(ownerId)
        ).id;
      }

      if (!channelId && config.channelType === "proactive") {
        channelId = (
          await new ChannelRepository(db).ensureProactiveFeedChannel(ownerId)
        ).id;
      }

      // Post into THIS run's subject's own channel — the write-twin of the
      // entity-bound read, via the same ChannelRepository resolver the executor's
      // per_entity routing uses (reuse-first, THREAD-on-create, never client-comms).
      if (!channelId && config.channelType === "subjectEntity") {
        if (!runSubjectEntityId) {
          throw new Error(
            "channel_message channelType:'subjectEntity' requires the run to have a subjectEntityId"
          );
        }
        channelId = (
          await new ChannelRepository(db).ensureEntityChannel(
            runSubjectEntityId,
            ownerId,
            workspaceId
          )
        ).id;
      }

      // (d) DEFAULT — no explicit target resolved: post to the automation's own
      // run/session channel (the auto-given per-automation feed — the SAME channel
      // post-run-summary routes to via ensureAutomationRunChannel). A targetless
      // channel_message lands here rather than throwing.
      if (!channelId) {
        channelId = (
          await new ChannelRepository(db).ensureAutomationRunChannel(
            automationContext.automationId,
            ownerId,
            workspaceId
          )
        ).id;
      }

      if (!channelId) {
        // Unreachable for a real run — ensureAutomationRunChannel always resolves
        // or creates. Keep a clear error rather than posting to nowhere.
        throw new Error(
          "channel_message could not resolve a target channel (no channelId/channelEntityRef/channelType, and no automation run channel)"
        );
      }

      // Tag proactive channel messages so the feed can identify their type
      // without needing to know which channel they came from.
      const proactiveType =
        config.channelType === "proactive"
          ? (metadata.proactiveType ?? config.proactiveType ?? "insight")
          : undefined;

      // ONE door (Wave 4.R): insertChannelMessage owns the canonical tamper-hash
      // (computeMessageHash(id, content)) AND the Discord mirror + firewall — no
      // hand-rolled insert. Pass a DETERMINISTIC id so a crash-redelivered run
      // re-inserts the same id and no-ops on the PK (the door's
      // onConflictDoNothing) instead of double-posting. The mirror is
      // BOT-authored (authorType default) so the firewall blocks it from any
      // client-comms channel (team/feed only) and no-ops on internal channels —
      // same behavior the previous explicit mirror had.
      const messageId = outputIdemId("channel_message") ?? randomUUID();
      const result = await insertChannelMessage({
        id: messageId,
        channelId,
        content,
        metadata: {
          automationMessage: true,
          ...(proactiveType ? { proactiveType, proactiveAi: true } : {}),
          ...metadata,
          ...automationContext,
        },
      });
      if (result.mirrored) {
        logger.info(
          { channelId },
          "automation channel_message mirrored to Discord"
        );
      }

      // Return the deterministic id we inserted (not the door's result, which is
      // undefined when the insert conflicted on a retry) so downstream steps get
      // a stable reference either way.
      return { status: "sent", messageId, channelId };
    }

    case "session_update": {
      // Drive a focus session from inside a flow: advance its stage, maintain a
      // grantStatus bag in metadata, or append an expected output. Resolve the
      // session by explicit id, else the active focus_session bound to the
      // subject entity. Governed by the SAME agent policy as entity_update.
      const sessionId = config.sessionId as string | undefined;
      const subjectEntityId = config.subjectEntityId as string | undefined;
      const currentStage = config.currentStage as string | undefined;
      const grantStatus = config.grantStatus as unknown;
      const addOutput = config.addOutput as
        { kind: string; label: string; icon?: string } | undefined;

      let session: typeof focusSessions.$inferSelect | undefined;
      if (sessionId) {
        session = await db.query.focusSessions.findFirst({
          where: eq(focusSessions.id, sessionId),
        });
      } else if (subjectEntityId) {
        session = await db.query.focusSessions.findFirst({
          where: and(
            eq(focusSessions.subjectEntityId, subjectEntityId),
            eq(focusSessions.status, "active")
          ),
          orderBy: [desc(focusSessions.startedAt)],
        });
      }

      if (!session) {
        return { status: "skipped", reason: "no matching session" };
      }

      // Cross-workspace guard: only mutate a session in the automation's
      // workspace (or a pod-wide NULL-workspace session). Mirrors the
      // playbook_run subject IDOR guard — the column has no FK.
      if (session.workspaceId && session.workspaceId !== workspaceId) {
        throw new Error(
          `session_update: session ${session.id} not visible in workspace ${workspaceId}`
        );
      }

      // Governed — same gate as entity_create / entity_update above.
      const gate = await checkAutomationWriteOrPropose({
        ownerId,
        workspaceId,
        subjectType: "focus_session",
        action: "update",
        data: { id: session.id, currentStage, grantStatus, addOutput },
        reasoning: "Automation proposed updating a focus session.",
        automationRunId: automationContext.automationRunId,
        correlationId: automationContext.rootRunId,
        sessionId: automationContext.focusSessionId,
        stepRunId: attribution?.stepRunId,
        nodeId: attribution?.nodeId,
      });
      if ("denied" in gate) {
        throw new Error(`session_update denied by governance: ${gate.reason}`);
      }
      if ("proposed" in gate) {
        // SAFETY: a proposal was created — do NOT direct-write.
        return { status: "proposed", proposalId: gate.proposalId };
      }

      const set: Partial<typeof focusSessions.$inferInsert> = {
        updatedAt: new Date(),
      };

      const stageChanged =
        currentStage !== undefined && currentStage !== session.currentStage;
      if (stageChanged) set.currentStage = currentStage;

      // grantStatus → shallow-merge into session.metadata under `grantStatus`.
      if (grantStatus !== undefined) {
        const existingMeta =
          (session.metadata as Record<string, unknown> | null) ?? {};
        set.metadata = { ...existingMeta, grantStatus };
      }

      // addOutput → append to expectedOutputs (status 'pending'); read-modify-write.
      if (addOutput) {
        const existingOutputs = Array.isArray(session.expectedOutputs)
          ? (session.expectedOutputs as Array<Record<string, unknown>>)
          : [];
        set.expectedOutputs = [
          ...existingOutputs,
          {
            kind: addOutput.kind,
            label: addOutput.label,
            ...(addOutput.icon ? { icon: addOutput.icon } : {}),
            status: "pending",
          },
        ];
      }

      await db
        .update(focusSessions)
        .set(set)
        .where(eq(focusSessions.id, session.id));

      // Stage transition side-effect — mirror rest/focus-sessions.ts:503-524 so
      // automations can react (and filter on toStage). Only when stage changed.
      if (stageChanged) {
        emitSideEffects({
          subjectType: "focus_session",
          action: "stage_changed",
          subjectId: session.id,
          userId: ownerId,
          workspaceId: session.workspaceId,
          data: {
            sessionId: session.id,
            subjectId: session.subjectEntityId,
            playbookId: session.playbookId,
            fromStage: session.currentStage,
            toStage: currentStage,
            workspaceId: session.workspaceId,
            userId: ownerId,
          },
        }).catch((err) => {
          logger.warn(
            { err, sessionId: session.id },
            "session_update: stage_changed emit failed (non-fatal)"
          );
        });
      }

      // MIRROR: when the stage-advance actually APPLIED (direct write, not a
      // proposal) and this session drives a playbook for a subject entity, keep
      // that entity's enrollment step truthful so the funnel reflects the new
      // stage. Rides the already-authorized stage-advance — same actor, same
      // run — so it introduces no new governed-write surface. `currentStep` is
      // the string shape deriveStepKey() reads. Merge into existing step_state
      // via the jsonb `||` operator (drizzleSql, per backend rule). Best-effort:
      // a mirror failure must never fail the underlying stage-advance.
      if (stageChanged && session.playbookId && session.subjectEntityId) {
        try {
          await db
            .update(playbookEnrollments)
            .set({
              stepState: drizzleSql`${
                playbookEnrollments.stepState
              } || ${JSON.stringify({ currentStep: currentStage })}::jsonb`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(playbookEnrollments.playbookId, session.playbookId),
                eq(playbookEnrollments.entityId, session.subjectEntityId)
              )
            );
        } catch (err) {
          logger.warn(
            {
              err,
              playbookId: session.playbookId,
              entityId: session.subjectEntityId,
            },
            "session_update: enrollment step mirror failed (non-fatal)"
          );
        }
      }

      return {
        status: "updated",
        sessionId: session.id,
        ...(stageChanged ? { stageChanged: true, toStage: currentStage } : {}),
      };
    }

    case "set_state": {
      // Persist per-automation state (watermark/cursor). `config` is a merge
      // object (after template resolution) that is shallow-merged onto the
      // automations.state jsonb via `||`. Author-controlled (explicit node) —
      // NOT automatic. Templates in the config (e.g. {{steps.x.output.max}})
      // are already resolved above.
      //
      // CONCURRENCY: two overlapping runs of the same automation both do
      // `state || <their patch>`. The DB serializes the two UPDATEs, so the
      // second overwrites keys the first set to a different value (last-writer
      // wins per key). Keys the two runs don't share are both preserved. There
      // is no read-modify-write in app code — the merge is a single atomic SQL
      // statement — so no lost-update beyond that last-writer-per-key semantics.
      // Acceptable for watermark/cursor use (monotonic advance): design the
      // patch so the newest run carries the highest watermark.
      const automationId = context.automation.id;
      const patch = (config ?? {}) as Record<string, unknown>;

      const [updated] = await db
        .update(automations)
        .set({
          state: drizzleSql`${automations.state} || ${JSON.stringify(
            patch
          )}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, automationId))
        .returning({ state: automations.state });

      // Reflect the merge into the live run context so later nodes in THIS run
      // see the new value via {{automation.state.<key>}}.
      if (updated?.state) {
        context.automation.state = updated.state as Record<string, unknown>;
      }

      return { status: "state_set", keys: Object.keys(patch) };
    }

    // ── Kind + Facets / graph (Wave 4.V2) ─────────────────────────────────────
    // Declarative wrappers over the governed builtin verbs — the config becomes
    // the verb's params. Idempotency (safe under at-least-once redelivery):
    //   facet_attach   → entity_facet.attach → FacetRepository.attach conflicts on
    //     the (entity, profile, contextEntityId, workspace) unique index and
    //     returns the existing row — a re-run re-attaches nothing.
    //   facet_update   → entity_facet.update → property MERGE + status set; a
    //     re-run writes the same values (naturally idempotent).
    //   facet_detach   → entity_facet.detach → soft-delete; a re-run after the
    //     facet is gone is a no-op (slug-resolution returns none → noop).
    //   relation_create→ graph.link → relations.create → createLinks
    //     (onConflictDoNothing) — a re-run inserts no duplicate edge.
    case "facet_attach":
      // config: { entityId, facetSlug, properties?, workspaceId?, contextEntityId? }
      return dispatchOutputVerb(
        "entity_facet.attach",
        config,
        workspaceId,
        actingUserId
      );

    case "facet_update":
      // config: { facetId | (entityId + facetSlug), status?, properties?, workspaceId? }
      return dispatchOutputVerb(
        "entity_facet.update",
        config,
        workspaceId,
        actingUserId
      );

    case "facet_detach":
      // config: { facetId | (entityId + facetSlug) }
      return dispatchOutputVerb(
        "entity_facet.detach",
        config,
        workspaceId,
        actingUserId
      );

    case "relation_create":
      // config: { fromEntityId, toEntityId, relationType }
      if (config.dedupe !== false) {
        const [existing] = await db
          .select({ id: relations.id })
          .from(relations)
          .where(
            and(
              eq(relations.sourceEntityId, config.fromEntityId as string),
              eq(relations.targetEntityId, config.toEntityId as string),
              eq(relations.type, config.relationType as string),
              or(
                eq(relations.workspaceId, workspaceId),
                isNull(relations.workspaceId)
              )
            )
          )
          .limit(1);
        if (existing)
          return {
            status: "skipped",
            reason: "duplicate",
            relationId: existing.id,
          };
      }
      return dispatchOutputVerb(
        "graph.link",
        config,
        workspaceId,
        actingUserId
      );

    default:
      logger.warn({ outputType: data.outputType }, "Unknown output type");
      return { status: "unknown_output_type", outputType: data.outputType };
  }
}

// ── New Step Executors ───────────────────────────────────────────────────────

/**
 * Execute a transform step.
 * Supports pipe-style expressions: "{{nodeId.output.field}} | uppercase"
 * Scalar pipes: uppercase, lowercase, json, trim, url_extract, to_ms (date→epoch-ms)
 * Array-aware pipes (input must be an array; non-array → treated as []):
 *   filter:<predicate>  keep items where the predicate is true (each item is
 *                       exposed as `item`, e.g. "filter:item.score > 5")
 *   map:<expr>          transform each item ("map:{{item.title}}")
 *   unique              dedupe by JSON identity
 *   slice:<n>           keep the first n items
 */
export function executeTransformStep(
  data: { expression: string },
  context: StepContext
): Record<string, unknown> {
  const expr = data.expression.trim();

  // Split on " | " to find pipe operations
  const pipeIdx = expr.indexOf(" | ");
  if (pipeIdx === -1) {
    // No pipe — resolve the expression as a template and return it
    const resolved = resolveTemplate(expr, context);
    return { result: resolved };
  }

  const templatePart = expr.slice(0, pipeIdx).trim();
  const pipePart = expr.slice(pipeIdx + 3).trim();

  // Resolve the template variable (or literal) before the pipe
  let value: unknown;
  // If it looks like a plain {{...}} reference, resolve the raw path value (not
  // stringified). Uses the SHARED matcher — this site was missed when the
  // both-ends-anchored `/^\{\{(.+?)\}\}$/` was replaced elsewhere, and a
  // transform whose pre-pipe part held two placeholders (`"{{a}} {{b}} | trim"`)
  // would still have captured the junk path `a}} {{b` and yielded undefined.
  // Four call sites, not three: that is why the matcher is a named export
  // rather than a regex written out per site.
  const templateMatch = matchWholeStringReference(templatePart);
  if (templateMatch !== null) {
    value = resolveReferencePath(templateMatch, context);
  } else {
    value = resolveTemplate(templatePart, context);
  }

  // Apply each pipe in sequence (supports chaining: "| trim | uppercase")
  const pipes = pipePart.split("|").map((p) => p.trim());
  let current: unknown = value;

  for (const pipe of pipes) {
    // Array-aware pipes take an argument after ":" — split name from arg.
    // Scalar pipes below have no ":" so `pipeName` === `pipe` for them.
    const colonIdx = pipe.indexOf(":");
    const pipeName = colonIdx === -1 ? pipe : pipe.slice(0, colonIdx).trim();
    const pipeArg = colonIdx === -1 ? "" : pipe.slice(colonIdx + 1).trim();

    // ── Array-aware pipes ───────────────────────────────────────────────
    // Operate on an array input; a non-array input is treated as empty so a
    // flow that expected a list degrades to [] rather than throwing.
    if (
      pipeName === "filter" ||
      pipeName === "map" ||
      pipeName === "unique" ||
      pipeName === "slice"
    ) {
      const arr = Array.isArray(current) ? current : [];
      switch (pipeName) {
        case "filter": {
          // Reuse the shared predicate evaluator. Each item is exposed as
          // `item` (and `loop.item`) in a per-item context so the predicate
          // can reference `item.<field>` — e.g. "filter:item.score > 5".
          current = arr.filter((item, index) => {
            const itemContext: StepContext = {
              ...context,
              loop: { item, index },
              item,
            };
            return evaluateCondition(pipeArg, itemContext);
          });
          break;
        }
        case "map": {
          // Resolve `pipeArg` as a template per item, exposing `item`. Returns
          // the raw resolved value when the arg is a single `{{...}}` ref,
          // otherwise the interpolated string.
          const singleRef = matchWholeStringReference(pipeArg);
          current = arr.map((item, index) => {
            const itemContext: StepContext = {
              ...context,
              loop: { item, index },
              item,
            };
            return singleRef !== null
              ? resolveReferencePath(singleRef, itemContext)
              : resolveTemplate(pipeArg, itemContext);
          });
          break;
        }
        case "unique": {
          // Dedupe by JSON identity so objects/arrays compare structurally.
          const seen = new Set<string>();
          current = arr.filter((item) => {
            const key =
              typeof item === "object" && item !== null
                ? JSON.stringify(item)
                : String(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          break;
        }
        case "slice": {
          const n = Number(pipeArg);
          current = Number.isFinite(n) ? arr.slice(0, n) : arr;
          break;
        }
      }
      continue;
    }

    // ── Scalar pipes (unchanged) ────────────────────────────────────────
    switch (pipe) {
      case "uppercase":
        current =
          typeof current === "string"
            ? current.toUpperCase()
            : String(current ?? "").toUpperCase();
        break;
      case "lowercase":
        current =
          typeof current === "string"
            ? current.toLowerCase()
            : String(current ?? "").toLowerCase();
        break;
      case "json":
        current = JSON.stringify(current);
        break;
      case "trim":
        current =
          typeof current === "string"
            ? current.trim()
            : String(current ?? "").trim();
        break;
      case "url_extract": {
        const text =
          typeof current === "string" ? current : String(current ?? "");
        // Strip trailing sentence punctuation/brackets so "see https://x.com."
        // yields "https://x.com" (not the broken "https://x.com.").
        current = (text.match(/https?:\/\/[^\s>]+/g) ?? []).map((u) =>
          u.replace(/[.,!?;:'")\]}>]+$/, "")
        );
        break;
      }
      case "date_ms":
      case "to_ms": {
        // Parse a date STRING (ISO-8601 or RFC-2822 — the shape gmail_search
        // returns in the `date` header) to epoch milliseconds, so a watermark
        // filter can compare it numerically (e.g. `item.dateMs > automation.
        // state.lastProcessedMs`). Date.parse handles BOTH grammars natively.
        const text =
          typeof current === "string" ? current : String(current ?? "");
        const ms = Date.parse(text.trim());
        // Unparseable → 0 sentinel (a stable, comparable value) rather than NaN
        // (which would make every numeric compare silently false) or a throw
        // (which would fail the whole flow on one bad date header).
        current = Number.isNaN(ms) ? 0 : ms;
        break;
      }
      default:
        logger.warn({ pipe }, "transform: unknown pipe operation — skipping");
    }
  }

  return { result: current };
}

/**
 * Execute a fetch step: makes an HTTP request and returns status + body.
 */
async function executeFetchStep(
  data: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  },
  context: StepContext,
  ownerId: string
): Promise<Record<string, unknown>> {
  // Resolve template variables in url, headers, body
  const resolvedUrl = resolveTemplate(data.url, context);
  const resolvedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.headers ?? {})) {
    resolvedHeaders[k] = resolveTemplate(v, context);
  }
  const resolvedBody = data.body
    ? resolveTemplate(data.body, context)
    : undefined;

  // Resolve vault references in header values (e.g., Authorization: vault://secret-id)
  const hasVaultHeaders = Object.values(resolvedHeaders).some(isVaultReference);
  const finalHeaders = hasVaultHeaders
    ? await resolveVaultReferences(resolvedHeaders, ownerId)
    : resolvedHeaders;

  // Parse body as JSON if valid, else send as raw string
  let bodyPayload: string | undefined;
  if (resolvedBody) {
    bodyPayload = resolvedBody;
    if (!finalHeaders["Content-Type"] && !finalHeaders["content-type"]) {
      try {
        JSON.parse(resolvedBody);
        finalHeaders["Content-Type"] = "application/json";
      } catch {
        // Not JSON — leave Content-Type unset
      }
    }
  }

  if (!resolvedUrl) throw new Error("fetch node: url is required");

  // SSRF guard: the URL is content/template-derived, so an untrusted source
  // could otherwise steer it at an internal address.
  const fetchUrlCheck = validateExternalUrl(resolvedUrl);
  if (!fetchUrlCheck.valid) {
    throw new Error(`fetch node blocked: ${fetchUrlCheck.reason}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await safeExternalFetch(resolvedUrl, {
      method: data.method ?? "GET",
      headers: finalHeaders,
      body: bodyPayload,
      signal: controller.signal,
    });
    clearTimeout(timer);

    // Collect response headers as a plain record
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Parse body as JSON if content-type indicates it, else raw string
    const contentType = response.headers.get("content-type") ?? "";
    let responseBody: unknown;
    if (contentType.includes("application/json")) {
      try {
        responseBody = await response.json();
      } catch {
        responseBody = await response.text();
      }
    } else {
      responseBody = await response.text();
    }

    if (!response.ok) {
      throw new Error(
        `fetch node: HTTP ${response.status} ${response.statusText} from ${resolvedUrl}`
      );
    }

    return {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/** A query node's filter can carry a plain equality value or a `$gt`/`$gte`/
 * `$lt`/`$lte`/`$ne` operator object (the shape AI-authored flows emit for
 * numeric thresholds, e.g. `{ "properties.strengthScore": { "$gt": 30 } }`). */
type QueryFilterOperator = "eq" | "gt" | "gte" | "lt" | "lte" | "ne";

export interface QueryPropertyCondition {
  propKey: string;
  op: QueryFilterOperator;
  value: unknown;
}

/**
 * A filter term that addresses a real `entities` COLUMN rather than a key
 * inside the `properties` jsonb. See `QUERY_COLUMNS` for why this exists.
 *
 * SHAPE NOTE: the two variants are discriminated by the PRESENCE of `column`
 * (narrowed with `"column" in condition`), not by a `kind` tag. That is
 * deliberate — `QueryPropertyCondition` keeps the exact `{ propKey, op, value }`
 * shape it has always had, so nothing that reads the output of
 * `parseQueryFilterConditions` changes meaning or needs a new field.
 * `QueryOrderBy` can afford a `kind` tag because its two arms carry genuinely
 * different payloads (a Drizzle column object vs a string key); here they don't.
 */
export interface QueryColumnCondition {
  column: QueryColumnName;
  op: QueryFilterOperator;
  /**
   * Already coerced to the column's own type at PARSE time: a `Date` for the
   * timestamp columns, the raw value for the text ones. Coercing in the parser
   * (rather than at SQL-build time) is what lets an un-parseable date be
   * DROPPED instead of compiled into a wrong comparison.
   */
  value: unknown;
}

export type QueryCondition = QueryPropertyCondition | QueryColumnCondition;

const QUERY_FILTER_OPERATORS: Record<string, QueryFilterOperator> = {
  $gt: "gt",
  $gte: "gte",
  $lt: "lt",
  $lte: "lte",
  $ne: "ne",
};

/** Strip a redundant leading "properties." some flow authors include on a
 * filter/orderBy key — entity properties are the implicit namespace here. */
function stripPropertiesPrefix(key: string): string {
  return key.startsWith("properties.") ? key.slice("properties.".length) : key;
}

function asQueryFilterObject(
  filter: unknown
): Record<string, unknown> | undefined {
  if (filter && typeof filter === "object" && !Array.isArray(filter)) {
    return filter as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Resolve the profileSlug for a query node. The node contract documents a
 * top-level `profileSlug` field, but AI-authored flows sometimes nest it
 * inside `filter.profileSlug` instead (e.g. `filter: { profileSlug: "person",
 * "properties.strengthScore": { $gt: 30 } }`) — the top-level field is then
 * `undefined`, and calling `resolveTemplate(undefined, …)` crashed with
 * "Cannot read properties of undefined (reading 'replace')" (`String.replace`
 * called on the missing value). Check both locations before resolving.
 */
export function resolveQueryProfileSlug(
  data: { profileSlug?: unknown; filter?: unknown },
  context: StepContext
): string {
  const filterObj = asQueryFilterObject(data.filter);
  const raw =
    (filterObj && typeof filterObj.profileSlug === "string"
      ? filterObj.profileSlug
      : undefined) ??
    (typeof data.profileSlug === "string" ? data.profileSlug : undefined);
  return raw ? resolveTemplate(raw, context) : "";
}

/**
 * Parse a query node's `filter` into property conditions. Supports both the
 * legacy shape — a JSON-stringified flat `{ propertyKey: value }` equality
 * map, resolved via template first — and the object shape AI-authored flows
 * emit directly (`{ profileSlug, "properties.<key>": value | { $gt, … } }`).
 * `profileSlug` is resolved separately (`resolveQueryProfileSlug`) and
 * skipped here. Never throws: an unparseable/empty filter yields `[]`.
 *
 * KEY RESOLUTION — identical precedence to `parseQueryOrderBy`, on purpose, so
 * the two halves of a query node mean the same thing by the same name:
 *  1. An explicit `properties.` prefix ALWAYS means the jsonb blob. The escape
 *     hatch for a workspace whose entities genuinely carry a property called
 *     `updatedAt`.
 *  2. A bare name in `QUERY_COLUMNS` means the real `entities` COLUMN.
 *  3. Anything else is a jsonb property key — what every existing flow already
 *     relies on, so nothing that works today changes meaning.
 *
 * A date-column term whose value will not parse as a date is DROPPED here (see
 * `coerceDateFilterValue`) rather than emitted as a broken comparison.
 */
export function parseQueryFilterConditions(
  filter: unknown,
  context: StepContext
): QueryCondition[] {
  let filterObj = asQueryFilterObject(filter);
  if (!filterObj && typeof filter === "string") {
    const resolved = resolveTemplate(filter, context);
    if (resolved) {
      try {
        filterObj = JSON.parse(resolved) as Record<string, unknown>;
      } catch {
        filterObj = undefined; // unparseable filter — ignore, return unfiltered (defensive)
      }
    }
  }
  if (!filterObj) return [];

  const conditions: QueryCondition[] = [];
  const push = (
    rawKey: string,
    column: QueryColumnName | undefined,
    propKey: string,
    op: QueryFilterOperator,
    value: unknown
  ) => {
    if (!column) {
      conditions.push({ propKey, op, value });
      return;
    }
    if (!QUERY_DATE_COLUMNS.has(column)) {
      conditions.push({ column, op, value });
      return;
    }
    const date = coerceDateFilterValue(value);
    if (!date) {
      logger.warn(
        { filterKey: rawKey, op, value },
        "query node: dropping date-column filter — value is not a parseable date (ISO-8601 string, epoch millis or Date expected)"
      );
      return;
    }
    conditions.push({ column, op, value: date });
  };

  for (const [rawKey, rawValue] of Object.entries(filterObj)) {
    if (rawKey === "profileSlug" || rawValue === undefined || rawValue === null)
      continue;
    // Precedence 1+2: an explicit `properties.` prefix pins the key to jsonb;
    // only a BARE name is eligible to resolve to a real column.
    const column = rawKey.startsWith("properties.")
      ? undefined
      : QUERY_COLUMNS[rawKey as QueryColumnName]
        ? (rawKey as QueryColumnName)
        : undefined;
    const propKey = stripPropertiesPrefix(rawKey);
    if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
      for (const [opKey, opValue] of Object.entries(
        rawValue as Record<string, unknown>
      )) {
        const op = QUERY_FILTER_OPERATORS[opKey];
        if (!op || opValue === undefined || opValue === null) continue;
        push(rawKey, column, propKey, op, opValue);
      }
    } else {
      push(rawKey, column, propKey, "eq", rawValue);
    }
  }
  return conditions;
}

/**
 * Real `entities` COLUMNS a query node may address, mapped to their Drizzle
 * column. An allowlist, not a lookup: `orderBy`/`filter` keys are
 * author-supplied, and an open mapping into `entities` would let a flow read
 * or sort by any column in the table (including ones the SELECT does not
 * expose, e.g. `user_id`).
 *
 * `createdAt`/`updatedAt` are the reason this exists — they are timestamp
 * COLUMNS, never mirrored into the `properties` jsonb, so before this an
 * `orderBy: "updatedAt"` was silently read as the property `updatedAt`,
 * matched nothing, produced NULL for every row, and left the result in
 * arbitrary order WHILE LOOKING LIKE IT WORKED. That is the same
 * silently-wrong failure mode as the 2026-07-27 null-projection bug, so it
 * gets a real fix rather than a workaround.
 *
 * ONE ALLOWLIST FOR BOTH HALVES, deliberately (it was ORDER-only when the
 * ordering half was fixed; the FILTER half then shipped the identical bug —
 * `filter: { updatedAt: { $gt: … } }` compiled to `properties->>'updatedAt'`
 * and matched ZERO rows). Splitting it into an order-list and a filter-list
 * would let the two drift, and a key that is sortable but not filterable (or
 * the reverse) is a distinction no flow author can predict — the surprise IS
 * the bug class this fixes. Same names, same precedence, both halves.
 */
const QUERY_COLUMNS = {
  createdAt: entities.createdAt,
  updatedAt: entities.updatedAt,
  title: entities.title,
  type: entities.type,
} as const;

type QueryColumnName = keyof typeof QUERY_COLUMNS;

/**
 * Which of the allowlisted columns are `timestamp`s. Their filter values must
 * be bound as real `Date`s through Drizzle's typed operators — NEVER as
 * `Number(value)` (the old filter path's coercion, which yields NaN for every
 * ISO string) and NEVER interpolated into a `drizzleSql` template (a repo-wide
 * rule: binding a `Date` inside a template has caused live breakage; use
 * `gt()/gte()/lt()/lte()` instead).
 */
const QUERY_DATE_COLUMNS: ReadonlySet<QueryColumnName> = new Set([
  "createdAt",
  "updatedAt",
]);

/**
 * Coerce a filter value for a date column. Accepts an ISO-8601 string (the
 * shape flow authors and `{{now}}`-style templates emit), an epoch-millis
 * number, or an already-materialized `Date`.
 *
 * UN-PARSEABLE VALUES RETURN `undefined`, and the caller DROPS the condition
 * rather than binding `Invalid Date`. Dropping widens the result set, which is
 * visible; binding a broken date narrows it to zero rows silently — the exact
 * failure mode this whole change exists to kill. The drop is logged.
 */
function coerceDateFilterValue(value: unknown): Date | undefined {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export type QueryOrderBy =
  | {
      kind: "column";
      column: (typeof QUERY_COLUMNS)[QueryColumnName];
      dir: "asc" | "desc";
    }
  | { kind: "property"; propKey: string; dir: "asc" | "desc" };

/**
 * Parse a query node's optional `orderBy`/`orderDir` fields. This is the
 * other half of the unresolved-path guard: a missing/non-string `orderBy`
 * yields `undefined` (no ordering applied) rather than ever reaching a
 * `.replace()` call on it.
 *
 * RESOLUTION ORDER, and why:
 *  1. An explicit `properties.` prefix ALWAYS means the jsonb blob. This is
 *     the escape hatch that keeps a workspace whose entities genuinely carry a
 *     property named `updatedAt` addressable and unambiguous.
 *  2. A bare name matching `QUERY_COLUMNS` means the real column.
 *  3. Anything else is a jsonb property key — the behavior every existing flow
 *     already relies on, so nothing that works today changes meaning.
 */
export function parseQueryOrderBy(data: {
  orderBy?: unknown;
  orderDir?: unknown;
}): QueryOrderBy | undefined {
  const raw = typeof data.orderBy === "string" ? data.orderBy.trim() : "";
  if (!raw) return undefined;
  const dir = data.orderDir === "asc" ? "asc" : "desc";

  if (!raw.startsWith("properties.")) {
    const column = QUERY_COLUMNS[raw as QueryColumnName];
    if (column) return { kind: "column", column, dir };
  }

  const propKey = stripPropertiesPrefix(raw);
  if (!propKey) return undefined;
  return { kind: "property", propKey, dir };
}

/** A JSONB property value compared/ordered numerically when it parses as a
 * plain number (so "9" doesn't rank above "30" lexicographically); rows
 * where it doesn't parse — a stored date/text value — fall out of numeric
 * comparisons (NULL) and are left to the caller's text-based fallback. */
function numericPropertyExpr(propKey: string) {
  return drizzleSql`(CASE WHEN ${entities.properties}->>${propKey} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${entities.properties}->>${propKey})::numeric ELSE NULL END)`;
}

/**
 * Compile a COLUMN filter term. Uses Drizzle's typed operators rather than a
 * `drizzleSql` template on purpose: for the timestamp columns the bound value
 * is a real `Date`, and binding a `Date` inside a `drizzleSql` template is a
 * standing repo prohibition (it has broken production before) — `gt()/gte()/
 * lt()/lte()` bind it correctly through the column's own mapper. The text
 * columns go through the same operators for symmetry; `gt`/`lt` on them is
 * plain collation-ordered text comparison, which is well-defined.
 */
function columnConditionSql(condition: QueryColumnCondition): SQL {
  // Widened to the base `Column` on purpose: `QUERY_COLUMNS` is a UNION of four
  // differently-typed Drizzle columns, and TS intersects a union's operator
  // overloads down to `never`. The runtime binding is still the column's own
  // mapper — the widening only stops the compiler from demanding one concrete
  // column type. `value` is already coerced per column at parse time.
  const column = QUERY_COLUMNS[condition.column] as Column;
  const value = condition.value as Date | string;
  switch (condition.op) {
    case "eq":
      return eq(column, value);
    case "ne":
      return ne(column, value);
    case "gt":
      return gt(column, value);
    case "gte":
      return gte(column, value);
    case "lt":
      return lt(column, value);
    case "lte":
      return lte(column, value);
  }
}

function queryConditionSql(condition: QueryCondition) {
  return "column" in condition
    ? columnConditionSql(condition)
    : propertyConditionSql(condition);
}

function propertyConditionSql(condition: QueryPropertyCondition) {
  const { propKey, op, value } = condition;
  if (op === "eq") {
    return drizzleSql`${entities.properties}->>${propKey} = ${String(value)}`;
  }
  if (op === "ne") {
    return drizzleSql`${entities.properties}->>${propKey} != ${String(value)}`;
  }
  const numericExpr = numericPropertyExpr(propKey);
  const numericValue = Number(value);
  switch (op) {
    case "gt":
      return drizzleSql`${numericExpr} > ${numericValue}`;
    case "gte":
      return drizzleSql`${numericExpr} >= ${numericValue}`;
    case "lt":
      return drizzleSql`${numericExpr} < ${numericValue}`;
    case "lte":
      return drizzleSql`${numericExpr} <= ${numericValue}`;
  }
}

/**
 * Execute a query step: queries entities by profile slug with optional
 * filter + orderBy.
 */
async function executeQueryStep(
  data: {
    profileSlug?: string;
    filter?: string | Record<string, unknown>;
    limit: number;
    scope?: string;
    orderBy?: string;
    orderDir?: string;
  },
  context: StepContext,
  workspaceId: string,
  ownerId?: string
): Promise<Record<string, unknown>> {
  const profileSlug = resolveQueryProfileSlug(data, context);
  const limit = Math.min(Math.max(Number(data.limit ?? 20), 1), 100);

  if (!profileSlug) throw new Error("query node: profileSlug is required");

  // Visibility lens = this workspace's rows ∪ pod-wide rows (owner-floored).
  // Pod-scoped kinds (company/person/bookmark…) live at `workspace_id IS NULL`,
  // so a plain `workspace_id = X` read missed them ALL — the bug that made every
  // per-client daily loop fan out over ZERO rows. `entityQueryVisibilityWhere`
  // is the @synap/jobs-local mirror of the canonical `accessScopeWhere` door
  // (packages/api/src/utils/project-scope.ts); see that file for the SSOT.
  // scope "pod" narrows to ONLY pod-wide rows.
  const conditions = [
    eq(entities.type, profileSlug),
    entityQueryVisibilityWhere({
      workspaceId,
      ownerId,
      podOnly: data.scope === "pod",
    }),
  ];

  for (const condition of parseQueryFilterConditions(data.filter, context)) {
    conditions.push(queryConditionSql(condition));
  }

  const baseQuery = db
    .select({
      id: entities.id,
      type: entities.type,
      title: entities.title,
      preview: entities.preview,
      properties: entities.properties,
      createdAt: entities.createdAt,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(and(...conditions));

  const orderBy = parseQueryOrderBy(data);
  // A real column orders by ONE key. A jsonb property needs TWO — numeric-first
  // so "9" doesn't rank above "30", then text for the rows where the value
  // isn't a number. Keeping the two shapes separate is why `QueryOrderBy` is a
  // discriminated union rather than a string with a flag.
  const orderTerms = !orderBy
    ? null
    : orderBy.kind === "column"
      ? [orderBy.dir === "asc" ? asc(orderBy.column) : desc(orderBy.column)]
      : [
          orderBy.dir === "asc"
            ? asc(numericPropertyExpr(orderBy.propKey))
            : desc(numericPropertyExpr(orderBy.propKey)),
          orderBy.dir === "asc"
            ? asc(drizzleSql`${entities.properties}->>${orderBy.propKey}`)
            : desc(drizzleSql`${entities.properties}->>${orderBy.propKey}`),
        ];
  const results = orderTerms
    ? await baseQuery.orderBy(...orderTerms).limit(limit)
    : await baseQuery.limit(limit);

  return { entities: results, count: results.length };
}

function resolveBoundValue(value: unknown, context: StepContext): unknown {
  if (typeof value !== "string") return value;
  const exactReference = matchWholeStringReference(value);
  return exactReference !== null
    ? resolveReferencePath(exactReference, context)
    : resolveTemplate(value, context);
}

async function executeEntityReadStep(
  data: { entityId: string },
  context: StepContext,
  workspaceId: string,
  viewerUserId: string
): Promise<Record<string, unknown>> {
  const entityId = resolveTemplate(data.entityId, context);
  if (!entityId) throw new Error("entity_read node: entityId is required");

  const [entity] = await db
    .select({
      id: entities.id,
      type: entities.type,
      title: entities.title,
      preview: entities.preview,
      properties: entities.properties,
      workspaceId: entities.workspaceId,
      createdAt: entities.createdAt,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .where(
      and(
        eq(entities.id, entityId),
        or(eq(entities.workspaceId, workspaceId), isNull(entities.workspaceId))
      )
    )
    .limit(1);
  if (!entity)
    throw new Error(
      "entity_read node: entity is not visible in this workspace"
    );

  const facets = await db
    .select({
      id: entityFacets.id,
      slug: profiles.slug,
      status: entityFacets.status,
      properties: entityFacets.properties,
      contextEntityId: entityFacets.contextEntityId,
    })
    .from(entityFacets)
    .innerJoin(profiles, eq(profiles.id, entityFacets.profileId))
    .where(
      and(
        eq(entityFacets.entityId, entity.id),
        isNull(entityFacets.deletedAt),
        // Role facets follow the same workspace/pod lens as the entity. A
        // workspace-local role must not influence a run elsewhere in the pod.
        or(
          eq(entityFacets.workspaceId, workspaceId),
          isNull(entityFacets.workspaceId)
        ),
        // Pod-wide facets have a private owner floor; workspace-local facets
        // are visible to members of this already-authorized workspace lens.
        or(
          isNotNull(entityFacets.workspaceId),
          eq(entityFacets.userId, viewerUserId)
        )
      )
    );

  return {
    entity: {
      ...entity,
      facets,
      facetSlugs: facets.map((facet) => facet.slug),
    },
  };
}

async function executeRelatedEntitiesStep(
  data: {
    entityId: string;
    direction?: "outbound" | "inbound" | "both";
    relationTypes?: string[];
    propertyEquals?: Record<string, unknown>;
    propertyAnyEquals?: Record<string, unknown[]>;
    excludeEntityId?: string;
    limit?: number;
  },
  context: StepContext,
  workspaceId: string
): Promise<Record<string, unknown>> {
  const entityId = resolveTemplate(data.entityId, context);
  if (!entityId) throw new Error("related_entities node: entityId is required");
  const direction = data.direction ?? "both";
  const limit = Math.min(Math.max(Number(data.limit ?? 50), 1), 100);
  const endpointPredicate =
    direction === "outbound"
      ? eq(relations.sourceEntityId, entityId)
      : direction === "inbound"
        ? eq(relations.targetEntityId, entityId)
        : or(
            eq(relations.sourceEntityId, entityId),
            eq(relations.targetEntityId, entityId)
          );
  const relationRows = await db
    .select({
      id: relations.id,
      type: relations.type,
      sourceEntityId: relations.sourceEntityId,
      targetEntityId: relations.targetEntityId,
      metadata: relations.metadata,
    })
    .from(relations)
    .where(
      and(
        endpointPredicate,
        or(
          eq(relations.workspaceId, workspaceId),
          isNull(relations.workspaceId)
        ),
        data.relationTypes?.length
          ? inArray(relations.type, data.relationTypes)
          : undefined
      )
    )
    .limit(limit);
  const relatedIds = [
    ...new Set(
      relationRows
        .map((relation) =>
          relation.sourceEntityId === entityId
            ? relation.targetEntityId
            : relation.sourceEntityId
        )
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const excludedEntityId = data.excludeEntityId
    ? String(resolveTemplate(data.excludeEntityId, context) ?? "")
    : "";
  const visibleRelatedIds = excludedEntityId
    ? relatedIds.filter((id) => id !== excludedEntityId)
    : relatedIds;
  if (visibleRelatedIds.length === 0)
    return { entities: [], relations: [], count: 0 };

  const conditions = [
    inArray(entities.id, visibleRelatedIds),
    or(eq(entities.workspaceId, workspaceId), isNull(entities.workspaceId)),
  ];
  for (const [key, rawValue] of Object.entries(data.propertyEquals ?? {})) {
    const value = resolveBoundValue(rawValue, context);
    conditions.push(
      drizzleSql`${entities.properties}->>${key} = ${String(value)}`
    );
  }
  const anyPropertyMatches = Object.entries(
    data.propertyAnyEquals ?? {}
  ).flatMap(([key, rawValues]) =>
    rawValues.map((rawValue) => {
      const value = resolveBoundValue(rawValue, context);
      return drizzleSql`${entities.properties}->>${key} = ${String(value)}`;
    })
  );
  if (anyPropertyMatches.length > 0)
    conditions.push(or(...anyPropertyMatches)!);
  const related = await db
    .select({
      id: entities.id,
      type: entities.type,
      title: entities.title,
      preview: entities.preview,
      properties: entities.properties,
      workspaceId: entities.workspaceId,
    })
    .from(entities)
    .where(and(...conditions))
    .limit(limit);
  return { entities: related, relations: relationRows, count: related.length };
}

/**
 * Atomically reserve a durable key for the current run. It is intentionally a
 * domain-agnostic primitive: templates decide what the key means; the Pod only
 * guarantees one winner and makes retries by that same run safe.
 */
async function executeClaimStep(
  data: { namespace: string; key: string },
  context: StepContext,
  workspaceId: string,
  runId: string
): Promise<Record<string, unknown>> {
  const namespace = String(
    resolveTemplate(data.namespace, context) ?? ""
  ).trim();
  const claimKey = String(resolveTemplate(data.key, context) ?? "").trim();
  if (!namespace || !claimKey) {
    throw new Error("claim node requires a non-empty namespace and key");
  }

  const [inserted] = await db
    .insert(automationClaims)
    .values({ workspaceId, namespace, claimKey, ownerRunId: runId })
    .onConflictDoNothing()
    .returning({ id: automationClaims.id });
  if (inserted)
    return { claimed: true, claimId: inserted.id, ownerRunId: runId };

  const [existing] = await db
    .select({
      id: automationClaims.id,
      ownerRunId: automationClaims.ownerRunId,
    })
    .from(automationClaims)
    .where(
      and(
        eq(automationClaims.namespace, namespace),
        eq(automationClaims.claimKey, claimKey),
        or(
          eq(automationClaims.workspaceId, workspaceId),
          isNull(automationClaims.workspaceId)
        )
      )
    )
    .limit(1);
  if (!existing)
    throw new Error("claim node could not read the conflicting claim");
  // A restarted delivery of the winning run keeps its original decision.
  return {
    claimed: existing.ownerRunId === runId,
    claimId: existing.id,
    ownerRunId: existing.ownerRunId,
  };
}

class WorkflowGuardBlockedError extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(`WORKFLOW_GUARD_BLOCKED:${JSON.stringify(detail)}`);
  }
}

export function executeGuardStep(
  data: GuardNodeDef["data"],
  context: StepContext
): Record<string, unknown> {
  for (const check of data.checks) {
    const value = resolveContextPath(check.path, context);
    const expected = resolveBoundValue(check.equals, context);
    const failed =
      (check.exists !== undefined && (value != null) !== check.exists) ||
      (check.equals !== undefined && value !== expected) ||
      (check.notEquals !== undefined &&
        value === resolveBoundValue(check.notEquals, context)) ||
      (check.arrayIncludes !== undefined &&
        (!Array.isArray(value) ||
          !value.includes(resolveBoundValue(check.arrayIncludes, context)))) ||
      (check.lengthEquals !== undefined &&
        (!Array.isArray(value) || value.length !== check.lengthEquals)) ||
      // `minLength` asserts CONTENT, which `exists` deliberately does not:
      // `exists` is a null check, so "" satisfies it. Strings are trimmed
      // first so a body of whitespace fails like the empty body it is. Any
      // non-string / non-array value fails rather than passing by accident.
      (check.minLength !== undefined &&
        (typeof value === "string"
          ? value.trim().length < check.minLength
          : Array.isArray(value)
            ? value.length < check.minLength
            : true)) ||
      (check.numberGte !== undefined &&
        (!(typeof value === "number") || value < check.numberGte)) ||
      (check.numberLte !== undefined &&
        (!(typeof value === "number") || value > check.numberLte)) ||
      (check.anyOf !== undefined &&
        !check.anyOf.some(
          (candidate) =>
            resolveContextPath(candidate.path, context) ===
            resolveBoundValue(candidate.equals, context)
        ));
    if (failed) {
      throw new WorkflowGuardBlockedError({
        code: "guard_failed",
        path: check.path,
        message: check.message,
        actual: value,
      });
    }
  }
  return { status: "passed", checks: data.checks.length };
}

function executeComputeStep(
  data: {
    operation: "add" | "subtract" | "multiply" | "divide" | "coalesce" | "now";
    left?: unknown;
    right?: unknown;
    values?: unknown[];
  },
  context: StepContext
): Record<string, unknown> {
  if (data.operation === "now") {
    // Manual/event triggers carry a single invocation timestamp. Reusing it
    // makes a delayed/retried step deterministic for the run; system-created
    // runs without one retain the current-time fallback.
    const triggeredAt = resolveContextPath(
      "trigger.payload.timestamp",
      context
    );
    const date = typeof triggeredAt === "string" ? new Date(triggeredAt) : null;
    return {
      result:
        date && !Number.isNaN(date.getTime())
          ? date.toISOString()
          : new Date().toISOString(),
    };
  }
  if (data.operation === "coalesce") {
    for (const value of data.values ?? []) {
      const candidate = Number(resolveBoundValue(value, context));
      if (Number.isFinite(candidate)) return { result: candidate };
    }
    throw new Error("compute node: coalesce found no finite numeric value");
  }
  const left = Number(resolveBoundValue(data.left, context));
  const right = Number(resolveBoundValue(data.right, context));
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error("compute node: operands must resolve to finite numbers");
  }
  if (data.operation === "divide" && right === 0) {
    throw new Error("compute node: cannot divide by zero");
  }
  const result =
    data.operation === "add"
      ? left + right
      : data.operation === "subtract"
        ? left - right
        : data.operation === "multiply"
          ? left * right
          : left / right;
  if (!Number.isFinite(result))
    throw new Error("compute node: result is not finite");
  return { result };
}

/**
 * A finite, typed alternative to branching a whole graph just to select a
 * value. It accepts an already-resolved boolean, or the explicit 0/1 result of
 * a numeric compute node, without becoming an expression evaluator.
 */
export function executeSelectStep(
  data: { when: unknown; ifTrue: unknown; ifFalse: unknown },
  context: StepContext
): Record<string, unknown> {
  const when = resolveBoundValue(data.when, context);
  const predicate =
    typeof when === "boolean"
      ? when
      : when === 0
        ? false
        : when === 1
          ? true
          : undefined;
  if (predicate === undefined) {
    throw new Error("select node: 'when' must resolve to a boolean or 0/1");
  }
  return {
    value: resolveBoundValue(predicate ? data.ifTrue : data.ifFalse, context),
  };
}

/**
 * Total-history ceiling for the `all-channels` fan-out: a chatty client with many
 * bound channels (Discord + email + several meeting transcripts + team thread)
 * must never blow the downstream token budget. After merging every channel's
 * recent `limit` messages chronologically, the OLDEST are dropped past this cap
 * (most-recent kept) and `truncated: true` is set + a warning logged (honesty
 * rule: a silent truncation lies about how complete the gathered context is).
 */
const MESSAGES_QUERY_TOTAL_CEILING = 200;
/** Per-document body-preview cap (chars) so a long doc can't dominate the budget. */
const MESSAGES_QUERY_DOC_BODY_CAP = 4000;
/** Bound the linked-document gather. */
const MESSAGES_QUERY_DOC_LIMIT = 20;

/** One message projected into the node's output shape. */
type MessagesQueryRow = {
  role: string;
  content: string;
  metadata: unknown;
  timestamp: Date | string;
};
function projectMessage(m: MessagesQueryRow) {
  return {
    role: m.role,
    content: m.content,
    authorName:
      (m.metadata as { sender?: { name?: string } } | null)?.sender?.name ??
      null,
    createdAt:
      m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
  };
}

/**
 * Gather the entity's linked documents (title + DB-only body preview) for the
 * `includeDocuments` flag. Mirrors how `getThreadContext` resolves linked
 * entities → documents: candidate documents are the subject entity's OWN body
 * document (`entities.documentId`) PLUS the body documents of entities linked to
 * it (`links` where either endpoint is `(entity, subjectEntityId)`), and the
 * DOCUMENT read is floored by the SAME workspace predicate as every other read
 * in this node. Bodies use `EntityBodyService.getPreview` (DB-only version
 * content, no MinIO fetch).
 */
async function gatherLinkedDocuments(
  subjectEntityId: string,
  workspaceId: string
): Promise<
  Array<{
    documentId: string;
    entityId: string;
    title: string | null;
    body: string | null;
  }>
> {
  // Linked entities (either direction) whose OTHER endpoint is an entity —
  // floored to links the automation's workspace may see (workspace OR pod-wide).
  const linkRows = await db
    .select({
      fromType: links.fromType,
      fromId: links.fromId,
      toType: links.toType,
      toId: links.toId,
    })
    .from(links)
    .where(
      and(
        or(eq(links.workspaceId, workspaceId), isNull(links.workspaceId)),
        or(
          and(eq(links.fromType, "entity"), eq(links.fromId, subjectEntityId)),
          and(eq(links.toType, "entity"), eq(links.toId, subjectEntityId))
        )
      )
    )
    .limit(100);

  const entityIds = new Set<string>([subjectEntityId]);
  for (const l of linkRows) {
    if (
      l.fromType === "entity" &&
      l.fromId === subjectEntityId &&
      l.toType === "entity"
    )
      entityIds.add(l.toId);
    if (
      l.toType === "entity" &&
      l.toId === subjectEntityId &&
      l.fromType === "entity"
    )
      entityIds.add(l.fromId);
  }

  const entityRows = await db.query.entities.findMany({
    where: and(
      inArray(entities.id, [...entityIds]),
      or(eq(entities.workspaceId, workspaceId), isNull(entities.workspaceId)),
      isNull(entities.deletedAt)
    ),
    columns: { id: true, title: true, documentId: true },
  });
  const docToEntity = new Map<
    string,
    { entityId: string; entityTitle: string | null }
  >();
  for (const e of entityRows) {
    if (e.documentId)
      docToEntity.set(e.documentId, {
        entityId: e.id,
        entityTitle: e.title ?? null,
      });
  }
  const documentIds = [...docToEntity.keys()];
  if (documentIds.length === 0) return [];

  // Content gate: documents are read through the SAME workspace floor.
  const docRows = await db.query.documents.findMany({
    where: and(
      inArray(documents.id, documentIds),
      or(eq(documents.workspaceId, workspaceId), isNull(documents.workspaceId)),
      isNull(documents.deletedAt)
    ),
    columns: { id: true, title: true },
    limit: MESSAGES_QUERY_DOC_LIMIT,
  });

  const bodyService = new EntityBodyService(db, eventRepository);
  const out: Array<{
    documentId: string;
    entityId: string;
    title: string | null;
    body: string | null;
  }> = [];
  for (const d of docRows) {
    const preview = await bodyService.getPreview(d.id);
    const owner = docToEntity.get(d.id);
    out.push({
      documentId: d.id,
      entityId: owner?.entityId ?? subjectEntityId,
      title: d.title ?? owner?.entityTitle ?? null,
      body: preview ? preview.slice(0, MESSAGES_QUERY_DOC_BODY_CAP) : null,
    });
  }
  return out;
}

/**
 * Execute a messages_query SOURCE step: read a client's stored chat messages.
 *
 * Resolution: an explicit `channelId` wins; otherwise, for `subjectEntityId`:
 *   - DEFAULT `scope: "single-external"` — the single EXTERNAL client-comms
 *     channel bound to the entity (today's exact, unchanged behavior). An entity
 *     often has BOTH a team THREAD and an EXTERNAL client-comms channel bound to
 *     the same contextObjectId; the default reads the EXTERNAL one only.
 *   - `scope: "all-channels"` — the "gathering primitive": EVERY channel bound
 *     to the entity (optionally filtered by `channelTypes` / `branchPurpose`),
 *     each channel's recent history MERGED chronologically, each message tagged
 *     with its `source` channel so a downstream `ai.generate` can attribute it.
 *
 * ACCESS FLOOR (mandatory, identical in every branch): a channel/document must
 * live in the automation's workspace OR be pod-wide (workspace_id NULL). This is
 * the SAME `or(eq(workspaceId, ws), isNull(workspaceId))` predicate the
 * single-channel path has always used and that the access layer / `channel.resolve`
 * enforce — the fan-out never widens it. (jobs cannot import @synap/api's
 * `channel.resolve` / `queryChannelMessages` — a documented circular dep — so the
 * SAME query SHAPE + SAME floor is applied here over @synap/database directly,
 * generalizing this node's own existing channel query rather than adding a new
 * channel-resolution philosophy.)
 *
 * DEFAULT output (single channel):
 * `{ messages: [{ role, content, authorName, createdAt }], channelId, count }`.
 * FAN-OUT output is a SUPERSET (see MessagesQueryNodeDef doc). `includeDocuments`
 * adds `documents` in either mode.
 */
export async function executeMessagesQueryStep(
  data: {
    subjectEntityId?: string;
    channelId?: string;
    limit?: number;
    scope?: string;
    channelTypes?: string[];
    branchPurpose?: string;
    includeDocuments?: boolean;
  },
  context: StepContext,
  workspaceId: string
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Number(data.limit ?? 40), 1), 200);

  // The id fields may reference trigger payload / prior step outputs.
  const subjectEntityId = data.subjectEntityId
    ? resolveTemplate(data.subjectEntityId, context) || undefined
    : undefined;
  let channelId = data.channelId
    ? resolveTemplate(data.channelId, context) || undefined
    : undefined;

  // Additive linked-document gather (either mode; requires a resolved subject).
  const documentsOut =
    data.includeDocuments && subjectEntityId
      ? await gatherLinkedDocuments(subjectEntityId, workspaceId)
      : undefined;
  const withDocs = (out: Record<string, unknown>): Record<string, unknown> =>
    documentsOut ? { ...out, documents: documentsOut } : out;

  // ---- FAN-OUT: scope="all-channels" over a subject entity (no explicit channelId) ----
  if (data.scope === "all-channels" && !channelId && subjectEntityId) {
    const typeFilter = data.channelTypes?.length
      ? or(
          ...data.channelTypes.map(
            (t) => drizzleSql`${channels.channelType} = ${t}`
          )
        )
      : undefined;
    const chans = await db.query.channels.findMany({
      where: and(
        eq(channels.contextObjectType, "entity"),
        eq(channels.contextObjectId, subjectEntityId),
        data.branchPurpose
          ? eq(channels.branchPurpose, data.branchPurpose)
          : undefined,
        typeFilter,
        // SAME FLOOR as the single-channel path.
        or(eq(channels.workspaceId, workspaceId), isNull(channels.workspaceId))
      ),
      columns: {
        id: true,
        channelType: true,
        branchPurpose: true,
        title: true,
      },
      orderBy: [desc(channels.updatedAt)],
      limit: 50,
    });

    if (chans.length === 0) {
      return withDocs({
        messages: [],
        channelId: null,
        count: 0,
        channels: [],
        truncated: false,
      });
    }

    const merged: Array<
      ReturnType<typeof projectMessage> & { source: unknown }
    > = [];
    for (const ch of chans) {
      const rows = await db.query.messages.findMany({
        where: and(
          eq(messages.channelId, ch.id),
          isNull(messages.deletedAt),
          // Ephemeral recaps ("catch me up") are live-only — never gathered
          // into a fresh synthesis context (the canonical read triad).
          eq(messages.ephemeral, false)
        ),
        columns: { role: true, content: true, metadata: true, timestamp: true },
        orderBy: [desc(messages.timestamp)],
        limit,
      });
      const source = {
        channelId: ch.id,
        channelType: ch.channelType,
        branchPurpose: ch.branchPurpose ?? null,
        title: ch.title ?? null,
      };
      for (const m of rows) merged.push({ ...projectMessage(m), source });
    }

    // Merge chronologically (oldest → newest) across all channels.
    merged.sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt))
    );

    let truncated = false;
    let capped = merged;
    if (merged.length > MESSAGES_QUERY_TOTAL_CEILING) {
      truncated = true;
      // Keep the MOST-RECENT ceiling messages.
      capped = merged.slice(merged.length - MESSAGES_QUERY_TOTAL_CEILING);
      logger.warn(
        {
          subjectEntityId,
          workspaceId,
          gathered: merged.length,
          ceiling: MESSAGES_QUERY_TOTAL_CEILING,
          channels: chans.length,
        },
        "messages_query all-channels: gathered history exceeded ceiling — truncated to most-recent"
      );
    }

    return withDocs({
      messages: capped,
      channelId: null,
      count: capped.length,
      channels: chans.map((c) => ({
        id: c.id,
        channelType: c.channelType,
        branchPurpose: c.branchPurpose ?? null,
        title: c.title ?? null,
      })),
      truncated,
    });
  }

  // ---- DEFAULT: single channel (explicit channelId, or single-external subject) ----
  if (channelId) {
    const ch = await db.query.channels.findFirst({
      where: and(
        eq(channels.id, channelId),
        or(eq(channels.workspaceId, workspaceId), isNull(channels.workspaceId))
      ),
      columns: { id: true },
    });
    if (!ch) {
      throw new Error(
        `messages_query: channel ${channelId} not visible in workspace ${workspaceId}`
      );
    }
  } else if (subjectEntityId) {
    // Resolve the client's CLIENT-COMMS channel (where the client's messages are
    // ingested) — channelType EXTERNAL. An entity often has BOTH a team THREAD
    // and an EXTERNAL client-comms channel bound to the same contextObjectId; we
    // must read the EXTERNAL one, never the team thread (which carries team
    // chatter, not the client's messages).
    const ch = await db.query.channels.findFirst({
      where: and(
        eq(channels.contextObjectType, "entity"),
        eq(channels.contextObjectId, subjectEntityId),
        eq(channels.channelType, ChannelType.EXTERNAL),
        or(eq(channels.workspaceId, workspaceId), isNull(channels.workspaceId))
      ),
      columns: { id: true },
      orderBy: [desc(channels.updatedAt)],
    });
    channelId = ch?.id;
  }

  if (!channelId) {
    // No channel given and none bound to the entity — empty set (additive).
    return withDocs({ messages: [], channelId: null, count: 0 });
  }

  const rows = await db
    .select({
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
        // Canonical read triad: ephemeral "catch me up" recaps are live-only and
        // must never be gathered into a fresh synthesis context (matches the
        // all-channels fan-out branch above — the invariant holds on BOTH paths).
        eq(messages.ephemeral, false)
      )
    )
    .orderBy(desc(messages.timestamp))
    .limit(limit);

  // Re-order oldest → newest for downstream iteration.
  const ordered = rows.reverse().map(projectMessage);

  return withDocs({ messages: ordered, channelId, count: ordered.length });
}

/**
 * Split a comma-separated / array-valued node field into trimmed values.
 * Shared by `runs_query`.status and `proposals_query`.{status,proposalIds}:
 * the flow editor's text controls emit a single string, template resolution can
 * yield a comma list, and hand-written JSON can carry a real array. An EMPTY
 * result returns `undefined` so the caller DROPS the filter rather than emitting
 * `IN ()` — an empty filter must never silently match zero rows (same rule as
 * `workspaceLensWhere`'s empty-array lens).
 */
export function parseMultiValueField(
  raw: unknown,
  context: StepContext
): string[] | undefined {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    const resolved = resolveTemplate(v, context);
    for (const piece of resolved.split(",")) {
      const t = piece.trim();
      if (t) parts.push(t);
    }
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else push(raw);
  return parts.length > 0 ? parts : undefined;
}

/**
 * The `status` enums as runtime value sets. Both columns are plain `text` at the
 * DB level but TS-typed unions in the schema, so a `string[]` cannot be passed
 * to `inArray` — and more importantly an author's typo must not silently widen.
 *
 * SEMANTIC (copied from `listAutomationRuns`, packages/api services/runs): a
 * status filter that resolves to NO known value returns an EMPTY result set, not
 * every row. That is the correct reading of "show me the `faild` runs" — the
 * author asked to narrow, so a bad narrow yields nothing rather than everything.
 * It is the opposite rule from `since` (dropped when unparseable) because
 * `since` failing open is visible in the output while a widened status filter
 * would look like a plausible answer.
 */
export const RUN_STATUS_VALUES = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;
type RunStatusValue = (typeof RUN_STATUS_VALUES)[number];

export const PROPOSAL_STATUS_VALUES = [
  "pending",
  "approved",
  "rejected",
  "auto_approved",
  "reverted",
  "approval_failed",
  "withdrawn",
] as const;
type ProposalStatusValue = (typeof PROPOSAL_STATUS_VALUES)[number];

export function narrowStatuses<T extends string>(
  raw: string[] | undefined,
  known: readonly T[]
): T[] | undefined {
  if (!raw) return undefined;
  return raw.filter((v): v is T => (known as readonly string[]).includes(v));
}

/**
 * Resolve a node's `since` field to a bound-able Date, or `undefined`.
 *
 * Same discipline as `coerceDateFilterValue` in the `query` node, and for the
 * same reason: an unparseable date is DROPPED (with a warning), never bound.
 * Dropping WIDENS the result set, which is visible to the author; binding an
 * `Invalid Date` NARROWS it to zero rows silently — a report that says "nothing
 * happened last night" when in fact everything happened.
 */
export function resolveSinceFilter(
  raw: unknown,
  context: StepContext,
  nodeType: string
): Date | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const resolved =
    typeof raw === "string" ? resolveTemplate(raw, context) : raw;
  const date = coerceDateFilterValue(resolved);
  if (!date) {
    logger.warn(
      { nodeType, since: raw, resolved },
      `${nodeType} node: dropping 'since' filter — value is not a parseable date (ISO-8601 string, epoch millis or Date expected)`
    );
    return undefined;
  }
  return date;
}

/**
 * Execute a `runs_query` SOURCE step: read this pod's own automation run ledger.
 *
 * VISIBILITY — `userVisibleWhere(automationRuns.workspaceId, ownerId)`, which is
 * the EXACT predicate `listAutomationRuns` (packages/api services/runs/index.ts)
 * applies to the same table. That consistency is the decision: a report built on
 * this node and the Runs surface in the browser must never disagree about which
 * runs exist. `ownerId` is the automation's `createdBy`, mirroring how
 * `executeQueryStep` already derives the read identity. With NO owner we fail
 * CLOSED to this workspace's own runs — an un-floored read of the ledger would
 * hand every user every other user's runs.
 *
 * SECURITY — `automation_step_runs` has NO visibility column of its own (no
 * `workspace_id`, no `user_id`; see schema/automations.ts). It is therefore only
 * ever reachable as a CHILD of an already-authorized `automation_runs` row: the
 * children query below is `inArray(runId, <ids of the rows the predicate above
 * returned>)`. It never binds a template-resolved run id — a
 * `WHERE run_id = {{trigger.payload.runId}}` would be a straight IDOR, since
 * that value is caller-supplied. The structure (fetch parents first, then
 * children BY PARENT ID) is what enforces this, not a comment.
 */
async function executeRunsQueryStep(
  data: {
    automationId?: string;
    status?: string;
    since?: string;
    subjectEntityId?: string;
    limit?: number;
    includeSteps?: boolean;
  },
  context: StepContext,
  workspaceId: string,
  ownerId?: string
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Number(data.limit ?? 20), 1), 100);

  const automationId = data.automationId
    ? resolveTemplate(data.automationId, context) || undefined
    : undefined;
  const subjectEntityId = data.subjectEntityId
    ? resolveTemplate(data.subjectEntityId, context) || undefined
    : undefined;
  const rawStatuses = parseMultiValueField(data.status, context);
  const statuses: RunStatusValue[] | undefined = narrowStatuses(
    rawStatuses,
    RUN_STATUS_VALUES
  );
  // Author asked to narrow by a status nothing can ever equal → empty, never all.
  if (statuses && statuses.length === 0) {
    logger.warn(
      { status: data.status, resolved: rawStatuses },
      "runs_query node: no known run status in filter — returning an empty set rather than widening"
    );
    return { runs: [], count: 0 };
  }
  const since = resolveSinceFilter(data.since, context, "runs_query");

  const conditions: SQL[] = [
    // The user floor — identical to listAutomationRuns. Fail closed to this
    // workspace when the run has no owner identity to floor on. See
    // ledger-query-scope.ts for the full rationale + its unit proof.
    runsQueryVisibilityWhere({ workspaceId, ownerId }),
  ];
  if (automationId)
    conditions.push(eq(automationRuns.automationId, automationId));
  if (subjectEntityId)
    conditions.push(eq(automationRuns.subjectEntityId, subjectEntityId));
  if (statuses) conditions.push(inArray(automationRuns.status, statuses));
  // `gte()` (never a raw `drizzleSql` interpolation) — postgres.js cannot bind a
  // JS Date inside a raw template fragment; see postgres-sql-json lesson.
  if (since) conditions.push(gte(automationRuns.startedAt, since));

  // Projection mirrors `getRun`'s run row (services/runs/index.ts) so the report
  // and RunDetailPanel name the same fields.
  const runs = await db
    .select({
      id: automationRuns.id,
      flowName: automations.name,
      status: automationRuns.status,
      startedAt: automationRuns.startedAt,
      completedAt: automationRuns.completedAt,
      error: automationRuns.errorMessage,
      stepsCompleted: automationRuns.stepsCompleted,
      stepsFailed: automationRuns.stepsFailed,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(and(...conditions))
    .orderBy(desc(automationRuns.startedAt))
    .limit(limit);

  if (!data.includeSteps || runs.length === 0) {
    return {
      runs: runs.map((r) => ({ ...r, flowName: r.flowName ?? "Automation" })),
      count: runs.length,
    };
  }

  // CHILDREN — keyed ONLY by the ids of the runs the visibility predicate above
  // already returned. This is the structural IDOR guard described in the header.
  const runIds = runs.map((r) => r.id);
  const stepRows = await db
    .select({
      id: automationStepRuns.id,
      runId: automationStepRuns.runId,
      nodeId: automationStepRuns.nodeId,
      status: automationStepRuns.status,
      errorMessage: automationStepRuns.errorMessage,
      startedAt: automationStepRuns.startedAt,
      completedAt: automationStepRuns.completedAt,
    })
    .from(automationStepRuns)
    .where(inArray(automationStepRuns.runId, runIds))
    .orderBy(asc(automationStepRuns.startedAt));

  const stepsByRun = new Map<string, (typeof stepRows)[number][]>();
  for (const s of stepRows) {
    const list = stepsByRun.get(s.runId);
    if (list) list.push(s);
    else stepsByRun.set(s.runId, [s]);
  }

  return {
    runs: runs.map((r) => ({
      ...r,
      flowName: r.flowName ?? "Automation",
      steps: stepsByRun.get(r.id) ?? [],
    })),
    count: runs.length,
  };
}

/**
 * Execute a `proposals_query` SOURCE step: read this pod's own proposal queue.
 *
 * VISIBILITY — `userVisibleWhere(proposals.workspaceId, ownerId)`, the EXACT
 * predicate `routers/proposals.ts` applies to its own listing. Pod-wide
 * proposals (`workspace_id IS NULL`) therefore get the SAME handling here as
 * anywhere else in the product — deliberately NOT a special narrower rule
 * (product decision: "pod-wide proposals should have the same handling as any
 * proposal, no need to overengineer"). Fails CLOSED to this workspace when there
 * is no owner identity to floor on.
 *
 * `correlationId` / `sessionId` are the indexed columns that address a GROUP of
 * proposals — there is no proposal-group row, the shared id IS the group.
 */
async function executeProposalsQueryStep(
  data: {
    status?: string;
    targetType?: string;
    changeType?: string;
    correlationId?: string;
    sessionId?: string;
    proposalIds?: string | string[];
    since?: string;
    limit?: number;
  },
  context: StepContext,
  workspaceId: string,
  ownerId?: string
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Number(data.limit ?? 20), 1), 100);

  const rawStatuses = parseMultiValueField(data.status, context);
  const statuses: ProposalStatusValue[] | undefined = narrowStatuses(
    rawStatuses,
    PROPOSAL_STATUS_VALUES
  );
  if (statuses && statuses.length === 0) {
    logger.warn(
      { status: data.status, resolved: rawStatuses },
      "proposals_query node: no known proposal status in filter — returning an empty set rather than widening"
    );
    return { proposals: [], count: 0 };
  }
  const ids = parseMultiValueField(data.proposalIds, context);
  const targetType = data.targetType
    ? resolveTemplate(data.targetType, context) || undefined
    : undefined;
  const changeType = data.changeType
    ? resolveTemplate(data.changeType, context) || undefined
    : undefined;
  const correlationId = data.correlationId
    ? resolveTemplate(data.correlationId, context) || undefined
    : undefined;
  const sessionId = data.sessionId
    ? resolveTemplate(data.sessionId, context) || undefined
    : undefined;
  const since = resolveSinceFilter(data.since, context, "proposals_query");

  const conditions: SQL[] = [
    proposalsQueryVisibilityWhere({ workspaceId, ownerId }),
  ];
  if (statuses) conditions.push(inArray(proposals.status, statuses));
  if (ids) conditions.push(inArray(proposals.id, ids));
  if (targetType) conditions.push(eq(proposals.targetType, targetType));
  if (correlationId)
    conditions.push(eq(proposals.correlationId, correlationId));
  if (sessionId) conditions.push(eq(proposals.sessionId, sessionId));
  if (since) conditions.push(gte(proposals.createdAt, since));
  if (changeType) {
    // The change kind is normalized the SAME way every review surface does it
    // (routers/proposals.ts: "Prefer changeType, fall back to proposalType") —
    // request-shaped payloads carry `data.changeType`, older/other paths only
    // have the `proposal_type` column. Matching one and not the other would make
    // the filter silently miss half the queue.
    conditions.push(
      or(
        drizzleSql`${proposals.data}->>'changeType' = ${changeType}`,
        and(
          drizzleSql`${proposals.data}->>'changeType' IS NULL`,
          eq(proposals.proposalType, changeType)
        )
      )!
    );
  }

  const rows = await db
    .select({
      id: proposals.id,
      status: proposals.status,
      targetType: proposals.targetType,
      targetId: proposals.targetId,
      // Same COALESCE the review surfaces apply in TS.
      changeType: drizzleSql<string>`COALESCE(${proposals.data}->>'changeType', ${proposals.proposalType})`,
      // `data.summary` / `data.reasoning` are the request-shaped narration
      // fields the proposal card renders; NULL on payloads that carry neither.
      summary: drizzleSql<string | null>`${proposals.data}->>'summary'`,
      reasoning: drizzleSql<string | null>`${proposals.data}->>'reasoning'`,
      correlationId: proposals.correlationId,
      sessionId: proposals.sessionId,
      createdAt: proposals.createdAt,
    })
    .from(proposals)
    .where(and(...conditions))
    .orderBy(desc(proposals.createdAt))
    .limit(limit);

  return { proposals: rows, count: rows.length };
}

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
async function executePlaybookRun(
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
  automationContext?: ExecutionPayload["automationContext"]
): Promise<Record<string, unknown>> {
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
}): Promise<Record<string, unknown>> {
  const {
    runId,
    automationId,
    workspaceId,
    ownerId,
    automationContext,
    completedNodeIds,
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

      // Resolve per-node error handling config
      const nodeErrorHandling = ((node.data as Record<string, unknown>)
        .errorHandling ?? {}) as NodeErrorHandling;
      const maxRetries = Math.min(
        Math.max(Number(nodeErrorHandling.maxRetries ?? 0), 0),
        3
      );
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
                ownerId
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
                run?.subjectEntityId
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
                          ownerId
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
                          run?.subjectEntityId
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
                          { workspaceId, ownerId }
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
                          { workspaceId, ownerId }
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
                          automationContext
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
                { workspaceId, ownerId, stepRun }
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
                { workspaceId, ownerId, stepRun }
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
                automationContext
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
          if (attempt < maxRetries) {
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
 * Safe condition evaluator.
 * Supports simple comparisons — NO eval().
 * Format: "path.to.value === 'expected'" or "path.to.value > 5"
 *
 * FAILS CLOSED: an unparseable expression or unknown operator THROWS (the step
 * fails and the run errors loudly), rather than the old fail-OPEN-to-true which
 * let a broken gate silently proceed down both branches. Numeric comparisons
 * treat a missing/empty operand as NaN (→ false), NOT Number("")===0 which let a
 * missing value silently satisfy `< N`.
 */
/**
 * Coerce a condition operand into a string list for the membership operators
 * (`in` / `not-in` / `contains` / `contains-any`). Three operand shapes are
 * accepted, all resolved to `string[]`:
 *   - a bare context path (trigger./steps./automation./loop./item.) → resolved:
 *     an array becomes each element String()-ed, a scalar becomes a one-element
 *     list, a missing/null value becomes the empty list.
 *   - an inline comma-separated literal (`'a@x.com','b@y.com'` or `a,b,c`) →
 *     split on commas, each token trimmed + unquoted.
 *   - a single literal (`'active'`) → a one-element list (quotes stripped).
 * String-based throughout — the sender allow/deny fields these serve are strings.
 */
function resolveOperandList(raw: string, context: StepContext): string[] {
  const trimmed = raw.trim();
  const unquote = (s: string): string => {
    const t = s.trim();
    if (
      (t.startsWith("'") && t.endsWith("'")) ||
      (t.startsWith('"') && t.endsWith('"'))
    ) {
      return t.slice(1, -1);
    }
    return t;
  };

  // Bare context path → resolve to its native value.
  if (/^(trigger|steps|automation|loop|item)\./.test(trimmed)) {
    const value = resolveReferencePath(trimmed, context);
    if (value == null) return [];
    if (Array.isArray(value))
      return value.filter((v) => v != null).map((v) => String(v));
    return [String(value)];
  }

  // Inline comma-separated literal list.
  if (trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map(unquote)
      .filter((s) => s !== "");
  }

  // Single literal.
  const single = unquote(trimmed);
  return single === "" ? [] : [single];
}

export function evaluateCondition(
  expression: string,
  context: StepContext
): boolean {
  // Parse simple comparison: left op right
  const match = expression.match(/^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/);

  // Membership operators (list-based) — `in` / `not-in` / `contains` /
  // `contains-any`. Both operands are coerced to string lists (a scalar → a
  // one-element list) and the check is a NON-EMPTY INTERSECTION, so `in`,
  // `contains` and `contains-any` are ergonomic aliases that read naturally by
  // position (value ∈ list / list ∋ value / either side a list) — they compute
  // the SAME thing. `not-in` is the negation (a deny-list keep-gate:
  // `trigger.payload.from not-in trigger.payload.denylist`).
  const memberMatch = expression.match(
    /^(.+?)\s+(contains-any|contains|not-in|in)\s+(.+)$/
  );
  // Disambiguate when BOTH parse (e.g. `k === 'fell in love'` — a `===` compare
  // whose literal contains " in "): the operator that appears LEFTMOST wins
  // (the shorter left operand = the earlier operator).
  if (memberMatch && (!match || memberMatch[1].length < match[1].length)) {
    const [, leftRaw, memberOp, rightRaw] = memberMatch;
    const leftList = resolveOperandList(leftRaw, context);
    const rightSet = new Set(resolveOperandList(rightRaw, context));
    const intersects = leftList.some((v) => rightSet.has(v));
    return memberOp === "not-in" ? !intersects : intersects;
  }

  if (!match) {
    throw new Error(
      `Automation condition could not be parsed (fail-closed): "${expression}"`
    );
  }

  const [, leftPath, operator, rightRaw] = match;
  const leftValue = resolveTemplate(`{{${leftPath.trim()}}}`, context);

  // Parse right side: quoted → string literal, numeric → number, a bare
  // context path (trigger./steps./automation./loop./item.) → resolve it as a
  // template too so a condition can compare two resolved paths, e.g.
  // `trigger.payload.subjectId !== trigger.payload.data.channelId`. The left
  // operand is always resolved; without this the right path would be compared
  // as the literal string "trigger.payload.data.channelId" and never match.
  // Anything else (e.g. `true`, `active`) stays a bare string literal.
  let rightValue: string | number = rightRaw.trim();
  if (
    (rightValue.startsWith("'") && rightValue.endsWith("'")) ||
    (rightValue.startsWith('"') && rightValue.endsWith('"'))
  ) {
    rightValue = rightValue.slice(1, -1);
  } else if (rightValue !== "" && !isNaN(Number(rightValue))) {
    rightValue = Number(rightValue);
  } else if (/^(trigger|steps|automation|loop|item)\./.test(rightValue)) {
    rightValue = resolveTemplate(`{{${rightValue}}}`, context);
  }

  // Empty string → NaN (not 0) so a missing operand fails a numeric compare
  // instead of silently satisfying `< N`.
  const toNum = (v: string | number): number => (v === "" ? NaN : Number(v));

  const left = typeof rightValue === "number" ? toNum(leftValue) : leftValue;

  switch (operator) {
    case "===":
    case "==":
      return left === rightValue;
    case "!==":
    case "!=":
      return left !== rightValue;
    case ">":
      return toNum(left) > toNum(rightValue);
    case "<":
      return toNum(left) < toNum(rightValue);
    case ">=":
      return toNum(left) >= toNum(rightValue);
    case "<=":
      return toNum(left) <= toNum(rightValue);
    default:
      throw new Error(
        `Automation condition has an unknown operator "${operator}" (fail-closed): "${expression}"`
      );
  }
}

/**
 * Prune the untaken branch of a condition/switch, WITHOUT over-pruning a
 * join/merge node that is also reachable from the taken branch (diamond fix).
 *
 * A node is skipped only when it has NO live incoming edge — a live edge is one
 * that is not itself pruned AND whose source is not skipped. The caller must add
 * the directly-untaken edges to `prunedEdges` BEFORE calling this on their
 * targets, so a target whose only parent is the untaken edge gets skipped, but a
 * target that also has a taken-branch parent survives.
 */
export function markDescendantsSkipped(
  nodeId: string,
  edges: AutomationEdge[],
  skippedNodes: Set<string>,
  prunedEdges: Set<AutomationEdge>
): void {
  if (skippedNodes.has(nodeId)) return;

  const inEdges = edges.filter((e) => e.target === nodeId);
  const hasLiveParent = inEdges.some(
    (e) => !prunedEdges.has(e) && !skippedNodes.has(e.source)
  );
  if (hasLiveParent) return; // reachable from a taken branch — keep it

  skippedNodes.add(nodeId);
  for (const edge of edges.filter((e) => e.source === nodeId)) {
    prunedEdges.add(edge);
    markDescendantsSkipped(edge.target, edges, skippedNodes, prunedEdges);
  }
}

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

// Node types a loop may dispatch per-item (mirrors the `switch (childNode.type)`
// in the loop body). Traversal of a loop's body STOPS at any type not in this
// set, so control/boundary nodes (switch, delay, nested loop, sub_automation)
// run once in the main pass rather than being swallowed by the loop.
const LOOP_BODY_NODE_TYPES = new Set<string>([
  "command",
  "output",
  "playbook_run",
  "messages_query",
  "runs_query",
  "proposals_query",
  "query",
  "fetch",
  "transform",
  // Per-item AI/gated verbs — dispatched once PER ITEM (MAX_LOOP_ITERATIONS
  // caps the paid IS/provider fan-out). `condition` is a PER-ITEM FILTER with
  // continue-semantics (skip the rest of THIS item's body), NOT the main-pass
  // branch-pruning path. Nested `loop`/`switch` are deliberately EXCLUDED —
  // they stay traversal boundaries to avoid exponential fan-out.
  "condition",
  "skill",
  "capability",
]);

/**
 * The node ids a loop OWNS as its per-item body: the CONTIGUOUS chain of
 * LOOP_BODY_NODE_TYPES nodes reachable from the loop node, traversal stopping at
 * any node type not in that set (those are boundaries — they run once in the
 * main pass). Extracted from the `case "loop"` block so the exact ownership rule
 * the executor applies can be unit-tested and mirrored by the author-time
 * validator (`packages/api/src/services/automations/validate-flow.ts`).
 *
 * Pure. An empty result means the loop dispatches NOTHING — see the caller.
 */
export function computeLoopBodyNodeIds(
  nodes: AutomationNode[],
  edges: AutomationEdge[],
  loopNodeId: string
): Set<string> {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const bodyNodeIds = new Set<string>();
  const stack = getOutEdges(edges, loopNodeId).map((e) => e.target);
  while (stack.length) {
    const id = stack.pop() as string;
    if (bodyNodeIds.has(id)) continue;
    const bn = nodeById.get(id);
    if (!bn || !LOOP_BODY_NODE_TYPES.has(bn.type)) continue; // boundary
    bodyNodeIds.add(id);
    for (const e of getOutEdges(edges, id)) stack.push(e.target);
  }
  return bodyNodeIds;
}

/** Matches a `{{loop.…}}` binding reference. */
const LOOP_BINDING_RE = /\{\{\s*loop\./;

/**
 * Every string inside a node's `data` that reads the per-item `{{loop.*}}`
 * binding. Used by the main-pass guard: `context.loop` exists ONLY while a loop
 * dispatches its body, so a node that reaches the main topological pass with a
 * `{{loop.*}}` reference can NEVER resolve it (see the guard's comment).
 *
 * PRE-PIPE part only: an array pipe argument (`{{x | map:{{loop.item.id}}}}`)
 * legitimately binds `loop` per item during resolution — that is a resolver-local
 * scope, not the node's own, so it must not trip the guard.
 *
 * Pure and deep (walks objects/arrays), so nested `inputMapping` / `config`
 * values are covered.
 */
export function collectLoopBindingRefs(data: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (LOOP_BINDING_RE.test(v.split("|")[0])) found.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(data);
  return found;
}

/**
 * Parse a duration string to milliseconds.
 * Supports: "5m", "1h", "30s", "1d", "1w", "500ms"
 */
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
