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
  desc,
  automations,
  automationRuns,
  automationStepRuns,
  entities,
  users,
  messages,
  channels,
  notifications,
  focusSessions,
  playbooks,
  playbookRuns,
  playbookEnrollments,
  drizzleSql,
  EntityRepository,
  materializeEntity,
  eventRepository,
  mirrorMessageToBoundExternal,
  openRunSession,
} from "@synap/database";
import {
  ChannelType,
  ChannelScope,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
} from "@synap/database/schema";
import type { AutomationTriggerConfig } from "@synap/database/schema";
import { computeMessageHash, ChannelRepository } from "@synap/database";
import type {
  FlowDefinition,
  AutomationNode,
  AutomationEdge,
  NodeErrorHandling,
  CommandNodeDef,
  OutputNodeDef,
} from "@synap/database";
import { getBoss, emitSideEffects } from "@synap/events";
import {
  resolveVaultReferences,
  isVaultReference,
} from "../utils/vault-resolver.js";
import { checkAutomationWriteOrPropose } from "../utils/automation-governance.js";
import { RUN_NOT_DELAY_SUSPENDED } from "./automation-run-reaper.js";
import { validateExternalUrl, safeExternalFetch } from "@synap/shared-utils";
import {
  resolveIntelligenceService,
  getDefaultActiveService,
  requestTaskExecute,
} from "@synap/intelligence-client";
import { createLogger } from "@synap-core/core";
import {
  A2AI_TRIGGER_QUEUE,
  A2AI_TRIGGER_JOB_OPTIONS,
  type A2AIResponseTriggerData,
} from "./a2ai-response-trigger.js";

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

/**
 * Resolve template variables in a string.
 * Supports: {{trigger.payload.field}}, {{steps.stepId.output.field}}, {{loop.item}}
 */
export function resolveTemplate(
  template: string,
  context: StepContext
): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, path: string) => {
    const parts = path.trim().split(".");
    let current: unknown = context;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return "";
      current = (current as Record<string, unknown>)[part];
    }
    if (current == null) return "";
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
 * Deep-resolve templates in any value (string, object, array).
 */
function deepResolveTemplates(value: unknown, context: StepContext): unknown {
  if (typeof value === "string") return resolveTemplate(value, context);
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
 * Resolve a dot-path from context to its actual value (not stringified).
 */
function resolveContextPath(path: string, context: StepContext): unknown {
  const parts = path.trim().split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
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
  const resolvedInputs = resolveInputMapping(inputMapping, context);

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
  const capResolvedInputs = resolveInputMapping(capInputMapping, context);

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
async function executeOutputStep(
  data: {
    outputType: string;
    config: Record<string, unknown>;
    label?: string;
  },
  context: StepContext,
  workspaceId: string,
  automationContext: ExecutionPayload["automationContext"],
  ownerId: string,
  // Workflow attribution (D3a): the executing flow node + its step-run row, so a
  // governed write becomes a proposal that traces back to the exact step. In a
  // loop body the step run is the loop node's (no per-child row), while nodeId
  // is the child node — the closest honest attribution.
  attribution?: { nodeId?: string; stepRunId?: string }
): Promise<Record<string, unknown>> {
  // Deep-resolve all template variables in config
  const config = deepResolveTemplates(data.config, context) as Record<
    string,
    unknown
  >;

  switch (data.outputType) {
    case "entity_create": {
      const profileSlug = (config.profileSlug as string) ?? "note";
      const title = config.title as string;
      const properties = (config.properties ?? {}) as Record<string, unknown>;

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
        data: { profileSlug, title, properties },
        reasoning: "Automation proposed creating an entity.",
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
        // awaits human review, attributed to the owning agent.
        return { status: "proposed", proposalId: gate.proposalId };
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
      const provenance =
        ownerUser?.userType === "agent"
          ? {
              createdByKind: "ai_agent" as const,
              agentUserId: ownerId,
              createdByUserId: ownerId,
            }
          : { createdByKind: "system" as const, createdByUserId: ownerId };

      // materializeEntity wraps EntityRepository.create: profile resolution,
      // pod-wide scoping, property indexing, event emission — plus provenance.
      const { entity } = await materializeEntity(
        {
          profileSlug,
          title,
          properties,
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

      return { status: "created", entityId: entity.id, title: entity.title };
    }

    case "entity_update": {
      const entityId = config.entityId as string;
      const properties = (config.properties ?? {}) as Record<string, unknown>;

      if (!entityId)
        throw new Error("entity_update requires entityId in config");

      // Governed — same gate as entity_create above.
      const gate = await checkAutomationWriteOrPropose({
        ownerId,
        workspaceId,
        subjectType: "entity",
        action: "update",
        data: { entityId, properties },
        reasoning: "Automation proposed updating an entity.",
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
        ownerId
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

      await db.insert(notifications).values({
        id: randomUUID(),
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
      });

      return { status: "sent", title, body };
    }

    case "channel_message": {
      // Accepts explicit channelId OR channelType:'personal_thread'|'proactive'
      // 'personal_thread'  → user's personal thread (channelType=PERSONAL)
      // 'proactive' → user's feed channel (channelType='feed', feedScope='user') — automation outputs
      let channelId = config.channelId as string | undefined;
      const content = config.content as string;
      const metadata = (config.metadata ?? {}) as Record<string, unknown>;

      if (!content) {
        throw new Error("channel_message requires content");
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

      if (!channelId) {
        throw new Error(
          "channel_message requires channelId or channelType:'personal_thread'|'proactive'"
        );
      }

      // Canonical tamper-hash: computeMessageHash(id, content) — the ONE formula
      // (see @synap/database message-hash.ts). Generate the id up front so the
      // stored hash matches the row's id.
      const messageId = randomUUID();
      const hash = computeMessageHash(messageId, content);

      // Tag proactive channel messages so the feed can identify their type
      // without needing to know which channel they came from.
      const proactiveType =
        config.channelType === "proactive"
          ? (metadata.proactiveType ?? config.proactiveType ?? "insight")
          : undefined;

      const [msg] = await db
        .insert(messages)
        .values({
          id: messageId,
          channelId,
          userId: "system",
          role: "assistant",
          content,
          hash,
          metadata: {
            automationMessage: true,
            ...(proactiveType ? { proactiveType, proactiveAi: true } : {}),
            ...metadata,
            ...automationContext,
          } as (typeof messages.$inferInsert)["metadata"],
        })
        .returning({ id: messages.id });

      // MIRROR: if this channel is bound to Discord, post the message out. An
      // automation output is BOT-authored, so the mirror's firewall blocks it
      // from any client-comms channel (team/feed only). No-ops for non-external
      // channels (personal/feed). Never throws.
      const mirror = await mirrorMessageToBoundExternal({
        channelId,
        content,
        authorType: MessageAuthorType.BOT,
      });
      if (mirror.mirrored) {
        logger.info(
          { channelId },
          "automation channel_message mirrored to Discord"
        );
      }

      return { status: "sent", messageId: msg.id, channelId };
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
        | { kind: string; label: string; icon?: string }
        | undefined;

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

    default:
      logger.warn({ outputType: data.outputType }, "Unknown output type");
      return { status: "unknown_output_type", outputType: data.outputType };
  }
}

// ── New Step Executors ───────────────────────────────────────────────────────

/**
 * Execute a transform step.
 * Supports pipe-style expressions: "{{nodeId.output.field}} | uppercase"
 * Scalar pipes: uppercase, lowercase, json, trim, url_extract
 * Array-aware pipes (input must be an array; non-array → treated as []):
 *   filter:<predicate>  keep items where the predicate is true (each item is
 *                       exposed as `item`, e.g. "filter:item.score > 5")
 *   map:<expr>          transform each item ("map:{{item.title}}")
 *   unique              dedupe by JSON identity
 *   slice:<n>           keep the first n items
 */
function executeTransformStep(
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
  // If it looks like a plain {{...}} reference, resolve the raw path value (not stringified)
  const templateMatch = templatePart.match(/^\{\{(.+?)\}\}$/);
  if (templateMatch) {
    value = resolveContextPath(templateMatch[1], context);
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
          const singleRef = pipeArg.match(/^\{\{(.+?)\}\}$/);
          current = arr.map((item, index) => {
            const itemContext: StepContext = {
              ...context,
              loop: { item, index },
              item,
            };
            return singleRef
              ? resolveContextPath(singleRef[1], itemContext)
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

/**
 * Execute a query step: queries entities by profile slug with optional filter.
 */
async function executeQueryStep(
  data: { profileSlug: string; filter: string; limit: number },
  context: StepContext,
  workspaceId: string
): Promise<Record<string, unknown>> {
  const profileSlug = resolveTemplate(data.profileSlug, context);
  const limit = Math.min(Math.max(Number(data.limit ?? 20), 1), 100);

  if (!profileSlug) throw new Error("query node: profileSlug is required");

  const conditions = [
    eq(entities.workspaceId, workspaceId),
    eq(entities.type, profileSlug),
  ];

  // Apply optional filter: { propertyKey: value } pairs as JSONB equality conditions
  const resolvedFilter = resolveTemplate(data.filter ?? "", context);
  if (resolvedFilter) {
    try {
      const filterObj = JSON.parse(resolvedFilter) as Record<string, unknown>;
      for (const [key, value] of Object.entries(filterObj)) {
        if (value !== undefined && value !== null) {
          conditions.push(
            drizzleSql`${entities.properties}->>${key} = ${String(value)}`
          );
        }
      }
    } catch {
      // unparseable filter — ignore, return unfiltered (defensive)
    }
  }

  const results = await db
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
    .where(and(...conditions))
    .limit(limit);

  return { entities: results, count: results.length };
}

/**
 * Execute a messages_query SOURCE step: read a client's stored chat messages.
 *
 * Resolution: an explicit `channelId` wins; otherwise the client-comms channel
 * bound to `subjectEntityId` (channels.contextObjectType='entity' +
 * contextObjectId=entity) is resolved. Either way the channel must be visible
 * in the automation's workspace (its workspace OR a pod-wide NULL one) — we
 * never read a channel from another workspace.
 *
 * Returns the most-recent `limit` messages in CHRONOLOGICAL order (oldest →
 * newest) so a downstream loop iterates the conversation in sequence:
 * `{ messages: [{ role, content, authorName, createdAt }], channelId, count }`.
 */
async function executeMessagesQueryStep(
  data: { subjectEntityId?: string; channelId?: string; limit?: number },
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
    return { messages: [], channelId: null, count: 0 };
  }

  const rows = await db
    .select({
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.timestamp))
    .limit(limit);

  // Re-order oldest → newest for downstream iteration.
  const ordered = rows.reverse().map((m) => ({
    role: m.role,
    content: m.content,
    authorName:
      (m.metadata as { sender?: { name?: string } } | null)?.sender?.name ??
      null,
    createdAt:
      m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
  }));

  return { messages: ordered, channelId, count: ordered.length };
}

/**
 * Execute a playbook_run step: instantiate a playbook, create a channel + session,
 * dispatch the goal to the Intelligence Hub, and return the run/session IDs.
 *
 * Follows the same lifecycle as runPlaybook (@synap/api) but implemented locally
 * to avoid the jobs → api circular dependency.
 */
async function executePlaybookRun(
  data: {
    playbookId?: string;
    playbookName?: string;
    paramsMapping?: Record<string, string>;
  },
  context: StepContext,
  workspaceId: string,
  ownerId: string
): Promise<Record<string, unknown>> {
  // 1. Resolve the playbook — by id, else by NAME within this workspace (then a
  // pod-wide NULL-workspace playbook). By-name is the template-friendly form: a
  // capability seeds a playbook + an automation together, and the automation
  // references the playbook by its stable name rather than a runtime id it can't
  // know at author time (mirrors entity resolution by profileSlug).
  let playbook = data.playbookId
    ? await db.query.playbooks.findFirst({
        where: eq(playbooks.id, data.playbookId),
      })
    : undefined;
  if (!playbook && data.playbookName) {
    playbook =
      (await db.query.playbooks.findFirst({
        where: and(
          eq(playbooks.name, data.playbookName),
          eq(playbooks.workspaceId, workspaceId)
        ),
      })) ??
      (await db.query.playbooks.findFirst({
        where: and(
          eq(playbooks.name, data.playbookName),
          isNull(playbooks.workspaceId)
        ),
      }));
  }
  if (!playbook) {
    throw new Error(
      `Playbook not found (${data.playbookId ?? data.playbookName ?? "no id/name given"})`
    );
  }
  // Cross-workspace guard: a flow may only run a playbook from its own workspace
  // or a pod-wide (NULL) one. Mirrors the subject IDOR guard below — the flow's
  // playbookId is editor-authored config, but defend in depth (no FK).
  if (playbook.workspaceId && playbook.workspaceId !== workspaceId) {
    throw new Error(
      `playbook_run: playbook ${playbook.id} not visible in workspace ${workspaceId}`
    );
  }

  // 2. Resolve params from the automation context (prior step outputs, trigger payload)
  const resolvedParams = data.paramsMapping
    ? resolveInputMapping(data.paramsMapping, context)
    : {};

  // 3. Resolve the goal template against automation context
  const goal =
    resolveTemplate(playbook.goalTemplate, context) || playbook.goalTemplate;

  // Resolve subject entity id from params or trigger payload (canonical source).
  // entityId is the loop-context alias for the iterated entity; subjectId is the
  // explicit override; trigger.payload.subjectId is the fallback.
  const candidateSubjectId =
    (resolvedParams.entityId as string | undefined) ??
    (resolvedParams.subjectId as string | undefined) ??
    (context.trigger.payload.subjectId as string | undefined) ??
    null;

  // Bind the subject ONLY if it's an entity the run can legitimately see —
  // its own workspace OR a pod-wide (workspaceId NULL) entity. A crafted
  // paramsMapping / trigger payload must not bind a session to an entity in
  // another workspace (write-side IDOR guard; the column has no FK).
  let resolvedSubjectId: string | null = null;
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

  // 3b. Idempotency by subject — if an active session for this playbook +
  // subject already exists, REUSE it rather than starting a duplicate. This
  // makes a playbook_run node safe on a schedule (e.g. a daily client-sync that
  // ensures every client has a session): start-if-missing, no-op-if-present.
  if (resolvedSubjectId) {
    const existing = await db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.playbookId, playbook.id),
        eq(focusSessions.subjectEntityId, resolvedSubjectId),
        eq(focusSessions.status, "active")
      ),
      orderBy: [desc(focusSessions.startedAt)],
    });
    if (existing) {
      return {
        sessionId: existing.id,
        channelId: existing.channelId ?? null,
        status: "reused",
        reused: true,
      };
    }
  }

  // Seed the first stage so the session starts stage-aware (the initial IS
  // dispatch gets the stage hint/grant), matching the tRPC/Hub creation path.
  // Reused below (7b) so a fresh enrollment's stepState agrees with the
  // session's currentStage — otherwise an entity at stage 1 never shows up
  // in the funnel (the session_update mirror only writes stepState.currentStep
  // on a stage CHANGE, not at creation).
  const playbookStages = playbook.stages as { key?: string }[] | null;
  const firstStageKey = playbookStages?.[0]?.key ?? null;

  // 4. Create a focus session for this playbook run
  const [session] = await db
    .insert(focusSessions)
    .values({
      workspaceId,
      userId: ownerId,
      goal,
      playbookId: playbook.id,
      status: "active",
      currentStage: firstStageKey,
      expectedOutputs: (playbook.expectedOutputs ?? []) as any[],
      agentIds: [],
      subjectEntityId: resolvedSubjectId,
    })
    .returning();

  // 5. Create a THREAD channel as the run's room
  const [channel] = await db
    .insert(channels)
    .values({
      userId: ownerId,
      workspaceId,
      channelType: ChannelType.THREAD,
      scope: ChannelScope.WORKSPACE,
      status: ChannelStatus.ACTIVE,
      title: playbook.name,
      contextObjectType: "playbook",
      contextObjectId: playbook.id,
      metadata: {
        origin: "automation-playbook-run",
        playbookId: playbook.id,
      },
    })
    .returning();

  // 6. Wire session.channelId
  await db
    .update(focusSessions)
    .set({ channelId: channel.id })
    .where(eq(focusSessions.id, session.id));

  // 7. Insert a playbook_runs ledger row
  const [run] = await db
    .insert(playbookRuns)
    .values({
      workspaceId,
      playbookId: playbook.id,
      sessionId: session.id,
      executor: (playbook.executor ?? "is-agent") as any,
      status: "running",
      input: resolvedParams,
      createdBy: ownerId,
      // D3c: snapshot the definition this run executed so it survives later
      // edits to the playbook config and can be diffed against the current row.
      definitionSnapshot: {
        version: playbook.version,
        goalTemplate: playbook.goalTemplate,
        stages: playbook.stages,
        params: playbook.params,
        expectedOutputs: playbook.expectedOutputs,
      },
    })
    .returning();

  // 7b. Enroll the subject entity in the playbook so running a playbook FOR an
  // entity also populates its funnel/cohort. Only when the playbook actually
  // has a funnel (stages) — an operational playbook (scheduled sync, etc.)
  // with no stages must not create enrollment rows. Idempotent by
  // unique(playbookId, entityId); re-enroll after unenroll (soft-cancel)
  // reactivates rather than silently no-op'ing. Best-effort side-write — an
  // enrollment failure must never fail the run (mirrors the executor's other
  // non-fatal side-writes).
  if (resolvedSubjectId && (playbookStages?.length ?? 0) > 0) {
    try {
      await db
        .insert(playbookEnrollments)
        .values({
          playbookId: playbook.id,
          entityId: resolvedSubjectId,
          status: "active",
          stepState: firstStageKey ? { currentStep: firstStageKey } : {},
        })
        .onConflictDoUpdate({
          target: [
            playbookEnrollments.playbookId,
            playbookEnrollments.entityId,
          ],
          set: { status: "active", updatedAt: new Date() },
        });
    } catch (err) {
      logger.warn(
        { err, playbookId: playbook.id, entityId: resolvedSubjectId },
        "playbook_run: enrollment upsert failed (non-fatal)"
      );
    }
  }

  // 8. Insert a USER kickoff message into the channel
  const messageId = randomUUID();
  const hash = computeMessageHash(messageId, goal);

  await db.insert(messages).values({
    id: messageId,
    channelId: channel.id,
    role: MessageRole.USER,
    content: goal,
    userId: ownerId,
    previousHash: "",
    hash,
  });

  // 9. Trigger the Intelligence Hub via A2AI_TRIGGER job so it picks up the
  //    kickoff message and starts processing in the session channel.
  try {
    const resolvedService = await resolveIntelligenceService({
      userId: ownerId,
      workspaceId,
      capability: "chat",
    });

    const boss = getBoss();
    await boss.send(
      A2AI_TRIGGER_QUEUE,
      {
        channelId: channel.id,
        userMessageId: messageId,
        content: goal,
        userId: ownerId,
        workspaceId,
        agentType: "meta",
        sourceAgentUserId: ownerId,
        focusSessionId: session.id,
        serviceUrl: resolvedService.endpoint,
        serviceApiKey: resolvedService.serviceApiKey,
        serviceId: resolvedService.serviceId,
        agentUserId: resolvedService.agentUserId ?? undefined,
      } satisfies A2AIResponseTriggerData,
      A2AI_TRIGGER_JOB_OPTIONS
    );
  } catch (err) {
    logger.warn(
      { err, playbookId: playbook.id },
      "Failed to trigger IS for playbook run — run created but agent not dispatched"
    );
  }

  return {
    runId: run.id,
    sessionId: session.id,
    status: "running",
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

  const flow = automation.flowDefinition as FlowDefinition;

  // D3c: snapshot the definition this run executed, once at first execution.
  // Guarded on the existing value so a delay-resumption re-entry (same runId)
  // never re-stamps. Covers every trigger path — all funnel through here.
  if (!run.definitionSnapshot) {
    await db
      .update(automationRuns)
      .set({
        definitionSnapshot: {
          version: automation.version,
          flowDefinition: flow,
        },
      })
      .where(eq(automationRuns.id, runId));
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

    // Channel resolution (runs-substrate rule: automation = ONE channel for all
    // its runs). An explicit trigger-bound channel wins (e.g. a Discord-triggered
    // automation posts back to its source channel); otherwise resolve THE
    // automation's durable run channel so every run's activity lands in one room.
    const triggerChannelId =
      (automation.triggerConfig as AutomationTriggerConfig | null)?.channelId ??
      undefined;
    const boundChannelId =
      triggerChannelId ??
      (
        await new ChannelRepository(db).ensureAutomationRunChannel(
          automationId,
          ownerId,
          workspaceId ?? undefined,
          automation.name ?? undefined
        )
      ).id;

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

    // If resuming from delay, reload previously completed step outputs
    if (alreadyCompleted.size > 0) {
      const priorSteps = await db
        .select()
        .from(automationStepRuns)
        .where(eq(automationStepRuns.runId, runId));

      for (const step of priorSteps) {
        if (step.status === "completed" && step.output) {
          context.steps[step.nodeId] = {
            output: step.output as Record<string, unknown>,
          };
        }
      }
    }

    // Track which nodes to skip (condition branches not taken)
    const skippedNodes = new Set<string>();
    // Edges on an untaken condition/switch branch. A node is only pruned when ALL
    // its incoming edges are dead (pruned or from a skipped source) — this is what
    // keeps a join/merge node reachable from the TAKEN branch alive (diamond fix).
    const prunedEdges = new Set<AutomationEdge>();
    let stepsCompleted = 0;
    let stepsFailed = 0;

    for (const node of sortedNodes) {
      // Skip trigger node (already fired)
      if (node.type === "trigger") continue;

      // Skip already-completed nodes (delay resumption)
      if (alreadyCompleted.has(node.id)) continue;

      // Skip if this node was excluded by a condition branch
      if (skippedNodes.has(node.id)) {
        await db.insert(automationStepRuns).values({
          runId,
          nodeId: node.id,
          status: "skipped",
        });
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
                  | string
                  | undefined)
              : undefined,
          status: "running",
          startedAt: new Date(),
        })
        .returning({ id: automationStepRuns.id });

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
                { nodeId: node.id, stepRunId: stepRun.id }
              );
              break;
            }

            case "loop": {
              const data = node.data as {
                iteratorExpression: string;
                itemVariable: string;
              };

              // Resolve the collection to iterate over
              const collection = resolveContextPath(
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

              if (items.length === 0) {
                output = { status: "empty_collection", itemCount: 0 };
                break;
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
              const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
              const bodyNodeIds = new Set<string>();
              {
                const stack = getOutEdges(flow.edges, node.id).map(
                  (e) => e.target
                );
                while (stack.length) {
                  const id = stack.pop() as string;
                  if (bodyNodeIds.has(id)) continue;
                  const bn = nodeById.get(id);
                  if (!bn || !LOOP_BODY_NODE_TYPES.has(bn.type)) continue; // boundary
                  bodyNodeIds.add(id);
                  for (const e of getOutEdges(flow.edges, id))
                    stack.push(e.target);
                }
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
                          { nodeId: childNode.id, stepRunId: stepRun.id }
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
                          ownerId
                        );
                        break;
                      case "messages_query":
                        childOutput = await executeMessagesQueryStep(
                          childNode.data as {
                            subjectEntityId?: string;
                            channelId?: string;
                            limit?: number;
                          },
                          context,
                          workspaceId
                        );
                        break;
                      case "query":
                        childOutput = await executeQueryStep(
                          childNode.data as {
                            profileSlug: string;
                            filter: string;
                            limit: number;
                          },
                          context,
                          workspaceId
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
                profileSlug: string;
                filter: string;
                limit: number;
              };
              output = await executeQueryStep(data, context, workspaceId);
              break;
            }

            case "messages_query": {
              const data = node.data as {
                subjectEntityId?: string;
                channelId?: string;
                limit?: number;
              };
              output = await executeMessagesQueryStep(
                data,
                context,
                workspaceId
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

              // Create a child run record
              const childRunId = randomUUID();
              await db.insert(automationRuns).values({
                id: childRunId,
                automationId: targetId,
                workspaceId,
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
                ownerId
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

    // Update run with final status
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
      .where(eq(automationRuns.id, runId));

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
export function evaluateCondition(
  expression: string,
  context: StepContext
): boolean {
  // Parse simple comparison: left op right
  const match = expression.match(/^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/);
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

// Node types a loop may dispatch per-item (mirrors the `switch (childNode.type)`
// in the loop body). Traversal of a loop's body STOPS at any type not in this
// set, so control/boundary nodes (switch, delay, nested loop, sub_automation)
// run once in the main pass rather than being swallowed by the loop.
const LOOP_BODY_NODE_TYPES = new Set<string>([
  "command",
  "output",
  "playbook_run",
  "messages_query",
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
