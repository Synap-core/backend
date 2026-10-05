/**
 * The far end's STATE on the graph wire — `status` (raw) + `updatedAt` on every
 * neighbour, driven through the REAL `getObjectGraph` envelope (the seam), so
 * dropping either half of the hydration goes red here:
 *   - the `hydrateNodes` half (rows the folds already hydrate, e.g. a track's
 *     sessions, read off the row the floor admitted);
 *   - the `withNodeState` fill pass (neighbours a fold builds WITHOUT
 *     hydration — the entity-data half injected by the router).
 * A row the per-kind floor refuses keeps `status: null` — no mark, no guess.
 * The SQL floor itself is pinned by `hydration-floor-owner-private.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  queues: new Map<unknown, Record<string, unknown>[][]>(),
}));

vi.mock("../links/links-service.js", () => ({
  getLinksFor: vi.fn(async () => []),
}));
vi.mock("../../utils/workspace-membership.js", () => ({
  resolveFacetVisibilityScope: vi.fn(async () => ({})),
}));
// Naming a proposal runs it through the session-redaction read; identity here.
vi.mock("../proposals/session-content-redaction.js", () => ({
  redactUnreadableSessionTargets: vi.fn(async (rows: unknown[]) => rows),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = (rows: Record<string, unknown>[]) => {
    const self: Record<string, unknown> = {
      where: () => self,
      limit: () => self,
      orderBy: () => self,
      then: (
        resolve: (v: Record<string, unknown>[]) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return self;
  };
  const fakeDb = {
    select: () => ({
      from: (table: unknown) => chain(h.queues.get(table)?.shift() ?? []),
    }),
  };
  return {
    ...actual,
    getDb: async () => fakeDb,
    loadFacetSlugsBatch: vi.fn(async () => new Map()),
  };
});

import * as schema from "@synap/database";
import { getObjectGraph } from "./graph-service.js";
import type { GraphNeighbor } from "./graph-service.js";

const USER = "user-owner";
const TRACK = "11111111-1111-4111-8111-111111111111";
const S1 = "44444444-4444-4444-8444-444444444444";
const TASK = "77777777-7777-4777-8777-777777777777";
const HIDDEN = "99999999-9999-4999-8999-999999999999";
const T0 = new Date("2026-10-05T09:30:00.000Z");

function queue(table: unknown, ...reads: Record<string, unknown>[][]) {
  h.queues.set(table, reads);
}

beforeEach(() => {
  h.queues = new Map();
});

function relationNeighbor(id: string): GraphNeighbor {
  return {
    kind: "entity",
    id,
    name: "A task",
    subtype: "task",
    subtypes: ["task"],
    workspaceId: null,
    edgeType: "relates_to",
    direction: "outgoing",
    via: "relations",
  };
}

describe("getObjectGraph — neighbour state", () => {
  it("a hydrated neighbour carries its raw status + updatedAt (and so does the focus)", async () => {
    queue(
      schema.projectTracks,
      [{ id: TRACK, name: "Partnerships", status: "paused", updatedAt: T0 }],
      [{ projectId: null, playbookId: null }]
    );
    queue(
      schema.focusSessions,
      [{ id: S1 }],
      [{ id: S1, goal: "Email Théo", status: "closed", updatedAt: T0 }]
    );
    const env = await getObjectGraph(USER, "track", TRACK);
    expect(env.object).toMatchObject({
      status: "paused",
      updatedAt: T0.toISOString(),
    });
    const s1 = env.neighbors.find((n) => n.id === S1);
    expect(s1).toMatchObject({ status: "closed", updatedAt: T0.toISOString() });
  });

  it("fills state on an injected (un-hydrated) neighbour through the floored hydration", async () => {
    queue(
      schema.projectTracks,
      [{ id: TRACK, name: "Partnerships", status: "active" }],
      [{ projectId: null, playbookId: null }]
    );
    // The fill pass's floored read of `entities`: TASK is visible, HIDDEN is
    // refused by the floor (absent from the result).
    queue(schema.entities, [
      {
        id: TASK,
        title: "A task",
        type: "task",
        properties: { status: "Done", other: 1 },
        updatedAt: T0,
      },
    ]);
    const env = await getObjectGraph(USER, "track", TRACK, [
      relationNeighbor(TASK),
      relationNeighbor(HIDDEN),
    ]);
    const task = env.neighbors.find((n) => n.id === TASK);
    const hidden = env.neighbors.find((n) => n.id === HIDDEN);
    // The status PROPERTY, raw — mapping is the surface's job.
    expect(task).toMatchObject({ status: "Done", updatedAt: T0.toISOString() });
    // Refused by the floor: listed (its edge was visible), but no state.
    expect(hidden).toMatchObject({ status: null, updatedAt: null });
  });

  it("an entity status that is not a string is no status", async () => {
    queue(
      schema.projectTracks,
      [{ id: TRACK, name: "P", status: "active" }],
      [{ projectId: null, playbookId: null }]
    );
    queue(schema.entities, [
      {
        id: TASK,
        title: "A task",
        type: "task",
        properties: { status: { v: 1 } },
      },
    ]);
    const env = await getObjectGraph(USER, "track", TRACK, [
      relationNeighbor(TASK),
    ]);
    expect(env.neighbors.find((n) => n.id === TASK)).toMatchObject({
      status: null,
      updatedAt: null,
    });
  });
});
