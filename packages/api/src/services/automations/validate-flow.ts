/**
 * Node-contract validation for automation flow definitions.
 *
 * Today the persist doors (`automations.create` / `automations.update`) validate
 * flow SHAPE only (`{ nodes: [], edges: [] }`). A semantically-broken flow — a
 * `channel_message` output with a typo'd `channelType`, a `capability` node with
 * no `verbId`, an edge to a nonexistent node, a cycle, an unknown `node.type` —
 * PERSISTS and only fails at runtime (automation-executor.ts throws mid-run).
 *
 * `validateFlowDefinition` closes that gap: a PURE, synchronous, DB-free function
 * that rejects malformed flows at AUTHOR time with actionable per-node errors.
 *
 * The node contract mirrored here is the SSOT in two files:
 *   - the NodeDef interfaces + `AutomationNodeBase.type` union in
 *     `@synap/database` `schema/automations.ts` (the 21 node types, the 11
 *     output types, the field names), and
 *   - how `automation-executor.ts` HARD-requires those fields (each `throw` in a
 *     node case is a contract this validator front-runs). Where the executor
 *     throws `"X node has no Y"`, this validator reports the same missing field.
 *
 * Existence checks against live catalogs (does this `verbId` / `skillId` /
 * playbook actually exist?) require DB access, so they are RESOLVER-GATED: pass
 * an optional `FlowValidationResolvers` to enable them. With no resolver the core
 * structural + contract checks still run — those catch every bug listed above.
 */

// `import type` — erased at compile time, so this file stays runtime pure/DB-free.
// It exists only to bind the runtime arrays below to the schema union at compile
// time (the drift guard after the constants).
import type { AutomationNodeBase, OutputNodeDef } from "@synap/database";

// ── Contract constants (mirror schema/automations.ts — keep in sync) ──────────

/** The 21 node types — `AutomationNodeBase.type` union (schema/automations.ts). */
export const FLOW_NODE_TYPES = [
  "trigger",
  "command",
  "condition",
  "delay",
  "output",
  "loop",
  "transform",
  "fetch",
  "query",
  "entity_read",
  "related_entities",
  "guard",
  "compute",
  "select",
  "claim",
  "messages_query",
  "switch",
  "skill",
  "capability",
  "sub_automation",
  "playbook_run",
] as const;

/** The 11 output types — `OutputNodeDef.data.outputType` (schema/automations.ts). */
export const FLOW_OUTPUT_TYPES = [
  "notification",
  "entity_create",
  "entity_update",
  "facet_attach",
  "facet_update",
  "facet_detach",
  "relation_create",
  "webhook",
  "channel_message",
  "session_update",
  "set_state",
] as const;

/**
 * The known `config.channelType` values for a `channel_message` output. Mirrors
 * the executor's channel_message resolution (automation-executor.ts). The output
 * channel is now CONTEXT-DERIVED — a channel_message is valid with `channelId`,
 * OR `channelEntityRef` (an entity-id expression → that entity's internal
 * channel), OR a `channelType` from this set, OR NOTHING (the executor defaults a
 * targetless channel_message to the automation's own run channel). A `channelType`
 * that is PRESENT but not one of these is still a typo → still an error.
 */
// The executor's channel_message resolution (automation-executor.ts) is the SSOT
// for these values; config is an untyped Record so there is no compile-time
// drift guard here — keep this array in sync with the executor by hand.
export const CHANNEL_MESSAGE_CHANNEL_TYPES = [
  "personal_thread",
  "proactive",
  "subjectEntity",
] as const;

const NODE_TYPE_SET = new Set<string>(FLOW_NODE_TYPES);
const OUTPUT_TYPE_SET = new Set<string>(FLOW_OUTPUT_TYPES);
const CHANNEL_TYPE_SET = new Set<string>(CHANNEL_MESSAGE_CHANNEL_TYPES);

// ── Drift guard (compile-time) ────────────────────────────────────────────────
// The arrays above are hand-mirrored from TS *union types* in the schema (unions
// aren't runtime values, so they can't be imported and iterated). Without a
// binding, adding a node/output type to the schema would silently make this
// validator REJECT the new type as `unknown_node_type` at the author door.
// `AssertExact` resolves to `never` on any drift in EITHER direction, so the
// `: true` assignment then fails `tsc` — forcing the arrays back in sync.
type AssertExact<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _nodeTypesInSync: AssertExact<
  (typeof FLOW_NODE_TYPES)[number],
  AutomationNodeBase["type"]
> = true;
const _outputTypesInSync: AssertExact<
  (typeof FLOW_OUTPUT_TYPES)[number],
  OutputNodeDef["data"]["outputType"]
> = true;
void _nodeTypesInSync;
void _outputTypesInSync;

// ── Result / error types ──────────────────────────────────────────────────────

export interface FlowValidationError {
  /** Node the error is about (absent for graph-level / edge-level errors). */
  nodeId?: string;
  /** Edge the error is about (for dangling-reference / bad-handle errors). */
  edgeId?: string;
  /** Stable machine code — see the `code` literals below. */
  code: string;
  /** Human-actionable message naming what is wrong and how to fix it. */
  message: string;
}

export interface FlowValidationResult {
  valid: boolean;
  errors: FlowValidationError[];
}

/**
 * Optional catalog resolvers. When provided, existence checks run; when omitted,
 * those checks are SKIPPED (structural + contract checks always run). Kept
 * synchronous so the whole function stays pure — the caller pre-loads whatever
 * it needs and passes predicates.
 */
export interface FlowValidationResolvers {
  /** Does this capability verb (skill name) exist in the workspace catalog? */
  verbExists?: (verbId: string) => boolean;
  /** Does the referenced skill exist (by id OR by name)? */
  skillExists?: (ref: { skillId?: string; skillName?: string }) => boolean;
  /** Does the referenced playbook exist? */
  playbookExists?: (ref: {
    playbookId?: string;
    playbookName?: string;
  }) => boolean;
}

// ── Loose input shapes (the flow arrives as untyped JSON at the door) ──────────

interface LooseNode {
  id?: unknown;
  type?: unknown;
  data?: unknown;
}
interface LooseEdge {
  id?: unknown;
  source?: unknown;
  target?: unknown;
  sourceHandle?: unknown;
}
interface LooseFlow {
  nodes?: unknown;
  edges?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// ── The validator ─────────────────────────────────────────────────────────────

/**
 * Validate an automation flow definition against the node contract.
 * Pure and synchronous. `resolvers` gate the catalog-existence checks only.
 */
export function validateFlowDefinition(
  flow: unknown,
  resolvers?: FlowValidationResolvers
): FlowValidationResult {
  const errors: FlowValidationError[] = [];

  // ── Shape ───────────────────────────────────────────────────────────────────
  if (!isRecord(flow)) {
    return {
      valid: false,
      errors: [
        {
          code: "flow_not_object",
          message:
            "flowDefinition must be an object with `nodes` and `edges` arrays.",
        },
      ],
    };
  }
  const f = flow as LooseFlow;
  if (!Array.isArray(f.nodes)) {
    errors.push({
      code: "nodes_not_array",
      message: "flowDefinition.nodes must be an array.",
    });
  }
  if (!Array.isArray(f.edges)) {
    errors.push({
      code: "edges_not_array",
      message: "flowDefinition.edges must be an array.",
    });
  }
  // Can't do node/edge checks without the arrays.
  if (errors.length > 0) return { valid: false, errors };

  const nodes = (f.nodes as unknown[]).map((n) =>
    isRecord(n) ? n : {}
  ) as LooseNode[];
  const edges = (f.edges as unknown[]).map((e) =>
    isRecord(e) ? e : {}
  ) as LooseEdge[];

  // ── Node ids: present, string, unique ─────────────────────────────────────────
  const nodeIds = new Set<string>();
  const seenIds = new Set<string>();
  nodes.forEach((node, idx) => {
    if (!nonEmptyString(node.id)) {
      errors.push({
        code: "node_missing_id",
        message: `Node at index ${idx} is missing a non-empty string \`id\`.`,
      });
      return;
    }
    if (seenIds.has(node.id)) {
      errors.push({
        nodeId: node.id,
        code: "duplicate_node_id",
        message: `Duplicate node id "${node.id}" — every node id must be unique.`,
      });
      return;
    }
    seenIds.add(node.id);
    nodeIds.add(node.id);
  });

  // ── Per-node type + contract ──────────────────────────────────────────────────
  const nodesById = new Map<string, LooseNode>();
  for (const node of nodes) {
    if (nonEmptyString(node.id)) nodesById.set(node.id, node);

    const nodeId = nonEmptyString(node.id) ? node.id : undefined;

    // node.type ∈ the union
    if (!nonEmptyString(node.type) || !NODE_TYPE_SET.has(node.type)) {
      errors.push({
        nodeId,
        code: "unknown_node_type",
        message: `Node ${nodeId ? `"${nodeId}"` : `at index ?`} has ${
          nonEmptyString(node.type) ? `unknown type "${node.type}"` : "no type"
        }. Must be one of: ${FLOW_NODE_TYPES.join(", ")}.`,
      });
      continue; // contract checks below are type-specific
    }

    const type = node.type;
    const data = isRecord(node.data) ? node.data : {};

    switch (type) {
      case "capability": {
        if (!nonEmptyString(data.verbId)) {
          errors.push({
            nodeId,
            code: "capability_missing_verbId",
            message: `Capability node "${nodeId}" has no \`verbId\`. Pick a verb on the selected tool.`,
          });
        } else if (
          resolvers?.verbExists &&
          !resolvers.verbExists(data.verbId)
        ) {
          errors.push({
            nodeId,
            code: "capability_unknown_verbId",
            message: `Capability node "${nodeId}" references verb "${data.verbId}", which is not in the capability catalog.`,
          });
        }
        break;
      }

      case "skill": {
        // Accept `skillId` OR `skillName` — the template-friendly form (mirrors
        // playbook_run's id-OR-name): a capability seeds a skill + an automation
        // that references it by its stable name, since the runtime id isn't known
        // at author time. The create door resolves skillName → skillId pre-insert.
        const skillId = nonEmptyString(data.skillId) ? data.skillId : undefined;
        const skillName = nonEmptyString(data.skillName)
          ? data.skillName
          : undefined;
        if (!skillId && !skillName) {
          errors.push({
            nodeId,
            code: "skill_missing_ref",
            message: `Skill node "${nodeId}" has neither \`skillId\` nor \`skillName\`. One is required.`,
          });
        } else if (
          resolvers?.skillExists &&
          !resolvers.skillExists({ skillId, skillName })
        ) {
          errors.push({
            nodeId,
            code: "skill_unknown_ref",
            message: `Skill node "${nodeId}" references a skill (${
              skillId ? `id "${skillId}"` : `name "${skillName}"`
            }) that does not exist.`,
          });
        }
        break;
      }

      case "playbook_run": {
        const playbookId = nonEmptyString(data.playbookId)
          ? data.playbookId
          : undefined;
        const playbookName = nonEmptyString(data.playbookName)
          ? data.playbookName
          : undefined;
        if (!playbookId && !playbookName) {
          errors.push({
            nodeId,
            code: "playbook_run_missing_ref",
            message: `Playbook-run node "${nodeId}" has neither \`playbookId\` nor \`playbookName\`. One is required.`,
          });
        } else if (
          resolvers?.playbookExists &&
          !resolvers.playbookExists({ playbookId, playbookName })
        ) {
          errors.push({
            nodeId,
            code: "playbook_run_unknown_ref",
            message: `Playbook-run node "${nodeId}" references a playbook (${
              playbookId ? `id "${playbookId}"` : `name "${playbookName}"`
            }) that does not exist.`,
          });
        }
        break;
      }

      case "output": {
        const outputType = data.outputType;
        if (!nonEmptyString(outputType) || !OUTPUT_TYPE_SET.has(outputType)) {
          errors.push({
            nodeId,
            code: "output_bad_outputType",
            message: `Output node "${nodeId}" has ${
              nonEmptyString(outputType)
                ? `unknown outputType "${outputType}"`
                : "no outputType"
            }. Must be one of: ${FLOW_OUTPUT_TYPES.join(", ")}.`,
          });
          break;
        }
        // channel_message target is CONTEXT-DERIVED: valid with channelId,
        // channelEntityRef, a known channelType, OR nothing (executor defaults a
        // targetless channel_message to the automation's own run channel). Only a
        // channelType that is PRESENT but unknown is an error (a typo'd type).
        if (outputType === "channel_message") {
          const config = isRecord(data.config) ? data.config : {};
          const channelType = config.channelType;
          if (channelType !== undefined && channelType !== null) {
            if (
              !nonEmptyString(channelType) ||
              !CHANNEL_TYPE_SET.has(channelType)
            ) {
              errors.push({
                nodeId,
                code: "channel_message_unknown_channelType",
                message: `Channel-message output "${nodeId}" has unknown channelType ${
                  nonEmptyString(channelType)
                    ? `"${channelType}"`
                    : JSON.stringify(channelType)
                }. Use one of: ${CHANNEL_MESSAGE_CHANNEL_TYPES.join(
                  ", "
                )}, or set \`config.channelEntityRef\`/\`config.channelId\`, or omit the target to post to the automation's own run channel.`,
              });
            }
          }
        }
        break;
      }

      case "loop": {
        if (!nonEmptyString(data.iteratorExpression)) {
          errors.push({
            nodeId,
            code: "loop_missing_iterator",
            message: `Loop node "${nodeId}" has no \`iteratorExpression\` (the items to iterate, e.g. "steps.query.output.entities").`,
          });
        }
        break;
      }

      case "condition": {
        if (!nonEmptyString(data.expression)) {
          errors.push({
            nodeId,
            code: "condition_missing_expression",
            message: `Condition node "${nodeId}" has no \`expression\` (the predicate to evaluate).`,
          });
        }
        break;
      }

      case "switch": {
        if (!nonEmptyString(data.expression)) {
          errors.push({
            nodeId,
            code: "switch_missing_expression",
            message: `Switch node "${nodeId}" has no \`expression\` (the value to match against cases).`,
          });
        }
        if (!Array.isArray(data.cases) || data.cases.length === 0) {
          errors.push({
            nodeId,
            code: "switch_missing_cases",
            message: `Switch node "${nodeId}" has no \`cases\`. Add at least one case with a \`value\`.`,
          });
        }
        break;
      }
    }
  }

  // ── Edges: source/target reference existing nodes ─────────────────────────────
  edges.forEach((edge, idx) => {
    const edgeId = nonEmptyString(edge.id) ? edge.id : undefined;
    const label = edgeId ? `"${edgeId}"` : `at index ${idx}`;
    if (!nonEmptyString(edge.source) || !nodeIds.has(edge.source)) {
      errors.push({
        edgeId,
        code: "edge_bad_source",
        message: `Edge ${label} has ${
          nonEmptyString(edge.source)
            ? `source "${edge.source}" which is not a node in this flow`
            : "no source node"
        }.`,
      });
    }
    if (!nonEmptyString(edge.target) || !nodeIds.has(edge.target)) {
      errors.push({
        edgeId,
        code: "edge_bad_target",
        message: `Edge ${label} has ${
          nonEmptyString(edge.target)
            ? `target "${edge.target}" which is not a node in this flow`
            : "no target node"
        }.`,
      });
    }
  });

  // ── Edge handles: condition → yes/no, switch → a declared case value ──────────
  for (const edge of edges) {
    if (!nonEmptyString(edge.source) || !nodesById.has(edge.source)) continue;
    if (edge.sourceHandle === undefined || edge.sourceHandle === null) continue;
    if (!nonEmptyString(edge.sourceHandle)) continue;
    const src = nodesById.get(edge.source)!;
    const edgeId = nonEmptyString(edge.id) ? edge.id : undefined;
    if (src.type === "condition") {
      if (edge.sourceHandle !== "yes" && edge.sourceHandle !== "no") {
        errors.push({
          edgeId,
          nodeId: edge.source,
          code: "condition_bad_handle",
          message: `Edge from condition "${edge.source}" has sourceHandle "${edge.sourceHandle}" — must be "yes" or "no".`,
        });
      }
    } else if (src.type === "switch") {
      const data = isRecord(src.data) ? src.data : {};
      const caseValues = Array.isArray(data.cases)
        ? data.cases
            .map((c) => (isRecord(c) ? c.value : undefined))
            .filter((v): v is string => typeof v === "string")
        : [];
      if (!caseValues.includes(edge.sourceHandle)) {
        errors.push({
          edgeId,
          nodeId: edge.source,
          code: "switch_bad_handle",
          message: `Edge from switch "${edge.source}" has sourceHandle "${edge.sourceHandle}", which matches no declared case value (${
            caseValues.length ? caseValues.join(", ") : "none declared"
          }).`,
        });
      }
    }
  }

  // ── Acyclic (Kahn's algorithm — mirrors topoSort in automation-executor.ts) ───
  // Only run when edges reference real nodes; dangling edges are already reported
  // and would corrupt the in-degree bookkeeping.
  const cyclic = detectCycle(nodeIds, edges);
  if (cyclic.length > 0) {
    errors.push({
      code: "flow_has_cycle",
      message: `Flow has a cycle — these nodes cannot be ordered and would never run: ${cyclic.join(
        ", "
      )}. Remove the back-edge(s) so the graph is acyclic.`,
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Return the set of node ids that participate in a cycle (empty if acyclic).
 * Kahn's algorithm — the same ordering the executor's `topoSort` relies on; a
 * cycle is exactly the nodes whose in-degree never reaches zero. Edges whose
 * endpoints aren't real nodes are ignored (those are reported separately).
 */
function detectCycle(nodeIds: Set<string>, edges: LooseEdge[]): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const edge of edges) {
    const source = nonEmptyString(edge.source) ? edge.source : undefined;
    const target = nonEmptyString(edge.target) ? edge.target : undefined;
    if (!source || !target) continue;
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    adjacency.get(source)!.push(target);
    inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, degree] of inDegree) if (degree === 0) queue.push(id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const target of adjacency.get(id) ?? []) {
      const next = (inDegree.get(target) ?? 1) - 1;
      inDegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (visited === nodeIds.size) return [];
  // The remaining nodes (in-degree > 0 after Kahn drain) are the cycle members.
  const cyclic: string[] = [];
  for (const [id, degree] of inDegree) if (degree > 0) cyclic.push(id);
  return cyclic;
}

/**
 * Convenience helper for the persist doors: run the validator and, if invalid,
 * return a single joined actionable message (else null). Keeps the door code a
 * one-liner and the message format consistent across create/update.
 */
export function flowValidationErrorMessage(
  flow: unknown,
  resolvers?: FlowValidationResolvers
): string | null {
  const result = validateFlowDefinition(flow, resolvers);
  if (result.valid) return null;
  return (
    "Invalid automation flow: " +
    result.errors
      .map((e) => (e.nodeId ? `[${e.nodeId}] ${e.message}` : e.message))
      .join(" ")
  );
}
