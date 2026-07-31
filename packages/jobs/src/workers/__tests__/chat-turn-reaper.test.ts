import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
  and: vi.fn((...args: unknown[]) => ({ kind: "and", args })),
  eq: vi.fn((col: unknown, val: unknown) => ({ kind: "eq", col, val })),
  drizzleSql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    kind: "sql",
    strings: Array.from(strings),
    values,
  })),
}));

vi.mock("@synap/database", () => ({
  db: { update: mocks.update },
  chatTurns: {
    id: "chat_turns.id",
    status: "chat_turns.status",
    startedAt: "chat_turns.started_at",
    error: "chat_turns.error",
    completedAt: "chat_turns.completed_at",
  },
  and: mocks.and,
  eq: mocks.eq,
  drizzleSql: mocks.drizzleSql,
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import {
  CHAT_TURN_REAPER_CRON,
  DEFAULT_CHAT_TURN_STUCK_HOURS,
  STUCK_TIMEOUT_ERROR,
  getChatTurnStuckHours,
  handleChatTurnReaper,
  reapStuckChatTurns,
} from "../chat-turn-reaper.js";

// Lock the failsafe contract: only running rows older than the threshold
// flip to failed with error='stuck_timeout'. A regression that reaped
// completed turns, keyed off updated_at, or wrote a free-text error would
// either corrupt live ledgers or make diagnose unsearchable.
describe("chat-turn reaper constants", () => {
  it("defaults to a 2h stuck window and a ~15min cron", () => {
    expect(DEFAULT_CHAT_TURN_STUCK_HOURS).toBe(2);
    expect(CHAT_TURN_REAPER_CRON).toBe("*/15 * * * *");
    expect(STUCK_TIMEOUT_ERROR).toBe("stuck_timeout");
  });
});

describe("getChatTurnStuckHours", () => {
  it("returns the default when env is unset or empty", () => {
    expect(getChatTurnStuckHours({})).toBe(2);
    expect(getChatTurnStuckHours({ CHAT_TURN_STUCK_HOURS: "" })).toBe(2);
  });

  it("parses a positive finite env override", () => {
    expect(getChatTurnStuckHours({ CHAT_TURN_STUCK_HOURS: "1" })).toBe(1);
    expect(getChatTurnStuckHours({ CHAT_TURN_STUCK_HOURS: "4.5" })).toBe(4.5);
  });

  it("falls back to default on non-positive or non-numeric values", () => {
    expect(getChatTurnStuckHours({ CHAT_TURN_STUCK_HOURS: "0" })).toBe(2);
    expect(getChatTurnStuckHours({ CHAT_TURN_STUCK_HOURS: "-3" })).toBe(2);
    expect(getChatTurnStuckHours({ CHAT_TURN_STUCK_HOURS: "nope" })).toBe(2);
  });
});

describe("reapStuckChatTurns (mocked db)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.returning.mockResolvedValue([]);
    mocks.where.mockReturnValue({ returning: mocks.returning });
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.update.mockReturnValue({ set: mocks.set });
  });

  it("updates only status=running rows older than the threshold via SQL interval", async () => {
    const result = await reapStuckChatTurns({ olderThanHours: 2 });

    expect(result).toEqual({ reaped: [], olderThanHours: 2 });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith({
      status: "failed",
      error: STUCK_TIMEOUT_ERROR,
      completedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    // status filter
    expect(mocks.eq).toHaveBeenCalledWith("chat_turns.status", "running");
    // age filter: SQL int * interval '1 hour' keyed on started_at
    expect(mocks.drizzleSql).toHaveBeenCalledTimes(1);
    const [strings, ...values] = mocks.drizzleSql.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sqlText = Array.from(strings).join("?");
    expect(sqlText).toContain("now()");
    expect(sqlText).toContain("interval '1 hour'");
    expect(sqlText).toContain("::int");
    // first interpolation is the startedAt column; second is the hours int
    expect(values[0]).toBe("chat_turns.started_at");
    expect(values[1]).toBe(2);
  });

  it("returns the ids of reaped turns", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: "turn-a" }, { id: "turn-b" }]);

    const result = await reapStuckChatTurns({ olderThanHours: 3 });
    expect(result).toEqual({
      reaped: ["turn-a", "turn-b"],
      olderThanHours: 3,
    });
  });

  it("floors fractional hours to an int for the SQL cast (min 1)", async () => {
    await reapStuckChatTurns({ olderThanHours: 2.9 });
    const values = mocks.drizzleSql.mock.calls[0]!.slice(1);
    expect(values[1]).toBe(2);

    mocks.drizzleSql.mockClear();
    await reapStuckChatTurns({ olderThanHours: 0.1 });
    const values2 = mocks.drizzleSql.mock.calls[0]!.slice(1);
    expect(values2[1]).toBe(1);
  });
});

describe("handleChatTurnReaper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.returning.mockResolvedValue([]);
    mocks.where.mockReturnValue({ returning: mocks.returning });
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.update.mockReturnValue({ set: mocks.set });
  });

  it("swallows empty sweeps and rethrows db failures for pg-boss retry", async () => {
    await expect(handleChatTurnReaper()).resolves.toBeUndefined();

    mocks.returning.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(handleChatTurnReaper()).rejects.toThrow(
      "database unavailable"
    );
  });
});
