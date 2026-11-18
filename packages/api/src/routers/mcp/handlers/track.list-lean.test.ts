/**
 * `synap_list_tracks` lists LEAN rows by default and finds a goal by `name`
 * (tickets c3d00d79, 9753144a: one default page of a busy project was ~80k
 * chars, cut by the reply cap before the goal a routine looked for).
 *
 * REAL: the handler. STUBBED: the tracks service reads (`listTracks`,
 * `loadTrackViews`), whose floor is covered by the service's own tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  listTracks: vi.fn(),
  loadTrackViews: vi.fn(),
}));

vi.mock("../../../services/tracks/tracks-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listTracks: h.listTracks,
  loadTrackViews: h.loadTrackViews,
}));

import { trackHandlers } from "./track.js";

const P1 = "22222222-2222-4222-8222-222222222222";

/** A full view, as `loadTrackViews` returns it (the heavy fields included). */
function view(id: string, name: string) {
  return {
    id,
    projectId: P1,
    name,
    status: "active",
    pausedBy: null,
    verdict: null,
    direction: "Keep it true",
    kpi: null,
    updatedAt: "2026-11-17T00:00:00.000Z",
    criteria: [{ key: "c1", statement: "x".repeat(2000) }],
    stages: [],
    stageHistory: [],
    participants: [],
    loop: { enabled: false },
  };
}

const ROWS = [
  { id: "t1", name: "Grow the newsletter" },
  { id: "t2", name: "Promise Keeper — core promises hold" },
  { id: "t3", name: "Win the first ten clients" },
];

async function body(args: Record<string, unknown>) {
  const res = await trackHandlers.synap_list_tracks!({
    toolName: "synap_list_tracks",
    args: { projectId: P1, ...args },
    userId: "u1",
    apiKeyScopes: ["mcp.read"],
  } as never);
  return JSON.parse((res.content[0] as { text: string }).text);
}

beforeEach(() => {
  h.listTracks.mockReset().mockResolvedValue(ROWS);
  h.loadTrackViews
    .mockReset()
    .mockImplementation(async (rows: Array<{ id: string; name: string }>) =>
      rows.map((r) => view(r.id, r.name))
    );
});

describe("synap_list_tracks — lean rows by default", () => {
  it("lists id, name, status, pausedBy, verdict, direction, kpi, updatedAt and nothing heavy", async () => {
    const out = await body({});
    expect(out.items).toHaveLength(3);
    expect(Object.keys(out.items[0]).sort()).toEqual(
      [
        "direction",
        "id",
        "kpi",
        "name",
        "pausedBy",
        "status",
        "updatedAt",
        "verdict",
      ].sort()
    );
    expect(JSON.stringify(out).length).toBeLessThan(1500);
  });

  it("detail:'full' returns the whole view; an unknown detail is refused", async () => {
    const out = await body({ detail: "full" });
    expect(out.items[0].criteria).toHaveLength(1);
    expect((await body({ detail: "huge" })).error).toMatch(
      /Valid values: lean \(default\), full/
    );
  });

  it("9753144a: `name` finds the goal before the page is cut (any case)", async () => {
    const out = await body({ name: "promise keeper", limit: 1 });
    expect(out.items.map((t: { id: string }) => t.id)).toEqual(["t2"]);
    expect(out.total).toBe(1);
    // Only the matching row is read in full.
    expect(h.loadTrackViews).toHaveBeenCalledWith([ROWS[1]], expect.anything());
  });
});
