/**
 * A proposed bento's review entry names the cells it places, in block order,
 * under `cells` (founder, 23 Nov 2026: the word is Cell). `widgets` is the old
 * name of the same value, kept one release for readers that still read it.
 * Driven through the real projection (`buildProposalGraph`).
 */

import { describe, expect, it } from "vitest";
import type { CompositeProposalData } from "@synap-core/types/proposals";
import { buildProposalGraph } from "./display.js";

const bento = (blocks: unknown[]): CompositeProposalData => ({
  operations: [
    {
      op: "create_view",
      ref: "v1",
      name: "Pipeline health",
      viewType: "bento",
      config: { blocks },
    } as CompositeProposalData["operations"][number],
  ],
});

describe("buildProposalGraph — a bento's cells", () => {
  it("lists each placed cell key under `cells`, and under the old `widgets`", () => {
    const graph = buildProposalGraph(
      bento([
        { id: "a", kind: "widget", widgetType: "stat-card" },
        { id: "b", kind: "view", viewId: "x" },
        { id: "c", kind: "widget", widgetType: "chart-bar" },
      ])
    );
    const view = graph.views?.[0];
    expect(view?.cells).toEqual(["stat-card", "chart-bar"]);
    expect(view?.widgets).toEqual(view?.cells);
  });

  it("a list view carries neither", () => {
    const graph = buildProposalGraph({
      operations: [
        {
          op: "create_view",
          ref: "v1",
          name: "Deals",
          viewType: "list",
        } as CompositeProposalData["operations"][number],
      ],
    });
    expect(graph.views?.[0]).not.toHaveProperty("cells");
    expect(graph.views?.[0]).not.toHaveProperty("widgets");
  });
});
