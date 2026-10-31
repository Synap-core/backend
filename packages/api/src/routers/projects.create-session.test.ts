/**
 * `projects.create` hands the caller's session to the gate (30 Oct live test,
 * item 4) — the create twin of A4-b (`projects.update-session.test.ts`).
 *
 * `projects.create` never handed `ctx.sessionId` to `createProjectGoverned`,
 * so an agent naming its session got the proposal filed under the
 * conversation's receipt — a teammate's session when agents share one.
 *
 * Driven through the REAL `projects.create` procedure and the REAL
 * `createProjectGoverned`; the duplicate door and evidence gravity are
 * stubbed to pass, and the gate records what it was given and stops. Rows: a
 * named session reaches the gate (rules out the drop); no session leaves the
 * gate to choose (rules out a made-up one).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const gated = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => ({}),
    assessEvidenceGravity: () => ({ ok: true }),
  };
});
vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));
// `protectedProcedure`'s read-only guard reads `sync_generation` on every
// mutation; stub only that read so the test needs no database.
vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/split-brain-service.js")>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../services/duplicates/find-duplicate-candidates.js", () => ({
  findDuplicateCandidates: async () => ({
    check: { status: "clear", candidates: [] },
  }),
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

describe("projects.create — the caller's session reaches the gate", () => {
  it("a named session is the one the gate files the write under", async () => {
    await expect(
      caller("S-NAMED").create({ name: "Acme onboarding" })
    ).rejects.toThrow("stopped after the gate");
    expect(gated).toHaveLength(1);
    expect(gated[0]).toMatchObject({
      action: "create",
      subjectType: "project",
      sessionId: "S-NAMED",
    });
  });

  it("no session: the gate is given none and chooses itself", async () => {
    await expect(caller().create({ name: "Acme onboarding" })).rejects.toThrow(
      "stopped after the gate"
    );
    expect(gated).toHaveLength(1);
    expect(gated[0]?.sessionId).toBeUndefined();
  });
});
