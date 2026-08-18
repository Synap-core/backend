/**
 * Pure DAG/graph-topology primitives for the automation flow — extracted as a
 * LEAF (no imports from the worker or any `steps/*` module) so both the
 * run-loop (`automation-executor.ts`) and the retry-safety floor
 * (`retry-safety.ts`) can depend on the SAME implementation without a circular
 * import between them.
 */
import type { AutomationNode, AutomationEdge } from "@synap/database";

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
 * Get edges leaving a node, optionally filtered by sourceHandle.
 */
export function getOutEdges(
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
      // Skip AUTHORING NOTES — `_`-prefixed keys are documentation the runtime
      // never evaluates. Kept in lockstep with the two validate-flow copies of
      // this walker; if they diverge, save-time validation and run-time binding
      // collection disagree about what a flow references.
      for (const [k, x] of Object.entries(v)) {
        if (k.startsWith("_")) continue;
        walk(x);
      }
    }
  };
  walk(data);
  return found;
}
