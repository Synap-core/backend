/**
 * message-anchor — the shape and authority contract for an anchored comment.
 *
 * DB-FREE: the validator takes its `db`, and the proposal-visibility SSOT gate
 * is replaced (partially — `importOriginal` keeps every other export real) so
 * these observe what the ANCHOR check decides, not the membership lookup the
 * visibility gate owns (tested in its own suite).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const visibility = vi.fn(async (..._args: unknown[]) => {});
vi.mock("./proposal-visibility.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertProposalVisibleTo: (...args: unknown[]) => visibility(...args),
  };
});

const {
  assertMessageAnchorAllowed,
  ChannelMessageMetadataInputSchema,
  MessageAnchorSchema,
} = await import("./message-anchor.js");

const USER = "0aaaaaaa-0000-4000-8000-000000000001";
const CHANNEL = "0bbbbbbb-0000-4000-8000-000000000002";
const PROPOSAL = "0ccccccc-0000-4000-8000-000000000003";
const SESSION = "0ddddddd-0000-4000-8000-000000000004";
const OTHER_SESSION = "0eeeeeee-0000-4000-8000-000000000005";

const state = {
  channelSessions: [] as Array<{ id: string }>,
  proposal: undefined as { sessionId: string | null } | undefined,
};
const fakeDb = {
  query: {
    focusSessions: { findMany: async () => state.channelSessions },
    proposals: { findFirst: async () => state.proposal },
  },
} as never;

beforeEach(() => {
  visibility.mockReset();
  visibility.mockImplementation(async () => {});
  state.channelSessions = [];
  state.proposal = undefined;
});

describe("anchor shape", () => {
  it("accepts a full anchor and a version-only anchor", () => {
    expect(
      MessageAnchorSchema.safeParse({
        proposalId: PROPOSAL,
        opRef: "$rel0",
        field: "title",
        contentVersion: 2,
      }).success
    ).toBe(true);
    expect(MessageAnchorSchema.safeParse({ contentVersion: 0 }).success).toBe(
      true
    );
  });

  it("refuses unknown keys at BOTH levels, bad versions, and unbounded strings", () => {
    // Only `anchor` is client-writable metadata; server-owned keys are refused.
    expect(
      ChannelMessageMetadataInputSchema.safeParse({
        anchor: { contentVersion: 0 },
        turnContext: { entries: [] },
      }).success
    ).toBe(false);
    expect(
      MessageAnchorSchema.safeParse({ contentVersion: 0, extra: true }).success
    ).toBe(false);
    expect(MessageAnchorSchema.safeParse({}).success).toBe(false);
    expect(MessageAnchorSchema.safeParse({ contentVersion: -1 }).success).toBe(
      false
    );
    expect(MessageAnchorSchema.safeParse({ contentVersion: 1.5 }).success).toBe(
      false
    );
    expect(
      MessageAnchorSchema.safeParse({
        contentVersion: 0,
        opRef: "x".repeat(201),
      }).success
    ).toBe(false);
    expect(
      MessageAnchorSchema.safeParse({ contentVersion: 0, field: "   " }).success
    ).toBe(false);
    expect(
      MessageAnchorSchema.safeParse({ contentVersion: 0, proposalId: "nope" })
        .success
    ).toBe(false);
  });
});

describe("anchor authority", () => {
  it("an anchor without a proposal needs no proposal check", async () => {
    await assertMessageAnchorAllowed({
      anchor: { contentVersion: 0, field: "title" },
      channelId: CHANNEL,
      userId: USER,
      db: fakeDb,
    });
    expect(visibility).not.toHaveBeenCalled();
  });

  it("an anchor naming a proposal the caller cannot see is refused", async () => {
    visibility.mockImplementation(async () => {
      throw new TRPCError({ code: "FORBIDDEN", message: "no" });
    });
    await expect(
      assertMessageAnchorAllowed({
        anchor: { proposalId: PROPOSAL, contentVersion: 0 },
        channelId: CHANNEL,
        userId: USER,
        db: fakeDb,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(visibility).toHaveBeenCalledWith(PROPOSAL, USER, { db: fakeDb });
  });

  it("on a session channel, a proposal of ANOTHER run is refused", async () => {
    state.channelSessions = [{ id: SESSION }];
    state.proposal = { sessionId: OTHER_SESSION };
    await expect(
      assertMessageAnchorAllowed({
        anchor: { proposalId: PROPOSAL, contentVersion: 0 },
        channelId: CHANNEL,
        userId: USER,
        db: fakeDb,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("on a session channel, a proposal with NO session is refused", async () => {
    state.channelSessions = [{ id: SESSION }];
    state.proposal = { sessionId: null };
    await expect(
      assertMessageAnchorAllowed({
        anchor: { proposalId: PROPOSAL, contentVersion: 0 },
        channelId: CHANNEL,
        userId: USER,
        db: fakeDb,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("on a session channel, the session's own visible proposal is allowed", async () => {
    state.channelSessions = [{ id: SESSION }];
    state.proposal = { sessionId: SESSION };
    await expect(
      assertMessageAnchorAllowed({
        anchor: { proposalId: PROPOSAL, contentVersion: 3 },
        channelId: CHANNEL,
        userId: USER,
        db: fakeDb,
      })
    ).resolves.toBeUndefined();
  });

  it("on a non-session channel, a visible proposal is allowed", async () => {
    state.channelSessions = [];
    await expect(
      assertMessageAnchorAllowed({
        anchor: { proposalId: PROPOSAL, contentVersion: 0 },
        channelId: CHANNEL,
        userId: USER,
        db: fakeDb,
      })
    ).resolves.toBeUndefined();
  });
});
