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
 *
 * Events emitted by output steps carry automationContext so the trigger
 * matcher can detect and prevent circular chains.
 */

import {
  db,
  eq,
  automations,
  automationRuns,
  automationStepRuns,
  entities,
  messages,
  drizzleSql,
} from "@synap/database";
import type {
  FlowDefinition,
  AutomationNode,
  AutomationEdge,
} from "@synap/database";
import { emitSideEffects } from "../emit-side-effects.js";
import { getBoss } from "../boss.js";
import {
  resolveVaultReferences,
  isVaultReference,
} from "../utils/vault-resolver.js";
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

  // Call IS via the same pattern as background-task-scheduler
  const isUrl =
    process.env.AGENT_HUB_URL ||
    process.env.INTELLIGENCE_HUB_URL ||
    "http://localhost:3002";
  const isApiKey =
    process.env.AGENT_HUB_API_KEY || process.env.INTELLIGENCE_HUB_API_KEY || "";

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
        userId: "system",
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
      const profileSlug = config.profileSlug as string;
      const title = config.title as string;
      const properties = (config.properties ?? {}) as Record<string, unknown>;

      const [entity] = await db
        .insert(entities)
        .values({
          userId: "system",
          workspaceId,
          type: profileSlug ?? "note",
          title,
          properties,
        } as any)
        .returning({ id: entities.id, title: entities.title });

      // Emit side effects so the entity gets indexed, embedded, and can trigger further automations
      await emitSideEffects({
        subjectType: "entity",
        action: "create",
        subjectId: entity.id,
        userId: "system",
        workspaceId,
        data: { profileSlug, title },
        automationContext,
      });

      return { status: "created", entityId: entity.id, title: entity.title };
    }

    case "entity_update": {
      const entityId = config.entityId as string;
      const properties = (config.properties ?? {}) as Record<string, unknown>;

      if (!entityId)
        throw new Error("entity_update requires entityId in config");

      await db
        .update(entities)
        .set({
          properties: drizzleSql`COALESCE(properties, '{}'::jsonb) || ${JSON.stringify(properties)}::jsonb`,
          updatedAt: new Date(),
        } as any)
        .where(eq(entities.id, entityId));

      await emitSideEffects({
        subjectType: "entity",
        action: "update",
        subjectId: entityId,
        userId: "system",
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
      const message = config.message as string;
      // Notifications queue — for now, log and store in output
      // TODO: Wire to notification system when available
      logger.info({ workspaceId, message }, "Automation notification");
      return { status: "sent", message };
    }

    case "channel_message": {
      const channelId = config.channelId as string;
      const content = config.content as string;

      if (!channelId || !content) {
        throw new Error("channel_message requires channelId and content");
      }

      const [msg] = await db
        .insert(messages)
        .values({
          channelId,
          role: "system",
          content,
          metadata: { type: "automation_message", automationContext },
        } as any)
        .returning({ id: messages.id });

      return { status: "sent", messageId: msg.id, channelId };
    }

    default:
      logger.warn({ outputType: data.outputType }, "Unknown output type");
      return { status: "unknown_output_type", outputType: data.outputType };
  }
}

// ── Main Executor ───────────────────────────────────────────────────────────

/**
 * Main executor: walk the DAG and execute each step.
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
    return;
  }

  // Load run for trigger payload
  const run = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.id, runId),
  });

  if (!run) {
    logger.error({ runId }, "Automation run not found");
    return;
  }

  const flow = automation.flowDefinition as FlowDefinition;
  if (!flow.nodes.length) {
    logger.warn({ automationId }, "Automation has no nodes — marking complete");
    await db
      .update(automationRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(automationRuns.id, runId));
    return;
  }

  // Owner of the automation — used for vault secret resolution
  const ownerId = automation.createdBy;

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
          node.type === "command" ? (node.data as any).commandId : undefined,
        status: "running",
        startedAt: new Date(),
      })
      .returning({ id: automationStepRuns.id });

    try {
      let output: Record<string, unknown> = {};

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
          const takenHandle = result ? "yes" : "no";
          const untakenHandle = result ? "no" : "yes";

          const untakenEdges = getOutEdges(flow.edges, node.id, untakenHandle);
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

          return; // Exit — execution resumes after delay
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
          const items = Array.isArray(collection) ? collection : [];

          if (items.length === 0) {
            output = { status: "empty_collection", itemCount: 0 };
            break;
          }

          // Find child nodes (nodes connected from this loop node)
          const childEdges = getOutEdges(flow.edges, node.id);
          const childNodeIds = new Set(childEdges.map((e) => e.target));

          // Execute child nodes for each item
          const iterationResults: unknown[] = [];
          for (let i = 0; i < items.length; i++) {
            // Set loop context
            context.loop = { item: items[i], index: i };

            // Execute each child node in this iteration
            for (const childNode of sortedNodes.filter((n) =>
              childNodeIds.has(n.id)
            )) {
              try {
                let childOutput: Record<string, unknown> = {};

                if (childNode.type === "command") {
                  childOutput = await executeCommandStep(
                    childNode.data as any,
                    context,
                    workspaceId,
                    ownerId
                  );
                } else if (childNode.type === "output") {
                  childOutput = await executeOutputStep(
                    childNode.data as any,
                    context,
                    workspaceId,
                    automationContext,
                    ownerId
                  );
                }

                iterationResults.push({
                  iteration: i,
                  nodeId: childNode.id,
                  output: childOutput,
                });

                // Update step context so later children can reference this output
                context.steps[`${childNode.id}_iter${i}`] = {
                  output: childOutput,
                };
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
              }
            }
          }

          // Clear loop context
          delete context.loop;

          // Mark child nodes as completed so the main loop skips them
          for (const childId of childNodeIds) {
            skippedNodes.add(childId);
          }

          output = {
            status: "completed",
            itemCount: items.length,
            results: iterationResults,
          };
          break;
        }
      }

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
    } catch (err) {
      stepsFailed++;
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      logger.error({ err, nodeId: node.id, runId }, "Automation step failed");

      await db
        .update(automationStepRuns)
        .set({
          status: "failed",
          errorMessage,
          completedAt: new Date(),
        })
        .where(eq(automationStepRuns.id, stepRun.id));

      // Stop execution on first failure (fail-fast)
      break;
    }
  }

  // Update run with final status
  const finalStatus = stepsFailed > 0 ? "failed" : "completed";
  await db
    .update(automationRuns)
    .set({
      status: finalStatus,
      stepsCompleted,
      stepsFailed,
      completedAt: new Date(),
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
