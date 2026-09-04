/**
 * The unblock rule: a session waiting on THREE blockers is not unblocked when
 * the first closes. `session.unblocked` fires exactly once, when the set of
 * blockers still OPEN becomes empty — which is why the reactor re-derives
 * `openBlockerIds` after the close instead of reacting to the close alone.
 *
 * The rule spans BOTH kinds of wait — the DECLARED `blocked_by` edge and the
 * DERIVED "waits on an output of" (targets ∩ produced). One notification, one
 * last-blocker test across the union.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getSessionEdgesForMock,
  openBlockerIdsMock,
  outputDependentsOfMock,
  openOutputBlockerIdsMock,
  createMock,
  queue,
} = vi.hoisted(() => ({
  getSessionEdgesForMock: vi.fn(async (_id: string) => ({
    blockedBy: [] as string[],
    unblocks: [] as string[],
  })),
  openBlockerIdsMock: vi.fn(async (_id: string) => [] as string[]),
  outputDependentsOfMock: vi.fn(
    async (_id: string, _userId: string) =>
      [] as Array<{ entityId: string; dependentSessionId: string }>
  ),
  openOutputBlockerIdsMock: vi.fn(
    async (_id: string, _userId: string) => [] as string[]
  ),
  createMock: vi.fn(async (_input: unknown) => "notif-1"),
  queue: [] as unknown[][],
}));

// PARTIAL mock: only `db` is replaced — see the total-mock ratchet tripwire.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const node: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(resolve),
  };
  for (const m of ["select", "from", "where", "limit"]) node[m] = () => node;
  return { ...actual, db: { select: () => node } };
});

vi.mock("../../services/focus-sessions/session-blocked-by.js", () => ({
  getSessionEdgesFor: getSessionEdgesForMock,
  openBlockerIds: openBlockerIdsMock,
}));

vi.mock("../../services/focus-sessions/session-output-edges.js", () => ({
  outputDependentsOf: outputDependentsOfMock,
  openOutputBlockerIds: openOutputBlockerIdsMock,
}));

vi.mock("../NotificationService.js", () => ({
  NotificationService: { create: createMock },
}));

const { sessionUnblockNotifyReactor } =
  await import("../session-unblock-reactor.js");

const CLOSED = "closed-session";
const DEPENDENT = "dependent-session";

function payload() {
  return {
    subjectType: "focus_session",
    action: "closed",
    subjectId: CLOSED,
    userId: "u",
    workspaceId: "ws",
    data: { sessionId: CLOSED },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queue.length = 0;
});

describe("session-unblock-notify reactor", () => {
  it("matches only the focus-session close event", () => {
    expect(sessionUnblockNotifyReactor.match!(payload())).toBe(true);
    expect(
      sessionUnblockNotifyReactor.match!({
        ...payload(),
        action: "stage_changed",
      })
    ).toBe(false);
    expect(
      sessionUnblockNotifyReactor.match!({
        ...payload(),
        subjectType: "proposal",
      })
    ).toBe(false);
  });

  it("stays silent when nothing was waiting on the closed session", async () => {
    getSessionEdgesForMock.mockResolvedValueOnce({
      blockedBy: [],
      unblocks: [],
    });
    await sessionUnblockNotifyReactor.handler(payload(), {} as never);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("stays silent while ANOTHER blocker is still open", async () => {
    getSessionEdgesForMock.mockResolvedValueOnce({
      blockedBy: [],
      unblocks: [DEPENDENT],
    });
    queue.push([{ id: CLOSED, title: "the blocker", userId: "u" }]); // closed session row
    queue.push([
      { id: DEPENDENT, title: "waiting work", userId: "u", workspaceId: "ws" },
    ]);
    openBlockerIdsMock.mockResolvedValueOnce(["some-other-blocker"]);
    await sessionUnblockNotifyReactor.handler(payload(), {} as never);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("notifies once when the LAST open blocker closes", async () => {
    getSessionEdgesForMock.mockResolvedValueOnce({
      blockedBy: [],
      unblocks: [DEPENDENT],
    });
    queue.push([{ id: CLOSED, title: "the blocker", userId: "u" }]);
    queue.push([
      { id: DEPENDENT, title: "waiting work", userId: "u", workspaceId: "ws" },
    ]);
    openBlockerIdsMock.mockResolvedValueOnce([]);
    queue.push([]); // no existing notification for this (dependent, blocker)
    await sessionUnblockNotifyReactor.handler(payload(), {} as never);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]![0]).toMatchObject({
      type: "session.unblocked",
      userId: "u",
      workspaceId: "ws",
      sourceType: "system",
      sourceId: DEPENDENT,
      groupKey: `session.unblocked:${DEPENDENT}:${CLOSED}`,
    });
  });

  it("notifies a dependent that was waiting only on an OUTPUT of the closed session", async () => {
    // No declared blocker at all — the wait is entirely derived.
    getSessionEdgesForMock.mockResolvedValueOnce({
      blockedBy: [],
      unblocks: [],
    });
    queue.push([{ id: CLOSED, title: "the blocker", userId: "u" }]);
    outputDependentsOfMock.mockResolvedValueOnce([
      { entityId: "entity-x", dependentSessionId: DEPENDENT },
    ]);
    queue.push([
      { id: DEPENDENT, title: "waiting work", userId: "u", workspaceId: "ws" },
    ]);
    openBlockerIdsMock.mockResolvedValueOnce([]);
    openOutputBlockerIdsMock.mockResolvedValueOnce([]);
    queue.push([]);
    await sessionUnblockNotifyReactor.handler(payload(), {} as never);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]![0]).toMatchObject({
      groupKey: `session.unblocked:${DEPENDENT}:${CLOSED}`,
    });
  });

  it("stays silent while the dependent still waits on ANOTHER session's output", async () => {
    // The declared side is clear; the derived side is not. One rule, both kinds.
    getSessionEdgesForMock.mockResolvedValueOnce({
      blockedBy: [],
      unblocks: [DEPENDENT],
    });
    queue.push([{ id: CLOSED, title: "the blocker", userId: "u" }]);
    queue.push([
      { id: DEPENDENT, title: "waiting work", userId: "u", workspaceId: "ws" },
    ]);
    openBlockerIdsMock.mockResolvedValueOnce([]);
    openOutputBlockerIdsMock.mockResolvedValueOnce(["other-open-producer"]);
    await sessionUnblockNotifyReactor.handler(payload(), {} as never);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("sends ONE notification when a dependent waits both ways on the same session", async () => {
    getSessionEdgesForMock.mockResolvedValueOnce({
      blockedBy: [],
      unblocks: [DEPENDENT],
    });
    queue.push([{ id: CLOSED, title: "the blocker", userId: "u" }]);
    outputDependentsOfMock.mockResolvedValueOnce([
      { entityId: "entity-x", dependentSessionId: DEPENDENT },
    ]);
    queue.push([
      { id: DEPENDENT, title: "waiting work", userId: "u", workspaceId: "ws" },
    ]);
    openBlockerIdsMock.mockResolvedValueOnce([]);
    openOutputBlockerIdsMock.mockResolvedValueOnce([]);
    queue.push([]);
    await sessionUnblockNotifyReactor.handler(payload(), {} as never);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a replayed close event does not notify twice", async () => {
    getSessionEdgesForMock.mockResolvedValueOnce({
      blockedBy: [],
      unblocks: [DEPENDENT],
    });
    queue.push([{ id: CLOSED, title: "the blocker", userId: "u" }]);
    queue.push([
      { id: DEPENDENT, title: "waiting work", userId: "u", workspaceId: "ws" },
    ]);
    openBlockerIdsMock.mockResolvedValueOnce([]);
    queue.push([{ id: "already-told" }]); // durable row from the first delivery
    await sessionUnblockNotifyReactor.handler(payload(), {} as never);
    expect(createMock).not.toHaveBeenCalled();
  });
});
