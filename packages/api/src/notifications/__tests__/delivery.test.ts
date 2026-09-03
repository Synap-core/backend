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

const { mockEmitChatEvent, mockPrefs, mockInsertReturning, mockSendExpoPush } =
  vi.hoisted(() => ({
    mockEmitChatEvent: vi.fn(),
    mockPrefs: vi.fn(),
    mockInsertReturning: vi.fn(),
    mockSendExpoPush: vi.fn(),
  }));

vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: mockEmitChatEvent,
}));

vi.mock("../expo-push.js", () => ({ sendExpoPush: mockSendExpoPush }));

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
  mockSendExpoPush.mockClear();
  mockSendExpoPush.mockResolvedValue({ sent: 1, revoked: 0, failed: 0 });
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

/**
 * PUSH is the second channel out of the ONE selection point (`resolveChannels`).
 * The socket tests above prove the `in_app` half; these prove that the `os`
 * half obeys the SAME preferences rather than becoming a louder side door —
 * which is exactly what a transport bolted on beside the selection point would
 * have been.
 */
describe("NotificationService.create — push (`os`) delivery", () => {
  it("(e) a muted category is silent on EVERY channel — no socket, no push", async () => {
    // `proposal.created` is category `governance`, whose defaults are BOTH
    // channels — so a mute that only closed the socket would still push.
    mockPrefs.mockResolvedValue({
      enabled: true,
      routingRules: { governance: "mute" },
    });

    await NotificationService.create(baseInput());

    expect(mockEmitChatEvent).not.toHaveBeenCalled();
    expect(mockSendExpoPush).not.toHaveBeenCalled();
  });

  it("(f) quiet hours suppress PUSH, not just realtime", async () => {
    // The inverse-of-the-setting bug: quiet hours have always meant "persist,
    // don't interrupt". A push channel that read only `defaultChannels` would
    // make the phone the LOUDEST channel at 3am.
    mockPrefs.mockResolvedValue({
      enabled: true,
      routingRules: {},
      quietHoursEnabled: true,
      quietHoursStart: "00:00",
      quietHoursEnd: "23:59",
    });

    await NotificationService.create(baseInput());

    expect(mockSendExpoPush).not.toHaveBeenCalled();
    expect(mockEmitChatEvent).not.toHaveBeenCalled();
  });

  it("(g) defaults ['in_app','os'] deliver EXACTLY ONE of each — never two of either", async () => {
    // There is no insert-level dedupe (`create` does a bare insert, the indexes
    // are non-unique, `groupKey` is display-only), so a second emitter beside
    // the selection point would double-deliver invisibly. Asserting the exact
    // call COUNT on both channels is what makes that regression fail here.
    await NotificationService.create(baseInput());

    expect(mockEmitChatEvent).toHaveBeenCalledTimes(1);
    expect(mockSendExpoPush).toHaveBeenCalledTimes(1);

    const push = mockSendExpoPush.mock.calls[0]![0] as Record<string, unknown>;
    expect(push.userId).toBe(USER_A);
    // The push carries the deep-link payload the device needs to open the row.
    expect((push.data as Record<string, unknown>).notificationId).toBe("row-1");
  });

  it("(h) routing rule 'os' pushes and does NOT emit; 'in_app' emits and does NOT push", async () => {
    mockPrefs.mockResolvedValue({
      enabled: true,
      routingRules: { governance: "os" },
    });
    await NotificationService.create(baseInput());
    expect(mockEmitChatEvent).not.toHaveBeenCalled();
    expect(mockSendExpoPush).toHaveBeenCalledTimes(1);

    mockEmitChatEvent.mockClear();
    mockSendExpoPush.mockClear();

    mockPrefs.mockResolvedValue({
      enabled: true,
      routingRules: { governance: "in_app" },
    });
    await NotificationService.create(baseInput());
    expect(mockEmitChatEvent).toHaveBeenCalledTimes(1);
    expect(mockSendExpoPush).not.toHaveBeenCalled();
  });
});
