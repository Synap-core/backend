/**
 * Bento / sidebar view-reference resolution in `reconcileWorkspaceFromDefinition`.
 *
 * The defect (live, Ecosystem workspace): the workspace home bento was named
 * "Ecosystem Map" — the same name as the graph view it embeds. The reconcile
 * resolved an overlay `bentoViewBlock` through a `name → id` map where the LAST
 * row won, so the block resolved to the home bento ITSELF and was appended to
 * it: a dashboard embedding itself.
 *
 * Two layers:
 *   1. The SEAM — the real reconcile door, driven with a mocked DB whose views
 *      list places the home bento LAST (exactly the order that made last-wins
 *      pick it), asserting the block written through `ViewRepository.update`.
 *   2. The pure resolver, for the slug / declared-type / ambiguity rules.
 *
 * NOT covered here: the sidebar pass is exercised only through the pure
 * resolver (layer 2) — its write goes through `WorkspaceRepository.mergeSettings`,
 * which this harness does not drive.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type ViewRow = {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  userId: string;
};
let liveViews: ViewRow[] = [];
const viewUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
const viewCreates: Array<Record<string, unknown>> = [];

vi.mock("../client-pg.js", () => {
  const db = {
    query: {
      workspaces: { findFirst: async () => ({ id: "ws-1", settings: {} }) },
      automations: { findFirst: async () => undefined },
      intelligenceCommands: { findMany: async () => [] },
      relationDefs: {
        findMany: async () => [],
        findFirst: async () => undefined,
      },
      views: { findMany: async () => liveViews },
    },
  };
  return { getDb: async () => db, sql: {} };
});

vi.mock("../repositories/view-repository.js", () => ({
  ViewRepository: class {
    async create(input: Record<string, unknown>) {
      viewCreates.push(input);
      return { id: "created-view", ...input };
    }
    async update(id: string, data: Record<string, unknown>) {
      viewUpdates.push({ id, data });
      return { id, ...data };
    }
  },
}));

const { reconcileWorkspaceFromDefinition, resolveDefinitionViewRef } =
  await import("./reconcile-workspace-from-definition.js");

const HOME_ID = "home-bento";
const GRAPH_ID = "graph-view";
const SEGMENTS_ID = "segments-view";

const graph = (id = GRAPH_ID): ViewRow => ({
  id,
  name: "Ecosystem Map",
  type: "graph",
  config: { slug: "ecosystem-map" },
  metadata: null,
  userId: "user-1",
});
const segments: ViewRow = {
  id: SEGMENTS_ID,
  name: "Segments",
  type: "table",
  config: { slug: "segments" },
  metadata: null,
  userId: "user-1",
};
/** The live home bento: SAME name as the graph it embeds. */
const homeBento: ViewRow = {
  id: HOME_ID,
  name: "Ecosystem Map",
  type: "bento",
  config: {
    layout: "bento",
    blocks: [
      {
        id: "view-1",
        kind: "view",
        viewId: SEGMENTS_ID,
        pos: { x: 0, y: 0, w: 4, h: 3 },
      },
    ],
  },
  metadata: { homeScope: "workspace" },
  userId: "user-1",
};

const overlay = {
  bentoViewBlocks: [
    {
      kind: "view" as const,
      viewName: "Ecosystem Map",
      pos: { x: 0, y: 0, w: 8, h: 6 },
    },
  ],
};

async function run(definition: Record<string, unknown>) {
  return reconcileWorkspaceFromDefinition({
    workspaceId: "ws-1",
    userId: "user-1",
    definition,
  });
}

function appendedViewIds(): string[] {
  expect(viewUpdates).toHaveLength(1);
  expect(viewUpdates[0]!.id).toBe(HOME_ID);
  const blocks = (
    viewUpdates[0]!.data.config as { blocks: Array<Record<string, unknown>> }
  ).blocks;
  return blocks.map((b) => b.viewId as string).filter(Boolean);
}

beforeEach(() => {
  liveViews = [];
  viewUpdates.length = 0;
  viewCreates.length = 0;
});

describe("reconcile home bento: view blocks never embed their own bento", () => {
  it("home bento shares the graph's name (and is listed LAST) → the block resolves to the graph", async () => {
    liveViews = [graph(), segments, homeBento];
    const report = await run(overlay);

    const ids = appendedViewIds();
    expect(ids).toEqual([SEGMENTS_ID, GRAPH_ID]);
    expect(ids).not.toContain(HOME_ID);
    expect(report.home.blocksAdded).toEqual(["overlay-view-0-a1"]);
  });

  it("the name belongs to two non-bento views → skipped with no write, never guessed", async () => {
    liveViews = [graph("graph-a"), graph("graph-b"), segments, homeBento];
    const report = await run(overlay);

    expect(viewUpdates).toHaveLength(0);
    expect(report.home.blocksAdded).toEqual([]);
  });
});

describe("resolveDefinitionViewRef", () => {
  const bento = (id: string, name: string): ViewRow => ({
    id,
    name,
    type: "bento",
    config: null,
    metadata: null,
    userId: "u",
  });

  it("never resolves to the excluded (containing) view, even when it is the only name match", () => {
    expect(
      resolveDefinitionViewRef(
        { viewName: "Ecosystem Map" },
        [homeBento],
        [],
        HOME_ID
      )
    ).toEqual({ skip: "unknown", candidateIds: [] });
  });

  it("duplicate name, bento + graph, nothing excluded → prefers the non-bento", () => {
    expect(
      resolveDefinitionViewRef(
        { viewName: "Ecosystem Map" },
        [graph(), homeBento],
        []
      )
    ).toEqual({ viewId: GRAPH_ID });
  });

  it("duplicate name → the definition's declared type wins, even over non-bento preference", () => {
    const table: ViewRow = { ...graph("table-x"), type: "table" };
    expect(
      resolveDefinitionViewRef(
        { viewName: "Ecosystem Map" },
        [graph(), table],
        [{ name: "Ecosystem Map", type: "table" }]
      )
    ).toEqual({ viewId: "table-x" });
  });

  it("two same-named bentos, no declaration → ambiguous with both candidates", () => {
    expect(
      resolveDefinitionViewRef(
        { viewName: "Board" },
        [bento("b1", "Board"), bento("b2", "Board")],
        []
      )
    ).toEqual({ skip: "ambiguous", candidateIds: ["b1", "b2"] });
  });

  it("slug stamped on a live row wins over a same-named row", () => {
    const renamedGraph: ViewRow = { ...graph(), name: "Map (old)" };
    expect(
      resolveDefinitionViewRef(
        { viewName: "Ecosystem Map", viewSlug: "ecosystem-map" },
        [renamedGraph, { ...graph("other"), config: null }],
        []
      )
    ).toEqual({ viewId: GRAPH_ID });
  });

  it("unstamped slug falls through to the name its definition view declares", () => {
    const unstamped: ViewRow = { ...graph(), config: null };
    expect(
      resolveDefinitionViewRef(
        { viewName: "Wrong name", viewSlug: "ecosystem-map" },
        [unstamped],
        [{ name: "Ecosystem Map", slug: "ecosystem-map", type: "graph" }]
      )
    ).toEqual({ viewId: GRAPH_ID });
  });
});
