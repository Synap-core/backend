import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the governed delegation targets so we can assert the builtin handlers
// route THROUGH them (never raw-insert): the channels router caller for
// channel.create, and the mirror-preserving insertChannelMessage for feed.post.
// Hoisted state lets the vi.mock factories (which run first) share mutable fixtures.
const h = vi.hoisted(() => ({
  channelRow: { id: "ch1", workspaceId: "ws1" as string | null } as {
    id: string;
    workspaceId: string | null;
  } | null,
  // Board row returned by the views lookup in output.generate's boardId∈workspace
  // guard. Null = board not found in the acting workspace.
  boardRow: { id: "board-1" } as { id: string } | null,
  getWorkspaceMembership: vi.fn(
    async () => ({ role: "owner" }) as { role: string } | null
  ),
  insertChannelMessage: vi.fn(async () => ({
    messageId: "m1",
    mirrored: true,
  })),
  createChannel: vi.fn(async () => ({ channelId: "ch-new" })),
  createCaller: vi.fn(),
  placeArtboardDeck: vi.fn(() => ({ viewId: "board-1", slideCount: 2 })),
  triageEmails: vi.fn(async () => []),
}));

vi.mock("@synap/database", () => {
  const channels = {};
  const views = {};
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () =>
              table === views
                ? h.boardRow
                  ? [h.boardRow]
                  : []
                : h.channelRow
                  ? [h.channelRow]
                  : [],
          }),
        }),
      }),
    },
    eq: () => undefined,
    and: () => undefined,
    channels,
    views,
    getWorkspaceMembership: h.getWorkspaceMembership,
    insertChannelMessage: h.insertChannelMessage,
  };
});

vi.mock("../../routers/channels.js", () => ({
  channelsRouter: {
    createCaller: (...args: unknown[]) => {
      h.createCaller(...args);
      return { createChannel: h.createChannel };
    },
  },
}));

// Mock only the emit (placeArtboardDeck); keep the REAL zod schemas the handler
// uses at module load (ArtboardDeckSlideSchema / BoardPlacementOptionsSchema).
vi.mock("./place-artboard-deck.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./place-artboard-deck.js")>();
  return { ...actual, placeArtboardDeck: h.placeArtboardDeck };
});

vi.mock("../mail-feed/triage.js", () => ({ triageEmails: h.triageEmails }));

import { BUILTIN_VERBS } from "./builtin-verbs.js";

const ctx = { userId: "u1", workspaceId: "ws1" };
const CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const BOARD_ID = "22222222-2222-4222-8222-222222222222";

describe("BUILTIN_VERBS registry", () => {
  it("registers channel.create, feed.post, and output.generate", () => {
    expect(typeof BUILTIN_VERBS["channel.create"]).toBe("function");
    expect(typeof BUILTIN_VERBS["feed.post"]).toBe("function");
    expect(typeof BUILTIN_VERBS["output.generate"]).toBe("function");
  });
});

describe("channel.create handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getWorkspaceMembership.mockResolvedValue({ role: "owner" });
  });

  it("delegates to the governed createChannel caller with the operator identity", async () => {
    const out = await BUILTIN_VERBS["channel.create"]({ title: "Hi" }, ctx);

    expect(out).toEqual({ channelId: "ch-new" });
    // Membership rebuilt for the acting (workspaceId, operator) pair.
    expect(h.getWorkspaceMembership).toHaveBeenCalledWith(
      expect.anything(),
      "ws1",
      "u1"
    );
    // Caller ctx carries the operator identity + resolved role.
    const callerCtx = h.createCaller.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(callerCtx).toMatchObject({
      userId: "u1",
      workspaceId: "ws1",
      workspaceRole: "owner",
      authenticated: true,
    });
    expect(h.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Hi" })
    );
  });

  it("rejects a pod-wide run (channels are workspace-scoped)", async () => {
    await expect(
      BUILTIN_VERBS["channel.create"]({}, { userId: "u1", workspaceId: null })
    ).rejects.toThrow();
    expect(h.createChannel).not.toHaveBeenCalled();
  });

  it("rejects when the operator has no workspace access", async () => {
    h.getWorkspaceMembership.mockResolvedValueOnce(null);
    await expect(BUILTIN_VERBS["channel.create"]({}, ctx)).rejects.toThrow();
    expect(h.createChannel).not.toHaveBeenCalled();
  });
});

describe("feed.post handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.channelRow = { id: "ch1", workspaceId: "ws1" };
  });

  it("delegates to insertChannelMessage (mirror-preserving) with the operator identity", async () => {
    const out = await BUILTIN_VERBS["feed.post"](
      { channelId: CHANNEL_ID, content: "hello" },
      ctx
    );

    expect(out).toEqual({ messageId: "m1", mirrored: true });
    expect(h.insertChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CHANNEL_ID,
        content: "hello",
        userId: "u1",
      })
    );
  });

  it("throws NOT_FOUND when the channel does not exist", async () => {
    h.channelRow = null;
    await expect(
      BUILTIN_VERBS["feed.post"]({ channelId: CHANNEL_ID, content: "x" }, ctx)
    ).rejects.toThrow();
    expect(h.insertChannelMessage).not.toHaveBeenCalled();
  });

  it("rejects a channel outside the acting workspace", async () => {
    h.channelRow = { id: "ch1", workspaceId: "other-ws" };
    await expect(
      BUILTIN_VERBS["feed.post"]({ channelId: CHANNEL_ID, content: "x" }, ctx)
    ).rejects.toThrow();
    expect(h.insertChannelMessage).not.toHaveBeenCalled();
  });
});

describe("output.generate handler", () => {
  const deckArgs = {
    boardId: BOARD_ID,
    preset: "carousel",
    title: "Deck",
    slides: [{ html: "<h1>1</h1>" }, { html: "<h1>2</h1>", title: "Two" }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h.getWorkspaceMembership.mockResolvedValue({ role: "owner" });
    h.placeArtboardDeck.mockReturnValue({ viewId: BOARD_ID, slideCount: 2 });
  });

  it("delegates to the shared placeArtboardDeck emit after a membership check", async () => {
    const out = await BUILTIN_VERBS["output.generate"](deckArgs, ctx);

    expect(out).toEqual({ boardId: BOARD_ID, slideCount: 2 });
    // Membership verified for the acting (workspaceId, operator) pair.
    expect(h.getWorkspaceMembership).toHaveBeenCalledWith(
      expect.anything(),
      "ws1",
      "u1"
    );
    // Emit goes through the SHARED function with the deck resource shape.
    expect(h.placeArtboardDeck).toHaveBeenCalledWith(
      expect.objectContaining({
        viewId: BOARD_ID,
        deck: expect.objectContaining({
          preset: "carousel",
          title: "Deck",
          slides: deckArgs.slides,
        }),
      })
    );
  });

  it("rejects a pod-wide run (placement is workspace-scoped)", async () => {
    await expect(
      BUILTIN_VERBS["output.generate"](deckArgs, {
        userId: "u1",
        workspaceId: null,
      })
    ).rejects.toThrow();
    expect(h.placeArtboardDeck).not.toHaveBeenCalled();
  });

  it("rejects when the operator has no workspace access", async () => {
    h.getWorkspaceMembership.mockResolvedValueOnce(null);
    await expect(
      BUILTIN_VERBS["output.generate"](deckArgs, ctx)
    ).rejects.toThrow();
    expect(h.placeArtboardDeck).not.toHaveBeenCalled();
  });

  it("rejects malformed args (empty slides)", async () => {
    await expect(
      BUILTIN_VERBS["output.generate"](
        { boardId: BOARD_ID, preset: "carousel", slides: [] },
        ctx
      )
    ).rejects.toThrow();
    expect(h.placeArtboardDeck).not.toHaveBeenCalled();
  });

  it("rejects a board that is not in the acting workspace", async () => {
    h.boardRow = null; // views lookup finds no board in ctx.workspaceId
    await expect(
      BUILTIN_VERBS["output.generate"](deckArgs, ctx)
    ).rejects.toThrow();
    expect(h.placeArtboardDeck).not.toHaveBeenCalled();
    h.boardRow = { id: "board-1" }; // restore for any later tests
  });
});
