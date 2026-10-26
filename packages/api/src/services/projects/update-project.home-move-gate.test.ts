/**
 * Ticket 86b6faae — an agent could not move a project out of an archived
 * space: the gate ran on the project's CURRENT (archived) space, found the
 * agent no member there and filed a join to it. A home move is a write INTO
 * the destination, so it is gated there; any other update keeps the project's
 * own space.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEST = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const gated = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getDb: async () => ({}) };
});
vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));
vi.mock("./load-visible-project.js", () => ({
  loadVisibleProject: async () => ({ id: PROJECT, workspaceId: SOURCE }),
}));
vi.mock("./project-home.js", () => ({
  // The destination check (live + writable) is its own door's test.
  resolveProjectHomeChange: async (
    _db: unknown,
    _user: string,
    current: string | null,
    requested: string | undefined
  ) => (requested === current ? undefined : requested),
  stampProjectHomeUse: async () => undefined,
}));
vi.mock("../../utils/permission-check.js", () => ({
  // Stops the door right after the gate: nothing is written.
  checkPermissionOrPropose: async (input: Record<string, unknown>) => {
    gated.push(input);
    return { denied: true, reason: "stopped after the gate" };
  },
}));

import { updateProjectGoverned } from "./update-project.js";

beforeEach(() => {
  gated.length = 0;
});

describe("updateProjectGoverned — a home move is gated on the destination (86b6faae)", () => {
  it("THE LIVE CASE: moving out of the current space gates on where it lands", async () => {
    await expect(
      updateProjectGoverned({
        id: PROJECT,
        userId: "user-1",
        agentUserId: "agent-1",
        homeWorkspaceId: DEST,
      })
    ).rejects.toThrow("stopped after the gate");
    expect(gated).toHaveLength(1);
    expect(gated[0]).toMatchObject({
      workspaceId: DEST,
      data: { id: PROJECT, homeWorkspaceId: DEST },
    });
  });

  it("an update that does not move stays gated on the project's own space", async () => {
    await expect(
      updateProjectGoverned({
        id: PROJECT,
        userId: "user-1",
        agentUserId: "agent-1",
        name: "Renamed",
      })
    ).rejects.toThrow("stopped after the gate");
    expect(gated[0]).toMatchObject({ workspaceId: SOURCE });
  });
});
