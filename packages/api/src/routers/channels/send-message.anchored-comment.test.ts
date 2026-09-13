/**
 * chat.sendMessage — the anchored-comment auto-respond decision, driven through
 * the REAL procedure (real input schema, real gate order, real early return).
 *
 * Mocked: the IO edges (db rows, events, IS routing), the anchor authority gate
 * (own suite), and `planAnchoredCommentTurn` (own pglite suite:
 * `utils/__tests__/anchored-comment-turn.pglite.test.ts`) — so what this file
 * proves is the SEND DOOR's half: a planned trigger goes through the one door
 * exactly once, carrying the resolved anchor as `turnContext.anchor`; a
 * non-trigger and an unanchored message do not.
 *
 * `protectedProcedure` is swapped for the bare `t.procedure`: its auth /
 * read-only / audit middlewares are covered elsewhere and would need a live DB.
 *
 * NOT covered here: an agent-authored anchored message. This door has no agent
 * principal (Kratos session only), so the case cannot be expressed through it;
 * the tripwire at the bottom pins that no OTHER door (Hub REST threads,
 * post-message / MCP) can reach the planner.
 *
 * TRIPWIRE LIMIT: it matches static `from "…anchored-comment-turn.js"` import
 * specifiers only. A dynamic `import("…/anchored-comment-turn.js")` (or a
 * re-export through a barrel) is invisible to it. Granularity is the file.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  plan: vi.fn(),
  trigger: vi.fn(async () => true),
  inserted: [] as Array<Record<string, unknown>>,
  channel: null as Record<string, unknown> | null,
}));

vi.mock("../../trpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../trpc.js")>();
  return { ...actual, protectedProcedure: actual.t.procedure };
});
vi.mock("../../middleware/ai-rate-limit.js", async (importOriginal) => {
  const { t } =
    await vi.importActual<typeof import("../../trpc.js")>("../../trpc.js");
  return {
    ...(await importOriginal<
      typeof import("../../middleware/ai-rate-limit.js")
    >()),
    aiRateLimitMiddleware: t.middleware(({ next }) => next()),
  };
});
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = () => {
    const b: Record<string, unknown> = {};
    for (const k of ["from", "where", "limit", "innerJoin", "orderBy"]) {
      b[k] = () => b;
    }
    (b as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve([]);
    return b;
  };
  return {
    ...actual,
    db: {
      query: {
        channels: { findFirst: vi.fn(async () => m.channel) },
        focusSessions: { findFirst: vi.fn(async () => ({ id: "session-1" })) },
      },
      select: vi.fn(() => chain()),
      insert: vi.fn(() => ({
        values: vi.fn(async (row: Record<string, unknown>) => {
          m.inserted.push(row);
        }),
      })),
    },
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: vi.fn(),
}));
vi.mock("../../utils/message-anchor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/message-anchor.js")>()),
  assertMessageAnchorAllowed: vi.fn(async () => undefined),
}));
vi.mock("../../utils/anchored-comment-turn.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/anchored-comment-turn.js")
  >()),
  planAnchoredCommentTurn: m.plan,
}));
vi.mock("../../utils/trigger-auto-respond.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/trigger-auto-respond.js")
  >()),
  triggerAutoRespond: m.trigger,
}));
vi.mock("../../utils/intelligence-routing.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/intelligence-routing.js")
  >()),
  resolveIntelligenceServiceByAgentId: vi.fn(async () => ({
    client: {},
    agentUserId: "service-agent",
  })),
}));
vi.mock("../../utils/emit-message-observation.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/emit-message-observation.js")
  >()),
  emitMessageObservation: vi.fn(async () => undefined),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/chat-realtime-broadcast.js")
  >()),
  emitChatEvent: vi.fn(),
}));
vi.mock("./helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helpers.js")>()),
  resolveAgentId: vi.fn(async () => "9b0f7a52-3c61-4d0e-8f7e-5a1c2b3d4e5f"),
  ensureAgentUser: vi.fn(async () => "agent-user"),
  usesInternalSessionBoundary: () => false,
}));

import { router } from "../../trpc.js";
import { ChannelType, ChannelStatus } from "@synap/database/schema";
import { sendMessageProcedure } from "./send-message.js";
import { assertMessageAnchorAllowed } from "../../utils/message-anchor.js";

const CHANNEL = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const PROPOSAL = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";
const anchor = {
  proposalId: PROPOSAL,
  opRef: "t2",
  field: "position",
  contentVersion: 1,
};
const resolved = {
  version: 1,
  resolution: "resolved",
  proposalId: PROPOSAL,
  stale: true,
};

const send = (input: Record<string, unknown>) =>
  router({ send: sendMessageProcedure })
    .createCaller({
      userId: "user-1",
      authenticated: true,
      workspaceId: null,
    } as never)
    .send({
      channelId: CHANNEL,
      content: "this mixer position means a transition",
      ...input,
    } as never);

beforeEach(() => {
  vi.clearAllMocks();
  m.inserted.length = 0;
  m.channel = {
    id: CHANNEL,
    userId: "user-1",
    workspaceId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    channelType: ChannelType.THREAD,
    status: ChannelStatus.ACTIVE,
    assignedAgentId: null,
    senderAgentId: null,
    contextObjectType: "focus_session",
    contextObjectId: "session-1",
  };
});

describe("chat.sendMessage anchored comment", () => {
  it("a planned trigger wakes the agent ONCE through the one door, with the resolved anchor", async () => {
    m.plan.mockResolvedValue({
      context: resolved,
      decision: {
        trigger: true,
        reason: "intake_run",
        agentType: "capture-analyst",
      },
    });

    const out = await send({ metadata: { anchor } });

    expect(out).toEqual({ messageId: expect.any(String), channelId: CHANNEL });
    // The authority gate runs, and runs BEFORE the planner reads any row.
    expect(assertMessageAnchorAllowed).toHaveBeenCalledWith({
      anchor,
      channelId: CHANNEL,
      userId: "user-1",
    });
    expect(
      vi.mocked(assertMessageAnchorAllowed).mock.invocationCallOrder[0]
    ).toBeLessThan(m.plan.mock.invocationCallOrder[0]!);
    expect(m.plan).toHaveBeenCalledWith({
      anchor,
      channelId: CHANNEL,
      comment: "this mixer position means a transition",
    });
    expect(m.trigger).toHaveBeenCalledTimes(1);
    expect(m.trigger).toHaveBeenCalledWith({
      channelId: CHANNEL,
      userMessageId: out.messageId,
      content: "this mixer position means a transition",
      sourceUserId: "user-1",
      focusSessionId: "session-1",
      agentType: "capture-analyst",
      turnContext: { anchor: resolved },
    });
    // The persisted message carries the same server-built context + the anchor.
    expect(m.inserted[0]?.metadata).toEqual({
      turnContext: { anchor: resolved },
      anchor,
    });
  });

  it("an anchor the planner does not trigger on keeps today's silence", async () => {
    m.plan.mockResolvedValue({
      context: resolved,
      decision: { trigger: false, reason: "not_session_channel" },
    });

    await send({ metadata: { anchor } });

    expect(m.trigger).not.toHaveBeenCalled();
  });

  it("an unanchored message in a non-run thread never plans and never triggers", async () => {
    await send({});

    expect(m.plan).not.toHaveBeenCalled();
    expect(m.trigger).not.toHaveBeenCalled();
    expect(m.inserted[0]).not.toHaveProperty("metadata");
  });
});

describe("tripwire: only the human send door reaches the anchored-comment planner", () => {
  const srcRoot = fileURLToPath(new URL("../../", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name))
        files.push(path);
    }
  };
  walk(srcRoot);

  it("the planner is imported by send-message.ts and nothing else", () => {
    // Non-vacuity: the walk saw the codebase, and it can see a known importer.
    expect(files.length).toBeGreaterThan(500);
    const importers = files
      .filter((f) =>
        /from "[./]+(?:utils\/)?anchored-comment-turn\.js"/.test(
          readFileSync(f, "utf8")
        )
      )
      .map((f) => relative(srcRoot, f));
    expect(importers).toEqual(["routers/channels/send-message.ts"]);
  });
});
