import { describe, it, expect, vi, beforeEach } from "vitest";

// Read/resolve half (W6). These verbs read THROUGH the access layer
// (`scopedDb(AccessContext…).findMany`) so a read is floored to the caller. We
// mock the access layer + @synap/database so we can assert (a) the read goes
// through scopedDb (never a raw cross-workspace select), (b) the AccessContext is
// narrowed to the acting workspace lens (the floor), and (c) the resolver returns
// the entity's bound channel.
const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  operator: vi.fn(),
  withLens: vi.fn(),
}));

// Mock the access layer: AccessContext.operator({userId}).withLens(lens) records
// the identity + lens; scopedDb(access).findMany/findFirst are the assertion seam.
vi.mock("../../access/index.js", () => ({
  AccessContext: {
    operator: (arg: { userId: string }) => {
      h.operator(arg);
      return {
        withLens: (lens: unknown) => {
          h.withLens(lens);
          return { __access: true, userId: arg.userId, lens };
        },
      };
    },
  },
  scopedDb: () => ({ findMany: h.findMany, findFirst: h.findFirst }),
}));

// Minimal @synap/database mock. Named table markers + capturing eq/and/or so we
// can inspect the WHERE the resolver builds. db is unused by these two reads.
vi.mock("@synap/database", () => {
  const mk = (name: string) =>
    new Proxy(
      { __table: name },
      { get: (t, p) => (p in t ? (t as never)[p] : `${name}.${String(p)}`) }
    );
  return {
    db: {},
    eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
    and: (...xs: unknown[]) => ({ op: "and", xs }),
    or: (...xs: unknown[]) => ({ op: "or", xs }),
    isNull: (col: unknown) => ({ op: "isNull", col }),
    desc: (col: unknown) => ({ op: "desc", col }),
    drizzleSql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({
      op: "sql",
      strings,
      vals,
    }),
    channels: mk("channels"),
    views: mk("views"),
    entities: mk("entities"),
    relations: mk("relations"),
    messages: mk("messages"),
    getWorkspaceMembership: vi.fn(),
    insertChannelMessage: vi.fn(),
    // entity.query's Kind+Facets scoping condition — stubbed to a marker value;
    // these tests assert the AccessContext lens, not the resulting SQL shape.
    profileSlugScopeConditionFromRows: vi.fn(() => ({
      op: "eq",
      val: "profile-scope",
    })),
  };
});

// Keep the artboard emit / triage / channel-create deps happy at module load.
vi.mock("./place-artboard-deck.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./place-artboard-deck.js")>();
  return { ...actual, placeArtboardDeck: vi.fn() };
});
vi.mock("../mail-feed/triage.js", () => ({ triageEmails: vi.fn() }));
// entity.query's facet-visibility + vocabulary-validation doors — real
// implementations hit `db.query.*` (the Drizzle relational API), which this
// file's minimal `@synap/database` mock does not model. Stub them so these
// tests exercise what they actually assert (the AccessContext lens the
// entities READ is scoped to), not the facet-resolution machinery.
vi.mock("../../utils/workspace-membership.js", () => ({
  resolveFacetVisibilityScope: vi.fn().mockResolvedValue({ userId: "u1" }),
}));
vi.mock("../../utils/assert-known-profile-slug.js", () => ({
  assertKnownProfileSlug: vi
    .fn()
    .mockResolvedValue([{ id: "profile-1", profileKind: "kind" }]),
}));
vi.mock("../../utils/resolve-or-create-channel.js", () => ({
  resolveOrCreateChannel: vi.fn(),
  CONTEXT_OBJECT_TYPE_VALUES: [
    "workspace",
    "entity",
    "document",
    "view",
    "project",
    "task",
    "user",
    "external",
  ],
}));

import { BUILTIN_VERBS, READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";

const ENTITY_ID = "33333333-3333-4333-8333-333333333333";

describe("W6 read/resolve verbs — registry", () => {
  it("registers all six verbs", () => {
    for (const v of [
      "entity.query",
      "channel.resolve",
      "channel.ensure",
      "graph.relations",
      "graph.link",
      "feed.read",
    ]) {
      expect(typeof BUILTIN_VERBS[v]).toBe("function");
    }
  });

  it("marks the reads (+ ai.generate pure-compute) as read-only (writes flow through the gate)", () => {
    expect([...READ_ONLY_BUILTIN_VERBS].sort()).toEqual([
      // ai.generate is pure compute (no mutation) → auto-runs like the reads.
      "ai.generate",
      "channel.resolve",
      // connector.health_check mutates NO graph data — it only emits deduped
      // operator reconnect notices — so it auto-runs unattended in a cron feed.
      "connector.health_check",
      "document.read",
      "entity.query",
      "entity_facet.list",
      "feed.read",
      "graph.relations",
      "market.search",
    ]);
    expect(READ_ONLY_BUILTIN_VERBS.has("channel.ensure")).toBe(false);
    expect(READ_ONLY_BUILTIN_VERBS.has("graph.link")).toBe(false);
    // The new entity/document WRITE verbs must NOT be read-only — they flow the
    // full capability gate (agent-without-grant → propose), never auto-run.
    expect(READ_ONLY_BUILTIN_VERBS.has("entity.create")).toBe(false);
    expect(READ_ONLY_BUILTIN_VERBS.has("entity.update")).toBe(false);
    expect(READ_ONLY_BUILTIN_VERBS.has("document.create")).toBe(false);
    expect(READ_ONLY_BUILTIN_VERBS.has("document.update")).toBe(false);
  });
});

describe("channel.resolve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the entity's bound channel, read through the access layer", async () => {
    h.findMany.mockResolvedValueOnce([
      { id: "ch-bound", channelType: "thread", updatedAt: new Date() },
      { id: "ch-old", channelType: "thread", updatedAt: new Date() },
    ]);

    const out = (await BUILTIN_VERBS["channel.resolve"](
      { contextObjectType: "entity", contextObjectId: ENTITY_ID },
      { userId: "u1", workspaceId: "ws1" }
    )) as { channelId: string | null; channels: unknown[] };

    // First (most-recent) row is the resolved channel.
    expect(out.channelId).toBe("ch-bound");
    expect(out.channels).toHaveLength(2);

    // Read went THROUGH scopedDb.findMany on the channels table (never a raw
    // cross-workspace select).
    const [table, opts] = h.findMany.mock.calls[0]!;
    expect((table as { __table: string }).__table).toBe("channels");
    // The WHERE resolves BY the entity's context binding.
    const anded = (opts as { where: { xs: Array<{ val: unknown }> } }).where.xs;
    expect(anded.some((c) => c.val === ENTITY_ID)).toBe(true);
  });

  it("returns channelId null when the entity has no bound channel", async () => {
    h.findMany.mockResolvedValueOnce([]);
    const out = (await BUILTIN_VERBS["channel.resolve"](
      { contextObjectType: "entity", contextObjectId: ENTITY_ID },
      { userId: "u1", workspaceId: "ws1" }
    )) as { channelId: string | null };
    expect(out.channelId).toBeNull();
  });
});

describe("entity.query — honors the workspace floor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scopes the read to the acting workspace lens via AccessContext", async () => {
    h.findMany.mockResolvedValueOnce([{ id: "e1" }, { id: "e2" }]);

    const out = (await BUILTIN_VERBS["entity.query"](
      { profileSlug: "task" },
      { userId: "u1", workspaceId: "ws1" }
    )) as { entities: unknown[]; count: number };

    expect(out.count).toBe(2);
    // Identity = the operator; floor = the acting workspace lens.
    expect(h.operator).toHaveBeenCalledWith({ userId: "u1" });
    expect(h.withLens).toHaveBeenCalledWith("ws1");
    // Read went through scopedDb.findMany on entities (auto-applies visibility).
    const [table] = h.findMany.mock.calls[0]!;
    expect((table as { __table: string }).__table).toBe("entities");
  });

  it("an explicit workspaceId param overrides the acting lens", async () => {
    const WS_OTHER = "44444444-4444-4444-8444-444444444444";
    h.findMany.mockResolvedValueOnce([]);
    await BUILTIN_VERBS["entity.query"](
      { profileSlug: "task", workspaceId: WS_OTHER },
      { userId: "u1", workspaceId: "ws1" }
    );
    expect(h.withLens).toHaveBeenCalledWith(WS_OTHER);
  });

  it("a pod-wide run (no workspace) uses the full user floor (undefined lens, not globals-only)", async () => {
    h.findMany.mockResolvedValueOnce([]);
    await BUILTIN_VERBS["entity.query"](
      { profileSlug: "task" },
      { userId: "u1", workspaceId: null }
    );
    expect(h.withLens).toHaveBeenCalledWith(undefined);
  });
});
