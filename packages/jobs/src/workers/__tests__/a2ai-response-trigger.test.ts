/**
 * A2AI response trigger — durable chat_turns + aiSteps (Phase 2 headless).
 *
 * Mocks IS transport + DB so we assert the worker's lifecycle without Postgres:
 *   - claim turn with requestId = userMessageId
 *   - finish failed on transport error
 *   - finish completed + persist aiSteps on success
 *   - skip re-run when turn already completed
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const userMessageId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";
const userId = "user-1";
const turnId = "33333333-3333-4333-8333-333333333333";
const assistantMessageId = "44444444-4444-4444-8444-444444444444";

const ChatTurnStatus = {
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

type TurnRow = {
  id: string;
  channelId: string;
  userId: string;
  requestId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: string;
};

const mocks = vi.hoisted(() => ({
  requestHeadlessChatText: vi.fn(),
  persistAssistantReply: vi.fn(),
  insertReturning: [] as TurnRow[],
  selectReturning: [] as TurnRow[],
  messageLookup: undefined as { id: string } | undefined,
  updateSets: [] as Array<Record<string, unknown>>,
}));

// TOTAL module replacement: anything the worker imports from here must be
// listed, or it arrives as `undefined` and every test in this file dies on a
// TypeError while tsc stays green. `isRetryableHubError` is real logic, not a
// collaborator to stub — the worker's retry decision is part of what these
// tests assert — so it delegates to the real implementation.
vi.mock("@synap/intelligence-client", async () => {
  const actual = await vi.importActual<
    typeof import("@synap/intelligence-client")
  >("@synap/intelligence-client");
  return {
    requestHeadlessChatText: (...args: unknown[]) =>
      mocks.requestHeadlessChatText(...args),
    isRetryableHubError: actual.isRetryableHubError,
  };
});

vi.mock("@synap/database", () => ({
  ChatTurnStatus: {
    RUNNING: "running",
    COMPLETED: "completed",
    FAILED: "failed",
    CANCELLED: "cancelled",
  },
  chatTurns: {
    id: "id",
    userId: "user_id",
    requestId: "request_id",
  },
  messages: { id: "id" },
  eq: () => ({}),
  and: () => ({}),
  persistAssistantReply: (...args: unknown[]) =>
    mocks.persistAssistantReply(...args),
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => mocks.insertReturning,
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => mocks.selectReturning,
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.updateSets.push(values);
        return {
          // finish: await where(); reopen CAS: where().returning()
          where: () => {
            const p = Promise.resolve(undefined) as Promise<undefined> & {
              returning: () => Promise<Array<{ id: string }>>;
            };
            p.returning = async () =>
              values.status === ChatTurnStatus.RUNNING ? [{ id: turnId }] : [];
            return p;
          },
        };
      },
    }),
    query: {
      messages: {
        findFirst: async () => mocks.messageLookup,
      },
    },
  },
}));

const { handleA2AIResponseTrigger, A2AI_TRIGGER_QUEUE } =
  await import("../a2ai-response-trigger.js");

function baseJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-1",
    name: A2AI_TRIGGER_QUEUE,
    data: {
      channelId,
      userMessageId,
      content: "hello agent",
      userId,
      workspaceId: "ws-1",
      agentType: "meta",
      sourceAgentUserId: "agent-src",
      serviceUrl: "http://is.local",
      serviceApiKey: "key",
      serviceId: "svc-1",
      agentUserId: "agent-user",
      ...overrides,
    },
    retryCount: 0,
  } as any;
}

const runningTurn = (): TurnRow => ({
  id: turnId,
  channelId,
  userId,
  requestId: userMessageId,
  userMessageId,
  assistantMessageId,
  status: ChatTurnStatus.RUNNING,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertReturning = [];
  mocks.selectReturning = [];
  mocks.messageLookup = undefined;
  mocks.updateSets.length = 0;
  mocks.persistAssistantReply.mockResolvedValue({
    assistantId: assistantMessageId,
    previousHash: "p",
    hash: "h",
  });
});

describe("handleA2AIResponseTrigger", () => {
  it("passes priority:background and collectSteps:true to the headless transport", async () => {
    mocks.insertReturning = [runningTurn()];
    mocks.requestHeadlessChatText.mockResolvedValue({
      text: "pong",
      error: null,
      steps: [],
    });

    await handleA2AIResponseTrigger(baseJob());

    expect(mocks.requestHeadlessChatText).toHaveBeenCalledWith(
      "http://is.local",
      "key",
      expect.objectContaining({
        query: "hello agent",
        threadId: channelId,
        priority: "background",
        collectSteps: true,
      })
    );
  });

  it("persists assistant with aiSteps and finishes turn completed", async () => {
    mocks.insertReturning = [runningTurn()];
    const steps = [
      { id: "s1", type: "tool", content: "ask", toolName: "synap_ask" },
    ];
    mocks.requestHeadlessChatText.mockResolvedValue({
      text: "pong",
      error: null,
      steps,
    });

    await handleA2AIResponseTrigger(baseJob());

    expect(mocks.persistAssistantReply).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: assistantMessageId,
        channelId,
        userMessageId,
        content: "pong",
        metadata: expect.objectContaining({
          a2ai: true,
          aiSteps: steps,
          serviceId: "svc-1",
        }),
      })
    );
    expect(
      mocks.updateSets.some((s) => s.status === ChatTurnStatus.COMPLETED)
    ).toBe(true);
  });

  it("persists empty aiSteps array when the stream had no steps", async () => {
    mocks.insertReturning = [runningTurn()];
    mocks.requestHeadlessChatText.mockResolvedValue({
      text: "pong",
      error: null,
      steps: [],
    });

    await handleA2AIResponseTrigger(baseJob());

    const meta = mocks.persistAssistantReply.mock.calls[0]?.[0]
      ?.metadata as Record<string, unknown>;
    expect(meta.aiSteps).toEqual([]);
  });

  it("finishes failed and rethrows on transport error", async () => {
    mocks.insertReturning = [runningTurn()];
    mocks.requestHeadlessChatText.mockRejectedValue(new Error("hub down"));

    await expect(handleA2AIResponseTrigger(baseJob())).rejects.toThrow(
      "hub down"
    );
    expect(
      mocks.updateSets.some((s) => s.status === ChatTurnStatus.FAILED)
    ).toBe(true);
    expect(
      mocks.updateSets.find((s) => s.status === ChatTurnStatus.FAILED)?.error
    ).toBe("hub down");
    expect(mocks.persistAssistantReply).not.toHaveBeenCalled();
  });

  it("finishes failed WITHOUT rethrowing when the hub refused the request", async () => {
    // pg-boss retries a thrown job (`retryLimit: 3`). On 2026-08-20 a schema
    // rejection was therefore attempted FOUR times — four identical impossible
    // requests. The turn is already recorded failed, so swallowing is correct.
    mocks.insertReturning = [runningTurn()];
    const refused = new Error(
      "Intelligence Hub error: 400 Bad Request"
    ) as Error & {
      status?: number;
    };
    refused.status = 400;
    mocks.requestHeadlessChatText.mockRejectedValue(refused);

    await expect(handleA2AIResponseTrigger(baseJob())).resolves.toBeUndefined();
    expect(
      mocks.updateSets.some((s) => s.status === ChatTurnStatus.FAILED)
    ).toBe(true);
    expect(mocks.persistAssistantReply).not.toHaveBeenCalled();
  });

  it("finishes failed when response is empty", async () => {
    mocks.insertReturning = [runningTurn()];
    mocks.requestHeadlessChatText.mockResolvedValue({
      text: "",
      error: "stream boom",
      steps: [],
    });

    await expect(handleA2AIResponseTrigger(baseJob())).rejects.toThrow(
      "stream boom"
    );
    expect(
      mocks.updateSets.some((s) => s.status === ChatTurnStatus.FAILED)
    ).toBe(true);
    expect(mocks.persistAssistantReply).not.toHaveBeenCalled();
  });

  it("skips work when an existing turn is already completed", async () => {
    mocks.insertReturning = [];
    mocks.selectReturning = [
      {
        ...runningTurn(),
        status: ChatTurnStatus.COMPLETED,
      },
    ];

    await handleA2AIResponseTrigger(baseJob());

    expect(mocks.requestHeadlessChatText).not.toHaveBeenCalled();
    expect(mocks.persistAssistantReply).not.toHaveBeenCalled();
  });

  it("marks completed without re-calling IS when assistant row already exists", async () => {
    mocks.insertReturning = [];
    mocks.selectReturning = [runningTurn()];
    mocks.messageLookup = { id: assistantMessageId };

    await handleA2AIResponseTrigger(baseJob());

    expect(mocks.requestHeadlessChatText).not.toHaveBeenCalled();
    expect(mocks.persistAssistantReply).not.toHaveBeenCalled();
    expect(
      mocks.updateSets.some((s) => s.status === ChatTurnStatus.COMPLETED)
    ).toBe(true);
  });
});
