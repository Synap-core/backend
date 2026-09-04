/**
 * The unblock rule: a session waiting on THREE blockers is not unblocked when
 * the first closes. `session.unblocked` fires exactly once, when the set of
 * blockers still OPEN becomes empty — which is why the reactor re-derives
 * `openBlockerIds` after the close instead of reacting to the close alone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSessionEdgesForMock, openBlockerIdsMock, createMock, queue } =
  vi.hoisted(() => ({
    getSessionEdgesForMock: vi.fn(async (_id: string) => ({
      blockedBy: [] as string[],
      unblocks: [] as string[],
    })),
    openBlockerIdsMock: vi.fn(async (_id: string) => [] as string[]),
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
    queue.push([{ id: CLOSED, title: "the blocker" }]); // closed session row
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
    queue.push([{ id: CLOSED, title: "the blocker" }]);
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

  it("is idempotent — a replayed close event does not notify twice", async () => {
    getSessionEdgesForMock.mockResolvedValueOnce({
      blockedBy: [],
      unblocks: [DEPENDENT],
    });
    queue.push([{ id: CLOSED, title: "the blocker" }]);
    queue.push([
      { id: DEPENDENT, title: "waiting work", userId: "u", workspaceId: "ws" },
    ]);
    openBlockerIdsMock.mockResolvedValueOnce([]);
    queue.push([{ id: "already-told" }]); // durable row from the first delivery
    await sessionUnblockNotifyReactor.handler(payload(), {} as never);
    expect(createMock).not.toHaveBeenCalled();
  });
});
