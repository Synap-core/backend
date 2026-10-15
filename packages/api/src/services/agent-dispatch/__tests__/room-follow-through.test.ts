/**
 * An @mentioned EXTERNAL agent is reached its own way (`room-follow-through.ts`)
 * — and only on the session OWNER's words: a teammate's mention never reaches
 * a run acting with the owner's authority (dispatch) nor staffs the owner's
 * session (pull); the room is told instead.
 *
 * Captured at their doors: the binding send, the roster write, the room notice.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: { id: "s1", userId: "owner" } as {
    id: string;
    userId: string;
  } | null,
  wakes: [] as Array<Record<string, unknown>>,
  attaches: [] as Array<Record<string, unknown>>,
  notices: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: { query: { focusSessions: { findFirst: async () => h.session } } },
}));
vi.mock("../wake-external-agent.js", () => ({
  wakeExternalAgent: async (p: Record<string, unknown>) => {
    h.wakes.push(p);
    return { status: "sent", runId: "r1" };
  },
}));
vi.mock("../../focus-sessions/attach-session-agent.js", () => ({
  attachSessionAgent: async (p: Record<string, unknown>) => {
    h.attaches.push(p);
    return { status: "attached", agentIds: [] };
  },
}));
vi.mock("../binding-call.js", () => ({
  agentDisplayName: async () => "Claude Code",
  postDispatchNotice: async (p: Record<string, unknown>) => {
    h.notices.push(p);
    return true;
  },
}));
vi.mock("../../messaging/post-message.js", () => ({
  postChannelMessage: async () => ({ success: true }),
}));

import { wakeMentionedAgents } from "../room-follow-through.js";

const wake = (senderId: string, reach: "dispatch" | "pull") =>
  wakeMentionedAgents({
    channelId: "c1",
    senderId,
    messageId: "m1",
    content: "@claude-code fix the tests",
    wake: [{ agentUserId: "cc", reach }],
  });

beforeEach(() => {
  h.session = { id: "s1", userId: "owner" };
  h.wakes.length = 0;
  h.attaches.length = 0;
  h.notices.length = 0;
});

describe("wakeMentionedAgents", () => {
  it("the owner's mention reaches a dispatch agent's live run", async () => {
    await wake("owner", "dispatch");
    expect(h.wakes).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        agentUserId: "cc",
        kind: "message",
      }),
    ]);
  });

  it("the owner's mention puts a pull agent on the roster", async () => {
    await wake("owner", "pull");
    expect(h.attaches).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        agentId: "cc",
        userId: "owner",
      }),
    ]);
  });

  it("a teammate's mention reaches neither — the room is told", async () => {
    await wake("teammate", "dispatch");
    await wake("teammate", "pull");
    expect(h.wakes).toEqual([]);
    expect(h.attaches).toEqual([]);
    expect(h.notices).toHaveLength(2);
  });

  it("outside a session room: told, nothing sent", async () => {
    h.session = null;
    await wake("owner", "dispatch");
    expect(h.wakes).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });
});
