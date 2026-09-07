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

import { ChatTurnStatus, chatTurns } from "@synap/database";
import { listRuns } from "../index.js";

/**
 * Every table handed to `.from()` across all select chains in the current test.
 * Reset in beforeEach. Lets a test assert WHICH ledgers ran instead of counting
 * how many `select()` calls happened — a count is a proxy that breaks whenever a
 * ledger is added or a ledger issues a second query, without the invariant it
 * guards having moved at all.
 */
const fromTables: unknown[] = [];

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
  chain.from.mockImplementation((table: unknown) => {
    fromTables.push(table);
    return chain;
  });
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
    fromTables.length = 0;
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
      // Not a flat "Chat": listRuns labels a turn by its channel title, else
      // `AI turn · <first 8 of id>` (index.ts:1156-1165, committed 94a543d7) so a
      // Failed list is not a wall of identical rows. This fixture has no channel
      // title, so it lands on the fallback.
      flowName: `AI turn · ${TURN_ID.slice(0, 8)}`,
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
    // Unfiltered listRuns fires the non-chat ledgers but NOT chat (includeChat
    // requires flowType=chat or status running|failed).
    // Return empty for every select so the merge is empty.
    mockDb.select.mockImplementation(() => selectChain([]));

    const runs = await listRuns({ userId: USER, limit: 10 });
    expect(runs).toEqual([]);

    // The invariant is "the chat ledger did not run", asserted DIRECTLY on the
    // table it would have queried. The previous form asserted
    // `select` was called exactly 5 times; that broke the day a sixth ledger
    // (listAgentWriteRuns) was added and again when ledgers grew a second query
    // — neither of which touches chat. Assert what the test is named after.
    expect(fromTables).not.toContain(chatTurns);
    // ...and the guard is only meaningful if the other ledgers DID run.
    expect(mockDb.select).toHaveBeenCalled();
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
