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
  messages,
  channels,
  notifications,
  focusSessions,
  playbooks,
  playbookRuns,
  drizzleSql,
  EntityRepository,
  eventRepository,
  mirrorMessageToBoundExternal,
} from "@synap/database";
import {
  ChannelType,
  ChannelScope,
  FeedScope,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  skills,
} from "@synap/database/schema";
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
import { gateCapabilityExecution } from "@synap/capability-gate";
import {
  resolveIntelligenceService,
  getDefaultActiveService,
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
  };
  /** For delay resumption: skip nodes that were already executed */
  completedNodeIds?: string[];
}

/** Context built up during execution — step outputs available to later steps */
interface StepContext {
  trigger: {
    payload: Record<string, unknown>;
  };
  steps: Record<string, { output: Record<string, unknown> }>;
  loop?: { item: unknown; index: number };
}

/**
 * Topological sort of nodes based on edges.
 * Returns nodes in execution order (parents before children).
 */
function topoSort(
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
function resolveTemplate(template: string, context: StepContext): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, path: string) => {
    const parts = path.trim().split(".");
    let current: unknown = context;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return "";
      current = (current as Record<string, unknown>)[part];
    }
    return current != null ? String(current) : "";
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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000); // 60s timeout for commands

    const response = await fetch(`${isUrl}/api/tasks/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": isApiKey,
      },
      body: JSON.stringify({
        taskId: data.commandId ?? "automation-command",
        action: prompt,
        context: resolvedInputs,
        // Attribute the IS work to the automation's owning principal
        // (automation.createdBy — the agent user id for AI-created automations)
        // instead of the unattributed "system". Writes the IS performs back to
        // the pod will then carry this identity through the governance gate.
        userId: ownerId,
        workspaceId,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`IS returned ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as Record<string, unknown>;
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
  ownerId: string
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
      });
      if ("denied" in gate) {
        throw new Error(`entity_create denied by governance: ${gate.reason}`);
      }
      if ("proposed" in gate) {
        // SAFETY: a proposal was created — do NOT direct-write. The change
        // awaits human review, attributed to the owning agent.
        return { status: "proposed", proposalId: gate.proposalId };
      }

      // EntityRepository handles: profile resolution, pod-wide scoping, property indexing, event emission
      const entityRepo = new EntityRepository(db, eventRepository);
      const entity = await entityRepo.create(
        {
          profileSlug,
          title,
          properties,
          workspaceId,
          userId: ownerId,
          skipValidation: true,
        },
        ownerId
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

      // Resolve vault references in headers (e.g., Authorization: vault://secret-id)
      const hasVaultHeaders = Object.values(headers).some(isVaultReference);
      if (hasVaultHeaders) {
        headers = await resolveVaultReferences(headers, ownerId);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);

      try {
        const response = await fetch(url, {
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

      // Resolve personal thread (channelType=PERSONAL)
      if (!channelId && config.channelType === "personal_thread") {
        const personalChannel = await db.query.channels.findFirst({
          where: and(
            eq(channels.userId, ownerId),
            eq(channels.channelType, ChannelType.PERSONAL),
            eq(channels.status, ChannelStatus.ACTIVE)
          ),
          columns: { id: true },
        });
        channelId = personalChannel?.id;

        if (!channelId) {
          const [newChannel] = await db
            .insert(channels)
            .values({
              id: randomUUID(),
              userId: ownerId,
              workspaceId: null, // pod-wide
              channelType: ChannelType.PERSONAL,
              scope: ChannelScope.POD,
              status: ChannelStatus.ACTIVE,
              senderAgentId: null,
            })
            .returning({ id: channels.id });
          channelId = newChannel.id;
        }
      }

      // Resolve proactive feed channel
      if (!channelId && config.channelType === "proactive") {
        const proactiveChannel = await db.query.channels.findFirst({
          where: and(
            eq(channels.userId, ownerId),
            eq(channels.channelType, ChannelType.FEED),
            eq(channels.status, ChannelStatus.ACTIVE)
          ),
          columns: { id: true },
        });
        channelId = proactiveChannel?.id;

        if (!channelId) {
          const [newChannel] = await db
            .insert(channels)
            .values({
              id: randomUUID(),
              userId: ownerId,
              workspaceId: null, // pod-wide
              channelType: ChannelType.FEED,
              scope: ChannelScope.POD,
              feedScope: FeedScope.USER,
              status: ChannelStatus.ACTIVE,
              senderAgentId: null,
            })
            .returning({ id: channels.id });
          channelId = newChannel.id;
        }
      }

      if (!channelId) {
        throw new Error(
          "channel_message requires channelId or channelType:'personal_thread'|'proactive'"
        );
      }

      const { createHash } = await import("crypto");
      const hash = createHash("sha256")
        .update(JSON.stringify({ channelId, content, role: "assistant" }))
        .digest("hex");

      // Tag proactive channel messages so the feed can identify their type
      // without needing to know which channel they came from.
      const proactiveType =
        config.channelType === "proactive"
          ? (metadata.proactiveType ?? config.proactiveType ?? "insight")
          : undefined;

      const [msg] = await db
        .insert(messages)
        .values({
          id: randomUUID(),
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

      return {
        status: "updated",
        sessionId: session.id,
        ...(stageChanged ? { stageChanged: true, toStage: currentStage } : {}),
      };
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
 * Supported pipes: uppercase, lowercase, json, trim
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(resolvedUrl, {
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

  // 4. Create a focus session for this playbook run
  const [session] = await db
    .insert(focusSessions)
    .values({
      workspaceId,
      userId: ownerId,
      goal,
      playbookId: playbook.id,
      status: "active",
      // Seed the first stage so the session starts stage-aware (the initial IS
      // dispatch gets the stage hint/grant), matching the tRPC/Hub creation path.
      currentStage:
        (playbook.stages as { key?: string }[] | null)?.[0]?.key ?? null,
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
    })
    .returning();

  // 8. Insert a USER kickoff message into the channel
  const messageId = randomUUID();
  const { createHash } = await import("crypto");
  const hash = createHash("sha256").update(`${messageId}${goal}`).digest("hex");

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
  if (!flow.nodes.length) {
    logger.warn({ automationId }, "Automation has no nodes — marking complete");
    await db
      .update(automationRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(automationRuns.id, runId));
    return {};
  }

  // Sort nodes topologically
  const sortedNodes = topoSort(flow.nodes, flow.edges);

  // Build execution context
  const context: StepContext = {
    trigger: {
      payload: (run.triggerPayload as Record<string, unknown>) ?? {},
    },
    steps: {},
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
    let output: Record<string, unknown> = {};

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
            for (const edge of untakenEdges) {
              markDescendantsSkipped(edge.target, flow.edges, skippedNodes);
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

            // Re-enqueue the rest of the DAG with startAfter
            const boss = getBoss();
            await boss.send(
              "automation-execute",
              {
                runId,
                automationId,
                workspaceId,
                automationContext,
                completedNodeIds: completedSoFar,
              },
              { startAfter: resumeAt }
            );

            // Mark step as completed and return early — execution will resume after delay
            context.steps[node.id] = { output };
            stepsCompleted++;

            await db
              .update(automationStepRuns)
              .set({ status: "completed", output, completedAt: new Date() })
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
              automationContext,
              ownerId
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
            // from it — traversal STOPS at any unsupported node type (condition,
            // switch, skill, delay, a nested loop, …). Those are BOUNDARIES: not
            // owned by the loop, so they are neither dispatched per-item nor marked
            // skipped — they run ONCE in the main topological pass (as before this
            // rewrite). This keeps a linear per-item body (messages_query → command
            // → session_update → entity_create) working while never silently
            // dropping downstream branch/merge/post-loop logic.
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
            const bodyNodes = sortedNodes.filter((n) => bodyNodeIds.has(n.id));

            // Execute the body subgraph for each item
            const iterationResults: unknown[] = [];
            for (let i = 0; i < items.length; i++) {
              // Set loop context
              context.loop = { item: items[i], index: i };

              for (const childNode of bodyNodes) {
                try {
                  let childOutput: Record<string, unknown> = {};

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
                        automationContext,
                        ownerId
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
            output = await executeMessagesQueryStep(data, context, workspaceId);
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
                for (const edge of caseEdges) {
                  markDescendantsSkipped(edge.target, flow.edges, skippedNodes);
                }
              }
            }

            // If no case matched, skip all outgoing edges
            if (matched === null) {
              const allOutEdges = getOutEdges(flow.edges, node.id);
              for (const edge of allOutEdges) {
                markDescendantsSkipped(edge.target, flow.edges, skippedNodes);
              }
            }
            break;
          }

          case "skill": {
            const data = node.data as {
              skillId?: string;
              inputMapping?: Record<string, string>;
            };

            const skillId = data.skillId;
            if (!skillId) throw new Error("Skill node has no skillId");

            // ── Capability-execution gate (Wave 3a — automation door) ──────────
            // FULL gate: now that `gateCapabilityExecution` lives in the shared
            // `@synap/capability-gate` package (no longer trapped in @synap/api,
            // which `@synap/jobs` cannot import without a cycle), this door runs
            // the SAME approved + grant + exec-mode gate as the IS/operator doors.
            // An automation runs as the workspace OWNER (no agent identity), so:
            //   actorUserId = ownerId, agentUserId = null →
            //     • owner runs their OWN skill          → owner-bypass → run
            //     • non-owner-owned + approved          → auto         → run
            //     • non-owner-owned + UNapproved        → propose
            // A mid-flow automation has no interactive review surface, so a
            // propose/deny verdict FAILS CLOSED (throws) — strictly stronger than
            // the prior approved-only check (which also threw on unapproved), and
            // honoring dry-run by skipping the external call. NOTE: any in-skill
            // `callProvider` is ALREADY gated transitively by Site 1 (the IS
            // provider call funnels through triggerProviderAction).
            const [skillRow] = await db
              .select({
                id: skills.id,
                approved: skills.approved,
                userId: skills.userId,
              })
              .from(skills)
              .where(eq(skills.id, skillId))
              .limit(1);
            const skillDecision = await gateCapabilityExecution({
              capabilityKind: "skill",
              capabilityId: skillId,
              skill: skillRow ?? null,
              actorUserId: ownerId,
              agentUserId: null,
              workspaceId,
              issuer: "automation.skill-node",
            });
            if (skillDecision.decision === "deny") {
              throw new Error(
                `Skill ${skillId} refused by capability gate: ${skillDecision.reason}`
              );
            }
            if (skillDecision.decision === "propose") {
              throw new Error(
                `Skill ${skillId} requires human approval and cannot run inside an automation; automation skill node refused.`
              );
            }
            if (skillDecision.decision === "dry-run") {
              // Grant resolved to dry-run preview — no external side effect.
              output = { output: { dryRun: true, skillId }, skillId };
              break;
            }
            // decision === "run" → fall through to execute the skill.

            const inputMapping = data.inputMapping ?? {};
            const resolvedInputs = resolveInputMapping(inputMapping, context);

            await db
              .update(automationStepRuns)
              .set({ resolvedInputs })
              .where(eq(automationStepRuns.id, stepRun.id));

            // Canonical IS credential resolution (decrypted DB key), not stale env.
            const { endpoint: isUrl, apiKey: isApiKey } =
              await getDefaultActiveService();

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 60_000);

            let skillResponse: Response;
            try {
              // IS contract (routes/skills-route.ts): POST /api/skills/execute,
              // skill id + inputs in the BODY ({ skillId, userId, parameters }).
              // The prior `/:id/execute` path + `{ context }` body 404'd / dropped
              // inputs — skill nodes never actually ran. Fixed to the real contract.
              skillResponse = await fetch(`${isUrl}/api/skills/execute`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-API-Key": isApiKey,
                },
                body: JSON.stringify({
                  skillId,
                  userId: ownerId,
                  parameters: resolvedInputs,
                }),
                signal: controller.signal,
              });
              clearTimeout(timer);
            } catch (err) {
              clearTimeout(timer);
              throw err;
            }

            if (!skillResponse.ok) {
              const body = await skillResponse.text();
              throw new Error(
                `Skill execution failed: ${skillResponse.status} ${body}`
              );
            }

            const skillResult = (await skillResponse.json()) as Record<
              string,
              unknown
            >;
            output = { output: skillResult.output ?? skillResult, skillId };
            break;
          }

          case "capability": {
            // ── Typed/governed Tool → Verb step (Process builder) ─────────────
            // A `capability` node is the structured sibling of the `skill` node:
            // the author picks a Tool (capabilityId) and a Verb on it (verbId).
            // A verb is BACKED BY A SKILL — its `id` is the requiring skill's
            // NAME (see ToolVerbCatalogEntry.id in schema/tools.ts). So the case
            // resolves verb → backing skill row, then runs it through the SAME
            // governed path `case "skill"` uses (gateCapabilityExecution →
            // run | propose | dry-run | deny). No parallel governance, no new
            // tables: the skill IS the executor; the gate IS the door.
            const data = node.data as {
              capabilityId?: string;
              verbId?: string;
              inputMapping?: Record<string, string>;
            };

            const verbId = data.verbId;
            if (!verbId) throw new Error("Capability node has no verbId");

            // Resolve the backing skill by NAME (verbId = requiring skill's name),
            // scoped exactly like the capability registry read-model: pod-wide
            // (NULL workspace) OR this workspace OR owned by the automation owner.
            const [skillRow] = await db
              .select({
                id: skills.id,
                approved: skills.approved,
                userId: skills.userId,
              })
              .from(skills)
              .where(
                and(
                  eq(skills.name, verbId),
                  or(
                    isNull(skills.workspaceId),
                    eq(skills.workspaceId, workspaceId),
                    eq(skills.userId, ownerId)
                  )
                )
              )
              .limit(1);

            if (!skillRow) {
              throw new Error(
                `Capability verb "${verbId}" has no backing skill in this workspace.`
              );
            }

            const capSkillId = skillRow.id;

            // ── Capability-execution gate (SAME door as `case "skill"`) ───────
            // An automation runs as the workspace OWNER (no agent identity):
            //   actorUserId = ownerId, agentUserId = null →
            //     • owner runs their OWN skill          → owner-bypass → run
            //     • non-owner-owned + approved          → auto         → run
            //     • non-owner-owned + UNapproved        → propose (FAILS CLOSED)
            // A mid-flow automation has no interactive review surface, so a
            // propose/deny verdict throws; dry-run is honored as a no-op preview.
            const capDecision = await gateCapabilityExecution({
              capabilityKind: "skill",
              capabilityId: capSkillId,
              skill: skillRow,
              actorUserId: ownerId,
              agentUserId: null,
              workspaceId,
              issuer: "automation.capability-node",
            });
            if (capDecision.decision === "deny") {
              throw new Error(
                `Capability ${verbId} refused by capability gate: ${capDecision.reason}`
              );
            }
            if (capDecision.decision === "propose") {
              throw new Error(
                `Capability ${verbId} requires human approval and cannot run inside an automation; capability node refused.`
              );
            }
            if (capDecision.decision === "dry-run") {
              // Grant resolved to dry-run preview — no external side effect.
              output = {
                output: { dryRun: true, verbId, skillId: capSkillId },
                verbId,
                skillId: capSkillId,
              };
              break;
            }
            // decision === "run" → execute the backing skill.

            const capInputMapping = data.inputMapping ?? {};
            const capResolvedInputs = resolveInputMapping(
              capInputMapping,
              context
            );

            await db
              .update(automationStepRuns)
              .set({ resolvedInputs: capResolvedInputs })
              .where(eq(automationStepRuns.id, stepRun.id));

            // Canonical IS credential resolution (decrypted DB key), not stale env.
            const { endpoint: capIsUrl, apiKey: capIsApiKey } =
              await getDefaultActiveService();

            const capController = new AbortController();
            const capTimer = setTimeout(() => capController.abort(), 60_000);

            let capResponse: Response;
            try {
              // IS contract: POST /api/skills/execute with { skillId, userId,
              // parameters } in the body (see executeSkillViaIS + skills-route.ts).
              capResponse = await fetch(`${capIsUrl}/api/skills/execute`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-API-Key": capIsApiKey,
                },
                body: JSON.stringify({
                  skillId: capSkillId,
                  userId: ownerId,
                  parameters: capResolvedInputs,
                }),
                signal: capController.signal,
              });
              clearTimeout(capTimer);
            } catch (err) {
              clearTimeout(capTimer);
              throw err;
            }

            if (!capResponse.ok) {
              const body = await capResponse.text();
              throw new Error(
                `Capability execution failed: ${capResponse.status} ${body}`
              );
            }

            const capResult = (await capResponse.json()) as Record<
              string,
              unknown
            >;
            output = {
              output: capResult.output ?? capResult,
              verbId,
              skillId: capSkillId,
            };
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

            output = {
              output: childOutput,
              automationId: targetId,
              runId: childRunId,
            };
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
        .set({
          status: "completed",
          output,
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
    .find(([, s]) => s.output && Object.keys(s.output).length > 0);
  const outputSummary: Record<string, unknown> | null = lastCompletedWithOutput
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

  return outputSummary ?? {};
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

  await executeAutomationFlow({
    automationId,
    runId,
    workspaceId,
    ownerId: automation.createdBy,
    payload: (run.triggerPayload as Record<string, unknown>) ?? {},
    automationContext,
    completedNodeIds,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Safe condition evaluator.
 * Supports simple comparisons — NO eval().
 * Format: "path.to.value === 'expected'" or "path.to.value > 5"
 */
function evaluateCondition(expression: string, context: StepContext): boolean {
  try {
    // Parse simple comparison: left op right
    const match = expression.match(
      /^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/
    );
    if (!match) {
      logger.warn({ expression }, "Cannot parse condition — defaulting true");
      return true;
    }

    const [, leftPath, operator, rightRaw] = match;
    const leftValue = resolveTemplate(`{{${leftPath.trim()}}}`, context);

    // Parse right side: remove quotes for strings, parse numbers
    let rightValue: string | number = rightRaw.trim();
    if (
      (rightValue.startsWith("'") && rightValue.endsWith("'")) ||
      (rightValue.startsWith('"') && rightValue.endsWith('"'))
    ) {
      rightValue = rightValue.slice(1, -1);
    } else if (!isNaN(Number(rightValue))) {
      rightValue = Number(rightValue);
    }

    const left = typeof rightValue === "number" ? Number(leftValue) : leftValue;

    switch (operator) {
      case "===":
      case "==":
        return left === rightValue;
      case "!==":
      case "!=":
        return left !== rightValue;
      case ">":
        return Number(left) > Number(rightValue);
      case "<":
        return Number(left) < Number(rightValue);
      case ">=":
        return Number(left) >= Number(rightValue);
      case "<=":
        return Number(left) <= Number(rightValue);
      default:
        return true;
    }
  } catch {
    logger.warn(
      { expression },
      "Condition evaluation failed — defaulting true"
    );
    return true;
  }
}

/**
 * Mark all descendant nodes as skipped (for untaken condition branches).
 */
function markDescendantsSkipped(
  nodeId: string,
  edges: AutomationEdge[],
  skippedNodes: Set<string>
): void {
  if (skippedNodes.has(nodeId)) return;
  skippedNodes.add(nodeId);

  const outEdges = edges.filter((e) => e.source === nodeId);
  for (const edge of outEdges) {
    markDescendantsSkipped(edge.target, edges, skippedNodes);
  }
}

// Node types a loop may dispatch per-item (mirrors the `switch (childNode.type)`
// in the loop body). Traversal of a loop's body STOPS at any type not in this
// set, so branch/control nodes (condition, switch, skill, delay, nested loop)
// are boundaries that run once in the main pass rather than being swallowed.
const LOOP_BODY_NODE_TYPES = new Set<string>([
  "command",
  "output",
  "playbook_run",
  "messages_query",
  "query",
  "fetch",
  "transform",
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
