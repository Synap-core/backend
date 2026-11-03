/**
 * `synap_list_tracks` with a `trackId` reads ONE goal (ticket 635fbe22).
 *
 * REAL: the handler (`trackHandlers.synap_list_tracks`).
 * STUBBED: the tracks service reads (`getTrack`, `listTracks`,
 * `loadTrackViews`), whose floor is the project's visibility — covered by the
 * service's own tests, not here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getTrack: vi.fn(),
  listTracks: vi.fn(),
  loadTrackViews: vi.fn(),
}));

vi.mock("../../../services/tracks/tracks-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getTrack: h.getTrack,
  listTracks: h.listTracks,
  loadTrackViews: h.loadTrackViews,
}));

import { trackHandlers } from "./track.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";

function call(args: Record<string, unknown>) {
  return trackHandlers.synap_list_tracks!({
    toolName: "synap_list_tracks",
    args,
    userId: "u1",
    apiKeyScopes: ["mcp.read"],
  } as never);
}
const body = async (args: Record<string, unknown>) =>
  JSON.parse(((await call(args)).content[0] as { text: string }).text);

beforeEach(() => {
  h.getTrack.mockReset();
  h.listTracks.mockReset().mockResolvedValue([]);
  h.loadTrackViews
    .mockReset()
    .mockImplementation(async (rows: Array<{ id: string }>) => rows);
});

describe("synap_list_tracks — trackId reads one goal", () => {
  it("returns just that goal, with no projectId, never listing the project", async () => {
    h.getTrack.mockResolvedValue({ id: T1, projectId: P1 });
    const out = await body({ trackId: T1 });
    expect(out.items).toEqual([{ id: T1, projectId: P1 }]);
    expect(h.listTracks).not.toHaveBeenCalled();
  });

  it("answers 'not found' for an unreadable track, a mismatching project, or a malformed id", async () => {
    h.getTrack.mockResolvedValue(null);
    expect((await body({ trackId: T1 })).error).toMatch(/not found/i);
    h.getTrack.mockResolvedValue({ id: T1, projectId: P1 });
    expect((await body({ trackId: T1, projectId: P2 })).error).toMatch(
      /not found/i
    );
    expect((await body({ trackId: "nope" })).error).toMatch(/uuid/);
  });

  it("still lists a project when only projectId is given, and asks for one otherwise", async () => {
    h.listTracks.mockResolvedValue([{ id: T1, projectId: P1 }]);
    expect((await body({ projectId: P1 })).items).toHaveLength(1);
    expect(h.listTracks).toHaveBeenCalledTimes(1);
    expect((await body({})).error).toMatch(/projectId/);
  });
});
