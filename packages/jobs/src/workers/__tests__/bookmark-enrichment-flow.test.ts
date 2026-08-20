/**
 * Behavioural test for the bundled `bookmark-enrichment` automation.
 *
 * The template lives in synap-cli as DATA and nothing typechecks it. Its shape
 * is pinned there; what is NOT pinned anywhere is what the flow actually DOES
 * on a real bookmark — which branch is taken, and therefore which of the two
 * writes lands. That question previously had exactly one answer path: run it on
 * a live pod and eyeball the entity.
 *
 * This closes that loop WITHOUT a pod by driving the template through the
 * executor's OWN primitives — the real `evaluateCondition` and the real
 * `markDescendantsSkipped`/`topoSort`, not reimplementations — and asserting
 * which output nodes survive pruning. The condition/prune semantics mirror
 * `automation-executor.ts` case "condition":
 *
 *     const result = evaluateCondition(expr, context)
 *     const untakenHandle = result ? "no" : "yes"
 *     → prune those edges, then markDescendantsSkipped on their targets
 *
 * If that block in the executor changes, this test's simulation must change
 * with it — it is deliberately a mirror, and the mirror is asserted below.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AutomationNode, AutomationEdge } from "@synap/database";
import { evaluateCondition } from "../condition-eval.js";
import { topoSort, markDescendantsSkipped } from "../graph-topology.js";
import type { StepContext } from "../automation-executor-types.js";

// synap-cli sits beside synap-backend in the monorepo.
const TEMPLATE = join(
  import.meta.dirname,
  "../../../../../../synap-cli/templates/automations/bookmark-enrichment.automation.json"
);
const EXECUTOR = join(import.meta.dirname, "../automation-executor.ts");

const available = existsSync(TEMPLATE);

type Flow = { nodes: AutomationNode[]; edges: AutomationEdge[] };

/** The bookmark as `entity_read` would return it. */
function contextFor(title: string, url: string, sharedBy: string): StepContext {
  return {
    trigger: { payload: { subjectId: "bm-1" } },
    steps: {
      read: {
        output: {
          entity: { title, preview: "", properties: { url, sharedBy } },
        },
      },
      "graph-context": { output: { entities: [] } },
      "channel-talk": { output: { messages: [] } },
      // No person matched — keeps the sharer branch deterministic and OFF, so
      // these assertions isolate the TITLE branch under test.
      "sharer-lookup": { output: { entities: [] } },
      classify: {
        output: {
          title: "Model Context Protocol",
          description: "d",
          category: "docs",
        },
      },
    },
  } as unknown as StepContext;
}

/**
 * Replays the executor's condition/prune loop over the flow and returns the
 * node ids that are still live at the end.
 */
function liveNodes(flow: Flow, context: StepContext): Set<string> {
  const skipped = new Set<string>();
  const pruned = new Set<AutomationEdge>();
  for (const node of topoSort(flow.nodes, flow.edges)) {
    if (skipped.has(node.id)) continue;
    if (node.type !== "condition") continue;
    const { expression } = node.data as unknown as { expression: string };
    const result = evaluateCondition(expression, context);
    const untakenHandle = result ? "no" : "yes";
    const untaken = flow.edges.filter(
      (e) => e.source === node.id && e.sourceHandle === untakenHandle
    );
    for (const edge of untaken) pruned.add(edge);
    for (const edge of untaken)
      markDescendantsSkipped(edge.target, flow.edges, skipped, pruned);
  }
  return new Set(flow.nodes.map((n) => n.id).filter((id) => !skipped.has(id)));
}

describe("bookmark-enrichment flow — which write lands", () => {
  it("can see the template it exercises", () => {
    expect(
      available,
      `Cannot find ${TEMPLATE}. This test proves the enrichment template's ` +
        `branching against the real executor primitives; it needs synap-cli ` +
        `checked out beside synap-backend. Do not delete or skip it.`
    ).toBe(true);
  });

  if (!available) return;

  const flow = (
    JSON.parse(readFileSync(TEMPLATE, "utf8")) as { flowDefinition: Flow }
  ).flowDefinition;
  const URL = "https://modelcontextprotocol.io/introduction";

  it("is non-vacuous: the flow has both writes and both title conditions", () => {
    const ids = new Set(flow.nodes.map((n) => n.id));
    for (const id of [
      "apply-enrich",
      "apply-title",
      "title-present",
      "title-not-url",
    ])
      expect(ids, `missing ${id}`).toContain(id);
  });

  // The founder's decision: description + category on EVERY bookmark.
  it.each([
    ["a good captured title", "Model Context Protocol"],
    ["no title at all", ""],
    ["a title that is just the raw URL", URL],
  ])(
    "writes description + category when the bookmark has %s",
    (_label, title) => {
      const live = liveNodes(flow, contextFor(title, URL, ""));
      expect(
        live.has("apply-enrich"),
        "description + category must be written regardless of the title"
      ).toBe(true);
    }
  );

  it("a GOOD captured title is never overwritten", () => {
    const live = liveNodes(flow, contextFor("Model Context Protocol", URL, ""));
    expect(
      live.has("apply-title"),
      "the AI title must NOT reach the write"
    ).toBe(false);
    expect(live.has("usable-title")).toBe(false);
  });

  it("an EMPTY title reaches the title write", () => {
    const live = liveNodes(flow, contextFor("", URL, ""));
    expect(live.has("usable-title"), "the guard must be reached").toBe(true);
    expect(live.has("apply-title")).toBe(true);
  });

  it("a title that is just the raw URL reaches the title write", () => {
    const live = liveNodes(flow, contextFor(URL, URL, ""));
    expect(live.has("usable-title")).toBe(true);
    expect(live.has("apply-title")).toBe(true);
  });

  // The simulation above is a MIRROR of the executor's condition block. If that
  // block changes shape, the mirror is silently wrong and every assertion above
  // becomes a statement about code that no longer runs.
  it("the executor still prunes conditions the way this test simulates", () => {
    const src = readFileSync(EXECUTOR, "utf8");
    expect(
      src.includes('const untakenHandle = result ? "no" : "yes"'),
      "automation-executor.ts no longer derives the untaken handle this way — " +
        "re-check liveNodes() in this file before trusting its assertions"
    ).toBe(true);
    expect(src.includes("markDescendantsSkipped(")).toBe(true);
  });
});
