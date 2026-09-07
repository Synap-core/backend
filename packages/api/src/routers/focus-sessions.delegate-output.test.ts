/**
 * `focusSessions.delegateOutput` — handing ONE declared deliverable to an agent.
 *
 * What can actually break here is not the happy path, it is the composition:
 * this door's whole job is to call four existing doors in order, and the
 * failures this repo keeps paying for are a step that silently does not happen
 * (a message posted with no turn behind it) or a step that happens TWICE (two
 * asks in the room from one click). So the assertions are about CALL COUNTS and
 * the ROW THAT WOULD BE WRITTEN, not about the return value alone.
 *
 * The stamp is read off the actual `set()` payload, so "it records the
 * delegation" is a claim about the JSONB that reaches the column — including the
 * negative half, that `status` is NOT among it (only an approval may stamp
 * `done`, and a delegation is the moment the work has NOT been done).
 *
 * DB-FREE: `@synap/database` is partially mocked (real tables and operators
 * kept, connection replaced); the message door, the turn starter and the
 * channel minter are spies, because each is separately tested and what matters
 * here is that they are reached exactly once with the right arguments.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const SESSION = "11111111-1111-4111-8111-111111111111";
const WS = "33333333-3333-4333-8333-333333333333";
const CHANNEL = "44444444-4444-4444-8444-444444444444";

const findFirstSpy = vi.fn();
/** The agent USER lookup behind the roster append. `undefined` ⇒ no such agent. */
let agentUser: unknown = { id: "agent-user-1" };
/** The row every FOR UPDATE lock in this door resolves. */
let lockedSession: Record<string, unknown> | undefined;
/** Every `set()` payload written inside a transaction, in order. */
const txSets: Record<string, unknown>[] = [];

const dialect = new PgDialect();

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const tx = {
    select: () => {
      const b: Record<string, unknown> = {
        from: () => b,
        where: () => b,
        for: async () => (lockedSession ? [lockedSession] : []),
      };
      return b;
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        txSets.push(patch);
        return { where: async () => undefined };
      },
    }),
  };
  return {
    ...actual,
    db: {
      select: (...args: unknown[]) =>
        (actual.db as { select: (...a: unknown[]) => unknown }).select(...args),
      transaction: async (cb: (t: unknown) => unknown) => cb(tx),
      // `query.<table>.findFirst` for ANY table — the tRPC layer reads
      // `syncGeneration` on every call, so a mock spelling out only
      // `focusSessions` breaks before the procedure body is reached.
      query: new Proxy({} as Record<string, unknown>, {
        get: (_t, table) => {
          if (table === "focusSessions") return { findFirst: findFirstSpy };
          if (table === "users") return { findFirst: async () => agentUser };
          return { findFirst: async () => undefined };
        },
      }),
      insert: () => {
        const chain: Record<string, unknown> = {
          values: () => chain,
          onConflictDoNothing: () => chain,
          onConflictDoUpdate: () => chain,
          returning: async () => [],
          then: (resolve: (v: unknown) => void) => resolve([]),
        };
        return chain;
      },
    },
  };
});

const ensureSessionChannel = vi.fn(async () => CHANNEL as string | null);
vi.mock("../services/focus-sessions/ensure-session-channel.js", () => ({
  ensureSessionChannel: (...a: unknown[]) =>
    (ensureSessionChannel as unknown as (...x: unknown[]) => unknown)(...a),
}));

const postChannelMessage = vi.fn(async (_p: Record<string, unknown>) => ({
  success: true as const,
  messageId: "msg-1",
  channelId: CHANNEL,
  ackState: "applied" as const,
}));
vi.mock("../services/messaging/post-message.js", () => ({
  postChannelMessage: (...a: unknown[]) =>
    (postChannelMessage as unknown as (...x: unknown[]) => unknown)(...a),
}));

const triggerAutoRespond = vi.fn(async (_p: Record<string, unknown>) => true);
vi.mock("../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: (...a: unknown[]) =>
    (triggerAutoRespond as unknown as (...x: unknown[]) => unknown)(...a),
}));

const { focusSessionsRouter } = await import("./focus-sessions.js");

const ctx = { userId: "user-1", authenticated: true } as never;
const caller = () => focusSessionsRouter.createCaller(ctx);

const SLOTS = [
  { kind: "document", label: "Spec" },
  { kind: "document", label: "Summary" },
];

const sessionRow = (outputs: unknown[] = SLOTS) => ({
  id: SESSION,
  userId: "user-1",
  workspaceId: WS,
  goal: "Ship the thing",
  channelId: CHANNEL,
  expectedOutputs: outputs,
});

/** The `expectedOutputs` array the door wrote back, from the real set payload. */
const writtenOutputs = () =>
  txSets.at(-1)!.expectedOutputs as Record<string, unknown>[];

beforeEach(() => {
  vi.clearAllMocks();
  txSets.length = 0;
  agentUser = { id: "agent-user-1" };
  ensureSessionChannel.mockResolvedValue(CHANNEL);
  postChannelMessage.mockResolvedValue({
    success: true,
    messageId: "msg-1",
    channelId: CHANNEL,
    ackState: "applied",
  });
  triggerAutoRespond.mockResolvedValue(true);
  findFirstSpy.mockResolvedValue(sessionRow());
  lockedSession = { expectedOutputs: SLOTS };
});

describe("focusSessions.delegateOutput — the happy path is a COMPOSITION", () => {
  it("posts exactly ONE ask and starts exactly ONE turn, for the named slot", async () => {
    const result = await caller().delegateOutput({
      sessionId: SESSION,
      expectedLabel: "Summary",
      agentType: "workspace-builder",
    });

    expect(result).toMatchObject({
      ok: true,
      expectedLabel: "Summary",
      kind: "document",
      agentType: "workspace-builder",
      channelId: CHANNEL,
      messageId: "msg-1",
      triggered: true,
    });

    // ONE message. A second ask in the room is the failure a person actually
    // sees, and it is one stray `triggerAI: true` away.
    expect(postChannelMessage).toHaveBeenCalledTimes(1);
    const post = postChannelMessage.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(post.channelId).toBe(CHANNEL);
    expect(post.role).toBe("user");
    // `triggerAI` would start an ORCHESTRATOR turn with no agentType, i.e. the
    // delegation would silently land on the wrong agent AND double-fire.
    expect(post.triggerAI).toBe(false);
    expect(post.content).toContain("Summary");
    // The KIND is rendered through the vocabulary, not the raw token.
    expect(post.content).toContain("Document");

    // ONE turn, carrying the session and the type.
    expect(triggerAutoRespond).toHaveBeenCalledTimes(1);
    expect(triggerAutoRespond.mock.calls[0]![0]).toMatchObject({
      channelId: CHANNEL,
      userMessageId: "msg-1",
      focusSessionId: SESSION,
      agentType: "workspace-builder",
    });
  });

  it("stamps delegatedTo/delegatedAt on that slot ONLY, and never a status", async () => {
    await caller().delegateOutput({
      sessionId: SESSION,
      expectedLabel: "Summary",
      agentType: "workspace-builder",
    });

    const written = writtenOutputs();
    expect(written[1]).toMatchObject({
      label: "Summary",
      delegatedTo: "workspace-builder",
    });
    expect(typeof written[1]!.delegatedAt).toBe("string");
    // The negative half, and the important one: delegating is not delivering.
    expect(written[1]).not.toHaveProperty("status");
    expect(written[0]).not.toHaveProperty("delegatedTo");
  });

  it("defaults the agent type to the orchestrator, matching the turn starter", async () => {
    const result = await caller().delegateOutput({
      sessionId: SESSION,
      expectedLabel: "Spec",
    });
    expect(result).toMatchObject({ agentType: "meta" });
    expect(triggerAutoRespond.mock.calls[0]![0]).toMatchObject({
      agentType: "meta",
    });
  });

  it("matches the label case-insensitively but stores the DECLARED casing", async () => {
    const result = await caller().delegateOutput({
      sessionId: SESSION,
      expectedLabel: "  summary ",
    });
    expect(result).toMatchObject({ expectedLabel: "Summary" });
    expect(writtenOutputs()[1]).toMatchObject({ label: "Summary" });
  });

  it("clears a previous RETURN — re-asking supersedes the old reviewer note", async () => {
    const returned = [
      { kind: "document", label: "Spec" },
      {
        kind: "document",
        label: "Summary",
        returnedReason: "too long",
        returnedAt: "2026-09-01T00:00:00.000Z",
      },
    ];
    findFirstSpy.mockResolvedValue(sessionRow(returned));
    lockedSession = { expectedOutputs: returned };

    await caller().delegateOutput({
      sessionId: SESSION,
      expectedLabel: "Summary",
    });

    const written = writtenOutputs();
    expect(written[1]).not.toHaveProperty("returnedReason");
    expect(written[1]).not.toHaveProperty("returnedAt");
    expect(written[1]).toMatchObject({ delegatedTo: "meta" });
  });

  it("stamps the REQUESTED slot when a sibling is already delegated", async () => {
    // THE DEFECT. The stamp used to be re-derived under the lock by looking for
    // "the delegated one" (`next.find((o) => o.delegatedTo)`), which on a
    // session with an already-delegated sibling found THAT slot instead: the
    // requested slot was never marked, and the sibling's return note was wiped
    // — while the door reported a successful delegation of the slot the caller
    // asked for.
    const withSibling = [
      {
        kind: "document",
        label: "Spec",
        delegatedTo: "researcher",
        delegatedAt: "2026-09-01T00:00:00.000Z",
        returnedReason: "needs sources",
        returnedAt: "2026-09-02T00:00:00.000Z",
      },
      { kind: "document", label: "Summary" },
    ];
    findFirstSpy.mockResolvedValue(sessionRow(withSibling));
    lockedSession = { expectedOutputs: withSibling };

    const result = await caller().delegateOutput({
      sessionId: SESSION,
      expectedLabel: "Summary",
      agentType: "workspace-builder",
    });
    expect(result).toMatchObject({ expectedLabel: "Summary" });

    const written = writtenOutputs();
    // The REQUESTED slot is the one that got the delegation.
    expect(written[1]).toMatchObject({
      label: "Summary",
      delegatedTo: "workspace-builder",
    });
    // The sibling is untouched — same delegate, same return note.
    expect(written[0]).toMatchObject({
      label: "Spec",
      delegatedTo: "researcher",
      delegatedAt: "2026-09-01T00:00:00.000Z",
      returnedReason: "needs sources",
      returnedAt: "2026-09-02T00:00:00.000Z",
    });
  });

  it("mints a room for a session that never had one", async () => {
    findFirstSpy.mockResolvedValue({ ...sessionRow(), channelId: null });
    await caller().delegateOutput({
      sessionId: SESSION,
      expectedLabel: "Spec",
    });
    expect(ensureSessionChannel).toHaveBeenCalledTimes(1);
    expect(postChannelMessage).toHaveBeenCalledTimes(1);
  });
});

describe("focusSessions.delegateOutput — refusals write and say nothing", () => {
  it("rejects a session that is not the caller's", async () => {
    findFirstSpy.mockResolvedValue(undefined);
    await expect(
      caller().delegateOutput({ sessionId: SESSION, expectedLabel: "Spec" })
    ).rejects.toThrow(/not found/i);
    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(triggerAutoRespond).not.toHaveBeenCalled();
    expect(txSets).toHaveLength(0);
  });

  it("puts the CALLER's id in the session lookup predicate, not just the id", async () => {
    // The test above passes with the owner predicate DELETED — an empty mock
    // result proves nothing about the query that produced it. This reads the
    // predicate the door actually built.
    await caller().delegateOutput({
      sessionId: SESSION,
      expectedLabel: "Spec",
    });
    const where = (findFirstSpy.mock.calls[0]![0] as { where: never }).where;
    const compiled = dialect.sqlToQuery(where);
    expect(compiled.sql).toMatch(/user_id"?\s*=/);
    expect(compiled.params).toContain("user-1");
    expect(compiled.params).toContain(SESSION);
  });

  it("NOT_FOUND on a label this session never declared", async () => {
    await expect(
      caller().delegateOutput({
        sessionId: SESSION,
        expectedLabel: "Board memo",
      })
    ).rejects.toThrow(/declares no output/i);
    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(triggerAutoRespond).not.toHaveBeenCalled();
    expect(txSets).toHaveLength(0);
  });

  it("BAD_REQUEST on a slot that is already delivered", async () => {
    findFirstSpy.mockResolvedValue(
      sessionRow([{ kind: "document", label: "Spec", status: "done" }])
    );
    await expect(
      caller().delegateOutput({ sessionId: SESSION, expectedLabel: "Spec" })
    ).rejects.toThrow(/already delivered/i);
    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(txSets).toHaveLength(0);
  });

  it("NOT_FOUND when the row vanishes between the load and the lock", async () => {
    // The lock found nothing, so NOTHING was recorded. Reporting a delegation
    // here would be a receipt for a stamp that does not exist.
    lockedSession = undefined;
    await expect(
      caller().delegateOutput({ sessionId: SESSION, expectedLabel: "Spec" })
    ).rejects.toThrow(/not found/i);
    expect(txSets).toHaveLength(0);
  });

  it("says nothing in the room when no room could be opened", async () => {
    ensureSessionChannel.mockResolvedValue(null);
    await expect(
      caller().delegateOutput({ sessionId: SESSION, expectedLabel: "Spec" })
    ).rejects.toThrow(/room/i);
    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(txSets).toHaveLength(0);
  });
});

describe("focusSessions.delegateOutput — the roster is best-effort", () => {
  it("delegates anyway when no agent USER exists for the type", async () => {
    // An agent TYPE is not an agent USER. Minting one as a side effect of a
    // delegation would create a principal nobody asked for, so the roster is
    // simply left alone — the turn is routed by type regardless.
    agentUser = undefined;
    const result = await caller().delegateOutput({
      sessionId: SESSION,
      expectedLabel: "Spec",
      agentType: "nobody-has-this",
    });
    expect(result).toMatchObject({ ok: true, agentAttached: false });
    expect(postChannelMessage).toHaveBeenCalledTimes(1);
    expect(triggerAutoRespond).toHaveBeenCalledTimes(1);
  });

  it("reports a turn that was never enqueued rather than claiming success", async () => {
    triggerAutoRespond.mockResolvedValue(false);
    const result = await caller().delegateOutput({
      sessionId: SESSION,
      expectedLabel: "Spec",
    });
    expect(result).toMatchObject({ ok: true, triggered: false });
  });
});
