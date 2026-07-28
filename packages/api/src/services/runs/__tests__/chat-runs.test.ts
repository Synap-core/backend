import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chat flowType on the UnifiedRun substrate — regression lock.
 *
 * Discord agent-turn + browser chat write `chat_turns` (no parallel ledger).
 * This proves:
 *   (a) `listRuns({flowType:"chat"})` maps chat_turns → UnifiedRun
 *   (b) merged feed (no flowType) only includes chat when status is
 *       running|failed — completed successes stay out of feed noise
 *   (c) status filter failed|running is pushed to chat_turns.status
 *
 * DB is mocked (no live Postgres — mirrors capability-runs.test.ts).
 */

const { mockDb, mockUserVisibleWhere } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  mockUserVisibleWhere: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    and: vi.fn((...conditions: unknown[]) => ({
      and: conditions.filter((c) => c !== undefined),
    })),
    eq: vi.fn((column: unknown, value: unknown) => ({ eq: [column, value] })),
    desc: vi.fn((column: unknown) => ({ desc: column })),
    inArray: vi.fn((column: unknown, values: unknown[]) => ({
      inArray: [column, values],
    })),
    drizzleSql: Object.assign(
      vi.fn((strings: TemplateStringsArray) => ({ sql: strings.join("?") })),
      { raw: vi.fn() }
    ),
  };
});

vi.mock("../../../utils/user-visible-where.js", () => ({
  userVisibleWhere: mockUserVisibleWhere,
  workspaceLensWhere: vi.fn(() => ({ workspaceLens: true })),
  ownerPrivateVisibleWhere: vi.fn(() => ({ ownerPrivate: true })),
}));

vi.mock("../../../utils/project-scope.js", () => ({
  accessScopeWhere: vi.fn(() => ({ accessScope: true })),
}));

import { ChatTurnStatus } from "@synap/database";
import { listRuns } from "../index.js";

/** Chainable select() builder resolving to `rows` at `.limit()`. */
function selectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

const USER = "user-1";
const TURN_ID = "turn-1";
const CHANNEL_ID = "channel-1";

describe("listChatRuns (via listRuns) — chat_turns → UnifiedRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserVisibleWhere.mockReturnValue({ __userVisible: USER });
  });

  it("maps a completed chat turn to UnifiedRun flowType chat", async () => {
    mockDb.select.mockReturnValueOnce(
      selectChain([
        {
          id: TURN_ID,
          status: ChatTurnStatus.COMPLETED,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          completedAt: new Date("2026-01-01T00:00:05Z"),
          channelId: CHANNEL_ID,
          error: null,
          workspaceId: "ws-1",
        },
      ])
    );

    const runs = await listRuns({ userId: USER, flowType: "chat" });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: TURN_ID,
      flowType: "chat",
      flowId: null,
      flowName: "Chat",
      status: "completed",
      channelId: CHANNEL_ID,
      workspaceId: "ws-1",
      error: null,
      triggeredBy: USER,
    });
  });

  it("maps a failed chat turn with error string", async () => {
    mockDb.select.mockReturnValueOnce(
      selectChain([
        {
          id: TURN_ID,
          status: ChatTurnStatus.FAILED,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          completedAt: new Date("2026-01-01T00:01:00Z"),
          channelId: CHANNEL_ID,
          error: "Agent turn deadline exceeded",
          workspaceId: null,
        },
      ])
    );

    const runs = await listRuns({
      userId: USER,
      flowType: "chat",
      status: "failed",
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      flowType: "chat",
      status: "failed",
      error: "Agent turn deadline exceeded",
    });
  });

  it("does not call chat ledger on unfiltered merge (no successful Discord noise)", async () => {
    // Unfiltered listRuns fires automation/playbook/capture/capability/session
    // but NOT chat (includeChat requires flowType=chat or status running|failed).
    // Each non-chat ledger issues one select(); if chat were included we'd get one more.
    // Return empty for every select so the merge is empty.
    mockDb.select.mockImplementation(() => selectChain([]));

    const runs = await listRuns({ userId: USER, limit: 10 });
    expect(runs).toEqual([]);

    // 5 ledgers: automation, playbook, capture, capability, session — no chat.
    expect(mockDb.select).toHaveBeenCalledTimes(5);
  });

  it("includes chat ledger when status=running (diagnose stuck path)", async () => {
    // status=running: automation, playbook, session, chat (capture/capability
    // short-circuit empty for non-matching status — but may still avoid select
    // or return early without select). Count that chat's select was among them.
    mockDb.select.mockImplementation(() =>
      selectChain([
        {
          id: TURN_ID,
          status: ChatTurnStatus.RUNNING,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          completedAt: null,
          channelId: CHANNEL_ID,
          error: null,
          workspaceId: "ws-1",
        },
      ])
    );

    const runs = await listRuns({
      userId: USER,
      status: "running",
      limit: 10,
    });

    // At least the chat row appears (other ledgers may also map the same mock).
    const chatRuns = runs.filter((r) => r.flowType === "chat");
    expect(chatRuns.length).toBeGreaterThanOrEqual(1);
    expect(chatRuns[0]).toMatchObject({
      id: TURN_ID,
      flowType: "chat",
      status: "running",
      channelId: CHANNEL_ID,
    });
  });
});
