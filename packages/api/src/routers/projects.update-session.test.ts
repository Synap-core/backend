/**
 * A4-b (29 Oct): `synap_update_project` with an explicit `sessionId` answered
 * `attribution.session: "explicit"`, yet `filedIn` named another session — a
 * teammate's, sharing one Claude Code conversation. `projects.update` never
 * handed `ctx.sessionId` to the governed update, so the gate saw no session
 * and filed the write under the conversation's receipt.
 *
 * Driven through the REAL `projects.update` procedure and the REAL
 * `updateProjectGoverned`; the gate is stubbed to record what it was given
 * and stop. Rows: a named session reaches the gate (rules out the drop); no
 * session leaves the gate to choose (rules out a made-up one).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const gated = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getDb: async () => ({}) };
});
vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));
// `protectedProcedure`'s read-only guard reads `sync_generation` on every
// mutation; stub only that read so the test needs no database.
vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/split-brain-service.js")>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../services/projects/load-visible-project.js", () => ({
  loadVisibleProject: async () => ({ id: PROJECT, workspaceId: null }),
}));
vi.mock("../services/projects/project-home.js", () => ({
  resolveProjectHomeChange: async () => undefined,
  stampProjectHomeUse: async () => undefined,
}));
vi.mock("../utils/permission-check.js", () => ({
  // Stops the door right after the gate: nothing is written.
  checkPermissionOrPropose: async (input: Record<string, unknown>) => {
    gated.push(input);
    return { denied: true, reason: "stopped after the gate" };
  },
}));

const { projectsRouter } = await import("./projects.js");

const caller = (sessionId?: string) =>
  projectsRouter.createCaller({
    authenticated: true,
    userId: "user-1",
    workspaceId: null,
    agentUserId: "agent-1",
    ...(sessionId ? { sessionId } : {}),
  } as never);

beforeEach(() => {
  gated.length = 0;
});

describe("projects.update — the caller's session reaches the gate (A4-b)", () => {
  it("a named session is the one the gate files the write under", async () => {
    await expect(
      caller("S-NAMED").update({ id: PROJECT, name: "Renamed" })
    ).rejects.toThrow("stopped after the gate");
    expect(gated).toHaveLength(1);
    expect(gated[0]).toMatchObject({ sessionId: "S-NAMED" });
  });

  it("no session: the gate is given none and chooses itself", async () => {
    await expect(
      caller().update({ id: PROJECT, name: "Renamed" })
    ).rejects.toThrow("stopped after the gate");
    expect(gated[0]?.sessionId).toBeUndefined();
  });
});
