import { describe, it, expect, beforeEach, vi } from "vitest";

const { findFirstMock, insertValuesMock, returningMock } = vi.hoisted(() => {
  const returningMock = vi.fn(async () => [{ id: "new-session-id" }]);
  const insertValuesMock = vi.fn((_values: Record<string, unknown>) => ({
    returning: returningMock,
  }));
  return {
    findFirstMock: vi.fn(),
    insertValuesMock,
    returningMock,
  };
});

vi.mock("../client-pg.js", () => ({
  db: {
    query: { focusSessions: { findFirst: findFirstMock } },
    insert: () => ({ values: insertValuesMock }),
  },
}));
vi.mock("../schema/focus-sessions.js", () => ({ focusSessions: {} }));
vi.mock("../schema/links.js", () => ({ links: {} }));
// `openRunSession` now imports the `spawned_from` producer (session-spawn.js),
// which pulls in `inArray` + `sql`. A vi.mock factory is a TOTAL replacement, so
// a named export it omits is an import-time failure for the whole file — the
// exact trap that has silently killed mocking tests here before.
vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

import { openRunSession } from "./open-run-session.js";

beforeEach(() => {
  findFirstMock.mockReset();
  insertValuesMock.mockClear();
  returningMock.mockReset();
  returningMock.mockResolvedValue([{ id: "new-session-id" }]);
});

describe("openRunSession", () => {
  it("reuses the channel's active RUN session (has metadata.source)", async () => {
    findFirstMock.mockResolvedValue({
      id: "existing-run-session",
      metadata: { source: "automation" },
    });

    const result = await openRunSession({
      userId: "u1",
      goal: "Daily digest for #general",
      channelId: "chan-1",
      source: "automation",
    });

    expect(result).toEqual({ sessionId: "existing-run-session", reused: true });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("does NOT hijack a human session (no metadata.source) — opens its own", async () => {
    // A human's interactive session is active on the channel.
    findFirstMock.mockResolvedValue({ id: "human-session", metadata: {} });

    const result = await openRunSession({
      userId: "u1",
      goal: "run",
      channelId: "chan-1",
      source: "automation",
    });

    // Never reuses the human session; inserts its own instead.
    expect(result.reused).toBe(false);
    expect(result.sessionId).toBe("new-session-id");
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
  });

  it("creates a fresh session (with automation data) when the channel has none", async () => {
    findFirstMock.mockResolvedValue(undefined);

    const result = await openRunSession({
      userId: "u1",
      goal: "Daily digest for #general",
      channelId: "chan-1",
      workspaceId: "ws-1",
      agentUserId: "agent-1",
      source: "automation",
      automationId: "auto-1",
      automationRunId: "run-1",
    });

    expect(result).toEqual({ sessionId: "new-session-id", reused: false });
    const inserted = insertValuesMock.mock.calls[0][0];
    expect(inserted.status).toBe("active");
    expect(inserted.channelId).toBe("chan-1");
    expect(inserted.agentIds).toEqual(["agent-1"]);
    expect(inserted.metadata).toMatchObject({
      source: "automation",
      automationId: "auto-1",
      automationRunId: "run-1",
    });
    expect(inserted.templateId).toBe("auto-1");
  });

  it("skips the channel lookup for a channel-less run (always fresh)", async () => {
    const result = await openRunSession({
      userId: "u1",
      goal: "Sweep",
      source: "automation",
    });

    expect(findFirstMock).not.toHaveBeenCalled();
    expect(result).toEqual({ sessionId: "new-session-id", reused: false });
    const inserted = insertValuesMock.mock.calls[0][0];
    expect(inserted.channelId).toBeNull();
    expect(inserted.metadata).toEqual({ source: "automation" });
  });

  it("recovers from a concurrent unique-index race by reusing the winner's run session", async () => {
    // 1st reuse-check: no session yet. After our insert loses the race (23505),
    // 2nd reuse-check finds the winner's run session.
    findFirstMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      id: "winner-session",
      metadata: { source: "automation" },
    });
    // First insert throws a unique-violation; there is no second insert.
    returningMock.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), { code: "23505" })
    );

    const result = await openRunSession({
      userId: "u1",
      goal: "race",
      channelId: "chan-1",
      source: "automation",
    });

    expect(result).toEqual({ sessionId: "winner-session", reused: true });
  });
});
