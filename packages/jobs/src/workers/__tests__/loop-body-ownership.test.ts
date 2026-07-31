import { describe, it, expect } from "vitest";
import type { AutomationEdge, AutomationNode } from "@synap/database";
import {
  computeLoopBodyNodeIds,
  collectLoopBindingRefs,
} from "../automation-executor.js";

/**
 * Loop-body OWNERSHIP + the `{{loop.*}}` binding guard.
 *
 * Production failure this pins: an automation whose `capability` step failed
 * with `entityId: Invalid input: expected string, received undefined` and an
 * unresolved reference `{{loop.item.id}}`, after the loop step "succeeded" in
 * 2ms. The step ran ONCE (not once per item) — i.e. it was NOT owned by the
 * loop, so it executed in the main topological pass where `context.loop` does
 * not exist.
 *
 * `computeLoopBodyNodeIds` is the exact ownership rule the executor applies;
 * `collectLoopBindingRefs` is what the main-pass guard uses to refuse such a
 * node with an actionable message instead of resolving `loop.item.id` to
 * undefined.
 */

const n = (id: string, type: string): AutomationNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: {} }) as AutomationNode;
const e = (id: string, source: string, target: string): AutomationEdge => ({
  id,
  source,
  target,
});

describe("computeLoopBodyNodeIds — which nodes a loop OWNS", () => {
  it("owns the contiguous chain of loop-dispatchable body nodes", () => {
    const nodes = [
      n("loop", "loop"),
      n("cap", "capability"),
      n("out", "output"),
    ];
    const edges = [e("e1", "loop", "cap"), e("e2", "cap", "out")];
    expect([...computeLoopBodyNodeIds(nodes, edges, "loop")].sort()).toEqual([
      "cap",
      "out",
    ]);
  });

  it("owns NOTHING when the loop has no out-edge to the body (the production shape)", () => {
    // The body node exists and reads {{loop.item.id}}, but nothing connects the
    // loop to it — so the loop dispatches zero children and the node leaks into
    // the main pass, running exactly ONCE with no loop context.
    const nodes = [
      n("query", "query"),
      n("loop", "loop"),
      n("cap", "capability"),
    ];
    const edges = [e("e1", "query", "loop"), e("e2", "query", "cap")];
    expect(computeLoopBodyNodeIds(nodes, edges, "loop").size).toBe(0);
  });

  it("does NOT own a body-type node sitting behind a boundary node type", () => {
    // loop → switch(boundary) → capability. Traversal stops at the switch, so
    // the capability is not dispatched per-item and is not suppressed from the
    // main pass — the same leak, reached a different way.
    const nodes = [
      n("loop", "loop"),
      n("sw", "switch"),
      n("cap", "capability"),
    ];
    const edges = [e("e1", "loop", "sw"), e("e2", "sw", "cap")];
    expect(computeLoopBodyNodeIds(nodes, edges, "loop").size).toBe(0);
  });

  it("does not own a node reachable only through a nested loop", () => {
    const nodes = [
      n("loop", "loop"),
      n("inner", "loop"),
      n("cap", "capability"),
    ];
    const edges = [e("e1", "loop", "inner"), e("e2", "inner", "cap")];
    expect(computeLoopBodyNodeIds(nodes, edges, "loop").size).toBe(0);
  });

  it("terminates on a cyclic body chain", () => {
    const nodes = [n("loop", "loop"), n("a", "transform"), n("b", "transform")];
    const edges = [e("e1", "loop", "a"), e("e2", "a", "b"), e("e3", "b", "a")];
    expect([...computeLoopBodyNodeIds(nodes, edges, "loop")].sort()).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("collectLoopBindingRefs — the main-pass guard's detector", () => {
  it("finds a {{loop.item.*}} reference in an input mapping", () => {
    expect(
      collectLoopBindingRefs({
        verbId: "entity_facet.list",
        inputMapping: { entityId: "{{loop.item.id}}" },
      })
    ).toEqual(["{{loop.item.id}}"]);
  });

  it("finds {{loop.index}} and nested/array values", () => {
    expect(
      collectLoopBindingRefs({
        config: {
          items: ["{{loop.index}}", { deep: "n={{ loop.item.name }}" }],
        },
      })
    ).toEqual(["{{loop.index}}", "n={{ loop.item.name }}"]);
  });

  it("returns nothing for a node with no loop reference", () => {
    expect(
      collectLoopBindingRefs({
        inputMapping: { entityId: "{{steps.query.output.entities}}" },
      })
    ).toEqual([]);
  });

  it("does NOT flag a loop binding used inside an array-pipe argument", () => {
    // `map:`/`filter:` bind `loop` per item inside the RESOLVER — a
    // resolver-local scope that is valid outside any loop node.
    expect(
      collectLoopBindingRefs({
        expression: "{{steps.q.output.rows | map:{{loop.item.id}}}}",
      })
    ).toEqual([]);
  });
});
