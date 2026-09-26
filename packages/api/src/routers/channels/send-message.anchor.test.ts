/**
 * `channels.sendMessage` — an anchored comment through the REAL tRPC procedure.
 *
 * Drives `channelsRouter.createCaller(ctx).sendMessage(...)` — input schema,
 * middleware, channel gate, anchor gate, the user-message insert — and reads
 * the row handed to `insert(messages).values(...)`. The turn is stopped right
 * after that insert (the `message.sent` observation throws a sentinel), because
 * everything past it is the model call, which this contract does not touch.
 *
 * DB-FREE: `@synap/database` is partially mocked (real tables + operators kept,
 * connection replaced); the proposal-visibility SSOT gate is replaced with
 * `importOriginal` so a refused anchor is a decision this suite controls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  messages as messagesTable,
  proposals as proposalsTable,
} from "@synap/database/schema";

const USER = "0aaaaaaa-0000-4000-8000-000000000001";
const CHANNEL = "0bbbbbbb-0000-4000-8000-000000000002";
const PROPOSAL = "0ccccccc-0000-4000-8000-000000000003";
const STOP = "STOP_AFTER_USER_MESSAGE_INSERT";

const state = {
  /** Every row handed to `insert(messages).values(...)`. */
  messageRows: [] as Record<string, unknown>[],
  readRows: [] as Record<string, unknown>[],
};

/**
 * The anchored proposal the server-side planner (`planAnchoredCommentTurn`)
 * reads: pending, revised twice, with a `$e1` entity op — so the persisted
 * `turnContext.anchor` is a RESOLVED anchor, not `proposal_not_found`.
 */
const PROPOSAL_ROW = {
  status: "pending",
  data: {
    operations: [
      {
        op: "create_entity",
        ref: "$e1",
        profileSlug: "task",
        title: "Old title",
        properties: { status: "todo" },
      },
    ],
  },
  sessionId: null,
  agentUserId: null,
  revisionHistory: [{ at: "t1" }, { at: "t2" }],
};

function selectChain(): any {
  let rows: unknown[] = [];
  const chain: any = {
    from: (table: unknown) => {
      rows = table === proposalsTable ? [PROPOSAL_ROW] : [];
      return chain;
    },
    // The channel read rule's object-room branch builds the entities floor
    // with `db.select().innerJoin` subqueries (never executed here).
    innerJoin: () => chain,
    leftJoin: () => chain,
    as: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return chain;
}

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  return {
    ...actual,
    db: {
      select: () => selectChain(),
      insert: (table: unknown) => {
        const chain: Record<string, unknown> = {
          values: (row: Record<string, unknown>) => {
            if (table === schema.messages) state.messageRows.push(row);
            return chain;
          },
          onConflictDoNothing: () => chain,
          onConflictDoUpdate: () => chain,
          returning: async () => [],
          then: (resolve: (v: unknown) => void) => resolve([]),
        };
        return chain;
      },
      query: new Proxy({} as Record<string, unknown>, {
        get: (_t, table) => {
          if (table === "channels") {
            return {
              findFirst: async () => ({
                id: CHANNEL,
                channelType: "thread",
                status: "active",
                assignedAgentId: null,
                contextObjectType: null,
                contextObjectId: null,
              }),
            };
          }
          if (table === "sessions") {
            return { findFirst: async () => ({ id: "memory-session" }) };
          }
          if (table === "focusSessions") {
            return {
              findFirst: async () => undefined,
              findMany: async () => [],
            };
          }
          if (table === "messages") {
            return {
              findFirst: async () => undefined,
              findMany: async () => state.readRows,
            };
          }
          return { findFirst: async () => undefined, findMany: async () => [] };
        },
      }),
    },
  };
});

vi.mock("../../utils/emit-message-observation.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emitMessageObservation: async () => {
      throw new Error(STOP);
    },
  };
});

const visibility = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../../utils/proposal-visibility.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertProposalVisibleTo: (...args: unknown[]) => visibility(...args),
  };
});

const { channelsRouter } = await import("../channels.js");
const caller = () =>
  channelsRouter.createCaller({ userId: USER, authenticated: true } as never);

beforeEach(() => {
  state.messageRows = [];
  state.readRows = [];
  visibility.mockReset();
  visibility.mockImplementation(async () => {});
});

describe("sendMessage — anchored comment", () => {
  it("persists the anchor on the user message row", async () => {
    await expect(
      caller().sendMessage({
        channelId: CHANNEL,
        content: "this title is wrong",
        metadata: {
          anchor: { proposalId: PROPOSAL, opRef: "$e1", contentVersion: 2 },
        },
      })
    ).rejects.toThrow(STOP);

    expect(state.messageRows).toHaveLength(1);
    // The client anchor verbatim, plus the SERVER-resolved anchor on the one
    // turnContext contract (the same context the agent turn receives).
    expect(state.messageRows[0].metadata).toEqual({
      turnContext: {
        anchor: {
          version: 1,
          resolution: "resolved",
          proposalId: PROPOSAL,
          proposalStatus: "pending",
          opRef: "$e1",
          op: {
            index: 0,
            kind: "create_entity",
            title: "Old title",
            profileSlug: "task",
            fieldKeys: ["status"],
          },
          field: null,
          contentVersion: 2,
          currentVersion: 2,
          stale: false,
          comment: "this title is wrong",
        },
      },
      anchor: { proposalId: PROPOSAL, opRef: "$e1", contentVersion: 2 },
    });
    expect(visibility).toHaveBeenCalledWith(PROPOSAL, USER, expect.anything());
  });

  it("refuses an anchor naming a proposal the caller cannot see — no row", async () => {
    visibility.mockImplementation(async () => {
      throw new TRPCError({ code: "FORBIDDEN", message: "not yours" });
    });
    await expect(
      caller().sendMessage({
        channelId: CHANNEL,
        content: "sneaky",
        metadata: { anchor: { proposalId: PROPOSAL, contentVersion: 0 } },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.messageRows).toHaveLength(0);
  });

  it("refuses unknown metadata keys at the input — no row", async () => {
    await expect(
      caller().sendMessage({
        channelId: CHANNEL,
        content: "sneaky",
        metadata: {
          anchor: { contentVersion: 0 },
          attachments: [{ id: "forged" }],
        } as never,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.messageRows).toHaveLength(0);
  });

  it("a send WITHOUT metadata writes the same row as before (no metadata key)", async () => {
    await expect(
      caller().sendMessage({ channelId: CHANNEL, content: "plain" })
    ).rejects.toThrow(STOP);

    expect(state.messageRows).toHaveLength(1);
    const row = state.messageRows[0];
    expect(Object.keys(row).sort()).toEqual(
      [
        "channelId",
        "content",
        "ephemeral",
        "hash",
        "id",
        "previousHash",
        "role",
        "sessionId",
        "userId",
      ].sort()
    );
    expect(visibility).not.toHaveBeenCalled();
  });

  it("turnContext and an anchor are stored side by side", async () => {
    await expect(
      caller().sendMessage({
        channelId: CHANNEL,
        content: "both",
        turnContext: { entries: [{ key: "viewMode", value: "room" }] },
        metadata: { anchor: { contentVersion: 0, field: "title" } },
      })
    ).rejects.toThrow(STOP);
    expect(state.messageRows[0].metadata).toEqual({
      // Caller entries kept verbatim; the server-built anchor rides beside them.
      turnContext: {
        entries: [{ key: "viewMode", value: "room" }],
        anchor: {
          version: 1,
          resolution: "no_proposal",
          proposalId: null,
          proposalStatus: null,
          opRef: null,
          op: null,
          field: "title",
          contentVersion: 0,
          currentVersion: null,
          stale: false,
          comment: "both",
        },
      },
      anchor: { contentVersion: 0, field: "title" },
    });
  });
});

describe("getMessages — the anchor reads back", () => {
  it("returns metadata.anchor on the message", async () => {
    state.readRows = [
      {
        id: "m1",
        channelId: CHANNEL,
        content: "this title is wrong",
        metadata: { anchor: { proposalId: PROPOSAL, contentVersion: 2 } },
      },
    ];
    const page = await caller().getMessages({ threadId: CHANNEL });
    expect(page.messages[0]).toMatchObject({
      metadata: { anchor: { proposalId: PROPOSAL, contentVersion: 2 } },
    });
  });
});

// Non-vacuity: the insert capture is keyed on the real `messages` table object.
expect(messagesTable).toBeDefined();
