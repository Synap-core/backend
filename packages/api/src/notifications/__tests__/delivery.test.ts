/**
 * Notification realtime DELIVERY model.
 *
 * A `notifications` row is private to its `userId` — that is the floor
 * `notifCenter.list` enforces. The realtime path used to bypass that floor: it
 * emitted `notification:new` (carrying the interpolated title AND body) to
 * `workspace:${id}`, a room every member of the workspace is in, and no client
 * anywhere filters by recipient. It also skipped the emit entirely when
 * `workspaceId` was null, so pod-wide governance notifications were silent in
 * realtime and only surfaced on a 15s poll.
 *
 * The fix is one change: emit to `user:${userId}` and pass NO `workspaceId`.
 * These tests assert on the ARGUMENT handed to `emitChatEvent` — room fan-out is
 * the realtime bridge's job and is covered there (`@synap/realtime` bridge
 * emits once per room key PRESENT, which is exactly why passing both keys would
 * double-deliver and re-open the disclosure).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockEmitChatEvent, mockPrefs, mockInsertReturning } = vi.hoisted(
  () => ({
    mockEmitChatEvent: vi.fn(),
    mockPrefs: vi.fn(),
    mockInsertReturning: vi.fn(),
  })
);

vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: mockEmitChatEvent,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: { notificationPreferences: { findFirst: mockPrefs } },
      insert: () => ({
        values: () => ({ returning: mockInsertReturning }),
      }),
    },
    eventRepository: { append: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn().mockResolvedValue(undefined),
}));

import { NotificationService } from "../NotificationService.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    type: "proposal.created",
    userId: USER_A,
    workspaceId: WORKSPACE,
    sourceType: "proposal" as const,
    sourceId: "44444444-4444-4444-8444-444444444444",
    data: { proposalType: "entity.create", description: "Create ACME Corp" },
    ...overrides,
  };
}

/** The single emitChatEvent argument, or a hard failure if it wasn't called once. */
function soleEmitArg(): Record<string, unknown> {
  expect(mockEmitChatEvent).toHaveBeenCalledTimes(1);
  return mockEmitChatEvent.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  mockEmitChatEvent.mockClear();
  // No stored preferences → no kill switch, no routing rule, no quiet hours.
  mockPrefs.mockResolvedValue(undefined);
  mockInsertReturning.mockResolvedValue([{ id: "row-1" }]);
});

describe("NotificationService.create — realtime delivery", () => {
  it("(a) workspace-scoped: emits ONCE to the recipient's user room, with no workspaceId key", async () => {
    await NotificationService.create(baseInput());

    const arg = soleEmitArg();
    expect(arg.userId).toBe(USER_A);
    // Not just "falsy" — the KEY must be absent, because the bridge emits once
    // per key present and would otherwise also hit `workspace:${id}`.
    expect(Object.keys(arg)).not.toContain("workspaceId");
  });

  it("(b) pod-wide (workspaceId: null): emits ONCE (previously ZERO times)", async () => {
    await NotificationService.create(baseInput({ workspaceId: null }));

    const arg = soleEmitArg();
    expect(arg.userId).toBe(USER_A);
    expect(Object.keys(arg)).not.toContain("workspaceId");
  });

  it("(c) ANTI-VACUITY: quiet hours suppress realtime → ZERO emits", async () => {
    // `suppressRealtime` is not an input — it is derived from stored prefs.
    // An all-day quiet-hours window is the deterministic way to set it.
    mockPrefs.mockResolvedValue({
      enabled: true,
      routingRules: {},
      quietHoursEnabled: true,
      quietHoursStart: "00:00",
      quietHoursEnd: "23:59",
    });

    await NotificationService.create(baseInput());

    // Proves the spy can register a NON-call: (a)/(b) are not passing against a
    // dead mock that never receives anything.
    expect(mockEmitChatEvent).not.toHaveBeenCalled();
  });

  it("(c2) ANTI-VACUITY: routing rule 'os' suppresses realtime → ZERO emits", async () => {
    mockPrefs.mockResolvedValue({
      enabled: true,
      routingRules: { governance: "os" },
    });

    await NotificationService.create(baseInput());

    expect(mockEmitChatEvent).not.toHaveBeenCalled();
  });

  it("(d) recipient isolation: nothing in the emit argument targets user B or any workspace room", async () => {
    await NotificationService.create(baseInput({ userId: USER_A }));

    const arg = soleEmitArg();
    expect(arg.userId).toBe(USER_A);

    // Serialize the WHOLE argument: neither the other user's id nor the
    // workspace id may appear anywhere in it (top-level key, nested payload,
    // or otherwise).
    const serialized = JSON.stringify(arg);
    expect(serialized).toContain(USER_A);
    expect(serialized).not.toContain(USER_B);
    expect(serialized).not.toContain(WORKSPACE);
  });
});
