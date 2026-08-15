import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB client so these run without a live Postgres. `insertResult`
// controls whether the insert "lands" (fresh id) or conflicts
// (`onConflictDoNothing` no-op → empty array), mirroring the real driver's
// two outcomes.
let insertResult: Array<{ id: string }> = [];
let capturedValues: Record<string, unknown> | null = null;

vi.mock("../client-pg.js", () => ({
  getDb: async () => ({
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        capturedValues = v;
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(insertResult),
          }),
        };
      },
    }),
  }),
}));

vi.mock("./mirror-to-external.js", () => ({
  mirrorMessageToBoundExternal: vi
    .fn()
    .mockResolvedValue({ mirrored: false, reason: "no-bound-external" }),
}));

const emitMessageEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./emit-message-event.js", () => ({
  emitMessageEvent: (...args: unknown[]) => emitMessageEventMock(...args),
}));

const { insertChannelMessage } = await import("./insert-channel-message.js");

beforeEach(() => {
  insertResult = [];
  capturedValues = null;
  emitMessageEventMock.mockClear();
});

describe("insertChannelMessage — keystone fact write", () => {
  it("emits message.sent when the insert lands a new row", async () => {
    insertResult = [{ id: "msg-1" }];
    const result = await insertChannelMessage({
      channelId: "ch-1",
      content: "hello",
      userId: "u-1",
    });

    expect(result.messageId).toBe("msg-1");
    expect(emitMessageEventMock).toHaveBeenCalledTimes(1);
    expect(emitMessageEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message.sent",
        userId: "u-1",
        channelId: "ch-1",
        messageId: "msg-1",
        data: expect.objectContaining({
          authorType: capturedValues?.authorType,
          role: capturedValues?.role,
        }),
      })
    );
  });

  it("does NOT emit when the insert conflicts (onConflictDoNothing no-op)", async () => {
    insertResult = []; // conflict: returning() yields nothing
    const result = await insertChannelMessage({
      channelId: "ch-1",
      content: "hello",
      userId: "u-1",
      id: "deterministic-id",
    });

    expect(result.messageId).toBeUndefined();
    expect(result.mirrorReason).toBe("duplicate-insert-skipped");
    expect(emitMessageEventMock).not.toHaveBeenCalled();
  });
});
