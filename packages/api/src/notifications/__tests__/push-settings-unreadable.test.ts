/**
 * When the person's push settings CANNOT BE READ, a blocking ask still pushes
 * on its category default (an agent is stopped until they answer); every
 * other category is skipped. Logged either way; the bell row is written in
 * both cases.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockPrefs, mockInsertReturning, mockSendExpoPush, readPod } =
  vi.hoisted(() => ({
    mockPrefs: vi.fn(),
    mockInsertReturning: vi.fn(),
    mockSendExpoPush: vi.fn(),
    readPod: vi.fn(),
  }));

vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: vi.fn(),
}));
vi.mock("../expo-push.js", () => ({ sendExpoPush: mockSendExpoPush }));
vi.mock("../push-prefs.js", () => ({
  readPodPushSettings: readPod,
  readPushPrefs: vi.fn(),
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: { notificationPreferences: { findFirst: mockPrefs } },
      insert: () => ({ values: () => ({ returning: mockInsertReturning }) }),
      select: () => {
        const node: Record<string, unknown> = {
          then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r),
        };
        for (const m of ["from", "where", "limit"]) node[m] = () => node;
        return node;
      },
    },
    eventRepository: { append: vi.fn().mockResolvedValue(undefined) },
  };
});
vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn().mockResolvedValue(undefined),
}));

import { NotificationService } from "../NotificationService.js";

const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrefs.mockResolvedValue(undefined);
  mockInsertReturning.mockResolvedValue([{ id: "row-1" }]);
  mockSendExpoPush.mockResolvedValue({ sent: 1, revoked: 0, failed: 0 });
  readPod.mockRejectedValue(new Error("connection reset"));
});

describe("push settings unreadable", () => {
  it("a BLOCKING ASK still pushes on its category default", async () => {
    const id = await NotificationService.create({
      type: "session.needs_you",
      userId: USER,
      workspaceId: null,
      sourceType: "session",
      sourceId: SESSION,
      data: { sessionId: SESSION, sessionTitle: "Ship", summary: "Tone" },
    });
    expect(id).toBe("row-1");
    expect(mockSendExpoPush).toHaveBeenCalledTimes(1);
    expect(mockSendExpoPush.mock.calls[0]![0]).toMatchObject({
      interruptionLevel: "time-sensitive",
      data: { pushCategory: "blocking-ask" },
    });
  });

  it("any other category is skipped — the row is still written", async () => {
    const id = await NotificationService.create({
      type: "proposal.created",
      userId: USER,
      workspaceId: null,
      sourceType: "proposal",
      sourceId: "44444444-4444-4444-8444-444444444444",
      data: { proposalType: "entity.create", description: "x" },
      push: { facts: { proposalBlocksOpenSession: true } },
    });
    expect(id).toBe("row-1");
    expect(mockSendExpoPush).not.toHaveBeenCalled();
  });

  it("non-vacuity: when the settings read WORKS, the proposal pushes", async () => {
    readPod.mockResolvedValue({ prefs: {}, routingRules: {} });
    await NotificationService.create({
      type: "proposal.created",
      userId: USER,
      workspaceId: null,
      sourceType: "proposal",
      sourceId: "44444444-4444-4444-8444-444444444444",
      data: { proposalType: "entity.create", description: "x" },
      push: { facts: { proposalBlocksOpenSession: true } },
    });
    expect(mockSendExpoPush).toHaveBeenCalledTimes(1);
  });
});
