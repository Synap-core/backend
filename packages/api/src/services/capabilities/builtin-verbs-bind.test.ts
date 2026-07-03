import { describe, it, expect, vi, beforeEach } from "vitest";

// channel.bind (W6 write half) — binds an EXISTING channel to a context object
// (the inbound-first case). It must (a) load the target channel, (b) enforce the
// acting-workspace + membership floors, and (c) delegate the write to the GOVERNED
// updateChannel caller (never a raw UPDATE). We mock the db channel lookup, the
// membership floor, and the channelsRouter so we can assert the delegation.
const h = vi.hoisted(() => ({
  channelRow: vi.fn(),
  membership: vi.fn(),
  updateChannel: vi.fn(),
}));

vi.mock("@synap/database", () => {
  const mk = (name: string) =>
    new Proxy(
      { __table: name },
      { get: (t, p) => (p in t ? (t as never)[p] : `${name}.${String(p)}`) }
    );
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(h.channelRow()) }),
        }),
      }),
    },
    eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
    and: (...xs: unknown[]) => ({ op: "and", xs }),
    or: (...xs: unknown[]) => ({ op: "or", xs }),
    isNull: (col: unknown) => ({ op: "isNull", col }),
    desc: (col: unknown) => ({ op: "desc", col }),
    channels: mk("channels"),
    views: mk("views"),
    entities: mk("entities"),
    relations: mk("relations"),
    messages: mk("messages"),
    getWorkspaceMembership: h.membership,
    insertChannelMessage: vi.fn(),
  };
});

// The governed write home — the handler dynamically imports this.
vi.mock("../../routers/channels.js", () => ({
  channelsRouter: {
    createCaller: () => ({ updateChannel: h.updateChannel }),
  },
}));

// Keep module-load deps happy (mirror builtin-verbs-read.test.ts).
vi.mock("../../access/index.js", () => ({
  AccessContext: { operator: () => ({ withLens: () => ({}) }) },
  scopedDb: () => ({ findMany: vi.fn(), findFirst: vi.fn() }),
}));
vi.mock("./place-artboard-deck.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./place-artboard-deck.js")>();
  return { ...actual, placeArtboardDeck: vi.fn() };
});
vi.mock("../mail-feed/triage.js", () => ({ triageEmails: vi.fn() }));
vi.mock("../../utils/resolve-or-create-channel.js", () => ({
  resolveOrCreateChannel: vi.fn(),
  CONTEXT_OBJECT_TYPE_VALUES: ["workspace", "entity", "document", "view"],
}));

import { BUILTIN_VERBS, READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";

const CH_ID = "11111111-1111-4111-8111-111111111111";
const ENTITY_ID = "22222222-2222-4222-8222-222222222222";
const WS = "99999999-9999-4999-8999-999999999999";

describe("channel.bind — registry", () => {
  it("is registered and is NOT read-only (flows through the full gate)", () => {
    expect(typeof BUILTIN_VERBS["channel.bind"]).toBe("function");
    expect(READ_ONLY_BUILTIN_VERBS.has("channel.bind")).toBe(false);
  });
});

describe("channel.bind — delegation + guards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates the bind to the governed updateChannel caller", async () => {
    h.channelRow.mockReturnValue([{ id: CH_ID, workspaceId: WS }]);
    h.membership.mockResolvedValue({ role: "member" });
    h.updateChannel.mockResolvedValue({ success: true });

    const out = (await BUILTIN_VERBS["channel.bind"](
      {
        channelId: CH_ID,
        contextObjectType: "entity",
        contextObjectId: ENTITY_ID,
        branchPurpose: "client-comms",
      },
      { userId: "u1", workspaceId: WS }
    )) as { bound: boolean; channelId: string };

    expect(out).toEqual({ bound: true, channelId: CH_ID });
    // The write went through the governed caller with the bind fields.
    expect(h.updateChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CH_ID,
        contextObjectType: "entity",
        contextObjectId: ENTITY_ID,
        branchPurpose: "client-comms",
      })
    );
  });

  it("throws NOT_FOUND when the channel does not exist", async () => {
    h.channelRow.mockReturnValue([]);
    await expect(
      BUILTIN_VERBS["channel.bind"](
        {
          channelId: CH_ID,
          contextObjectType: "entity",
          contextObjectId: ENTITY_ID,
        },
        { userId: "u1", workspaceId: WS }
      )
    ).rejects.toThrow(/not found/i);
    expect(h.updateChannel).not.toHaveBeenCalled();
  });

  it("refuses a channel outside the acting workspace (FORBIDDEN)", async () => {
    h.channelRow.mockReturnValue([{ id: CH_ID, workspaceId: WS }]);
    await expect(
      BUILTIN_VERBS["channel.bind"](
        {
          channelId: CH_ID,
          contextObjectType: "entity",
          contextObjectId: ENTITY_ID,
        },
        { userId: "u1", workspaceId: "00000000-0000-4000-8000-000000000000" }
      )
    ).rejects.toThrow();
    expect(h.updateChannel).not.toHaveBeenCalled();
  });
});
