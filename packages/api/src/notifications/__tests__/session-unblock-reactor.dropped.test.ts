/**
 * The unblock reactor through the REAL dependency rule — the seam
 * `session-unblock-reactor.test.ts` cannot see, because it mocks
 * `openBlockerIds` whole.
 *
 * FOUNDER DECISION 2026-10-22: a blocker that ENDED WITHOUT DELIVERING
 * (cancelled / failed) does not clear. `complete-session.ts` emits the SAME
 * close event for every lifecycle exit, so under the old rule cancelling a
 * blocker announced "<dependent> is unblocked — <blocker> closed, nothing else
 * is blocking it" about work that never happened. The reactor re-derives
 * `openBlockerIds` after the close; the dropped blocker is still in it, so the
 * reactor stays silent. A DELIVERED (closed) blocker still announces.
 *
 * Real: the reactor, `getSessionEdgesFor`, `replacedBlockerDependents`,
 * `openBlockerIds` → `readDependencyState` → `deriveOpenBlockers`. The db is a
 * queue-fed chainable stub (every builder returns one thenable that resolves
 * to the next queued result), so the queue below IS the reactor's read order.
 * Mocked: the derived output-wait half (its own suite) and the notification
 * write (asserted on).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  queue: [] as unknown[][],
  create: vi.fn(async (_input: unknown) => "notif-1"),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const node: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(h.queue.shift() ?? []).then(resolve),
  };
  for (const m of ["select", "from", "where", "limit", "innerJoin"]) {
    node[m] = () => node;
  }
  return { ...actual, db: { select: () => node } };
});

vi.mock("../../services/focus-sessions/session-output-edges.js", () => ({
  outputDependentsOf: async () => [],
  openOutputBlockerIds: async () => [],
}));

vi.mock("../NotificationService.js", () => ({
  NotificationService: { create: h.create },
}));

const { sessionUnblockNotifyReactor } =
  await import("../session-unblock-reactor.js");

const CLOSED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEPENDENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function feed(blockerStatus: string) {
  // getSessionEdgesFor(CLOSED): DEPENDENT --blocked_by--> CLOSED
  h.queue.push([{ fromId: DEPENDENT, toId: CLOSED }]);
  // the closed session's row
  h.queue.push([{ id: CLOSED, title: "Price the plans", userId: "u" }]);
  // replacedBlockerDependents(CLOSED): it replaces nothing
  h.queue.push([]);
  // the dependents' rows
  h.queue.push([
    { id: DEPENDENT, title: "Launch", userId: "u", workspaceId: "ws" },
  ]);
  // openBlockerIds(DEPENDENT): owner; outgoing blocked_by; no replacements;
  // the blocker's visibility; its status.
  h.queue.push([{ userId: "u" }]);
  h.queue.push([
    {
      fromType: "session",
      fromId: DEPENDENT,
      toType: "session",
      toId: CLOSED,
      linkType: "blocked_by",
    },
  ]);
  h.queue.push([]);
  h.queue.push([{ id: CLOSED }]);
  h.queue.push([
    { id: CLOSED, status: blockerStatus, title: "Price the plans" },
  ]);
  // the idempotency lookup (no earlier notification)
  h.queue.push([]);
}

const payload = {
  subjectType: "focus_session",
  action: "closed",
  subjectId: CLOSED,
  userId: "u",
  workspaceId: "ws",
  data: { sessionId: CLOSED },
};

beforeEach(() => {
  h.queue.length = 0;
  h.create.mockClear();
});

describe("session-unblock-notify — a dropped blocker is not an unblocking", () => {
  it.each(["cancelled", "failed"])(
    "stays SILENT when the last blocker ended %s without delivering",
    async (status) => {
      feed(status);
      await sessionUnblockNotifyReactor.handler(payload, {} as never);
      expect(h.create).not.toHaveBeenCalled();
    }
  );

  // Positive control: the same fixture, a DELIVERED blocker — the reactor
  // still announces, so the silence above is the rule, not a broken harness.
  it("still announces when the last blocker CLOSED (delivered)", async () => {
    feed("closed");
    await sessionUnblockNotifyReactor.handler(payload, {} as never);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0]![0]).toMatchObject({
      type: "session.unblocked",
      sourceId: DEPENDENT,
      data: { blockerSessionId: CLOSED, blockerTitle: "Price the plans" },
    });
  });
});
