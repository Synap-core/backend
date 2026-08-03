/**
 * messages_query WAVE 2 — the "gathering primitive" fan-out + access-floor proof.
 *
 * Extends the single-channel `messages_query` source node so it can gather a
 * client entity's FULL conversation context across ALL bound channels + linked
 * documents. The claims under test:
 *
 *   (a) DEFAULT (`scope` omitted / "single-external") returns the single
 *       EXTERNAL client-comms channel's history UNCHANGED — no `source` tags, no
 *       `channels`/`truncated`/`documents` keys — i.e. byte-for-byte back-compat,
 *       and it picks EXTERNAL over the co-bound team THREAD.
 *   (b) `scope: "all-channels"` gathers messages from EVERY bound channel, merged
 *       chronologically, each tagged with its `source` channel.
 *   (c) `includeDocuments: true` pulls the entity's own body doc + linked-entity
 *       body docs (title + preview body).
 *   (d) THE ACCESS FLOOR HOLDS — a channel in ANOTHER workspace is excluded from
 *       the fan-out. This is proved by evaluating the REAL predicate the executor
 *       builds against a fixture channels table (the channel-message-scope.test.ts
 *       pattern): operators are tagged-node trees, columns are identified by
 *       REFERENCE to the actual schema, so the test cannot drift into
 *       re-implementing the code.
 *
 * No live DB: `@synap/database` is mocked; the executor module imports cleanly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;
type Node = any;

const mocks = (globalThis as any).__mq_mocks__ ?? {
  channels: [] as Row[],
  messages: [] as Row[],
  links: [] as Row[],
  entities: [] as Row[],
  documents: [] as Row[],
  docBodies: {} as Record<string, string>,
  colGet: new Map<unknown, (r: Row) => unknown>(),
};
(globalThis as any).__mq_mocks__ = mocks;

function colValue(col: unknown, row: Row): unknown {
  const get = mocks.colGet.get(col);
  if (!get) throw new Error("predicate referenced an unmapped column");
  return get(row);
}

/** Evaluate the tagged predicate tree the executor actually built. */
function evalNode(node: Node, row: Row): boolean {
  if (node === undefined || node === null) return true; // dropped filter
  switch (node._tag) {
    case "and":
      return node.parts.every((p: Node) => evalNode(p, row));
    case "or":
      return node.parts.some((p: Node) => evalNode(p, row));
    case "eq":
      return colValue(node.col, row) === node.val;
    case "isNull": {
      const v = colValue(node.col, row);
      return v === null || v === undefined;
    }
    case "inArray":
      return node.vals.includes(colValue(node.col, row));
    default:
      throw new Error(`evalNode: unhandled tag ${node?._tag}`);
  }
}

/** Minimal thenable select-builder for the two `db.select()` read paths. */
class SelectBuilder {
  private table: Row[] = [];
  private _where: Node = undefined;
  private _limit: number | undefined;
  private _sortMessages = false;
  from(tbl: Row[]) {
    this.table = tbl;
    return this;
  }
  where(w: Node) {
    this._where = w;
    return this;
  }
  orderBy(o: Node) {
    // Only the default message read sorts (desc timestamp).
    if (o && o._tag === "desc") this._sortMessages = true;
    return this;
  }
  limit(n: number) {
    this._limit = n;
    return this;
  }
  private exec(): Row[] {
    let rows = this.table.filter((r) => evalNode(this._where, r));
    if (this._sortMessages)
      rows = [...rows].sort(
        (a, b) =>
          new Date(b.timestamp as Date).getTime() -
          new Date(a.timestamp as Date).getTime()
      );
    if (this._limit !== undefined) rows = rows.slice(0, this._limit);
    return rows;
  }
  then<T>(resolve: (v: Row[]) => T) {
    return Promise.resolve(this.exec()).then(resolve);
  }
}

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const m = (globalThis as any).__mq_mocks__;
  const g = m.colGet as Map<unknown, (r: Row) => unknown>;
  // Column identity → fixture accessor (fixtures are camelCase).
  g.set(actual.channels.id, (r) => r.id);
  g.set(actual.channels.workspaceId, (r) => r.workspaceId);
  g.set(actual.channels.contextObjectType, (r) => r.contextObjectType);
  g.set(actual.channels.contextObjectId, (r) => r.contextObjectId);
  g.set(actual.channels.channelType, (r) => r.channelType);
  g.set(actual.channels.branchPurpose, (r) => r.branchPurpose);
  g.set(actual.messages.channelId, (r) => r.channelId);
  g.set(actual.messages.deletedAt, (r) => r.deletedAt ?? null);
  g.set(actual.messages.ephemeral, (r) => r.ephemeral ?? false);
  g.set(actual.messages.timestamp, (r) => r.timestamp);
  g.set(actual.links.workspaceId, (r) => r.workspaceId);
  g.set(actual.links.fromType, (r) => r.fromType);
  g.set(actual.links.fromId, (r) => r.fromId);
  g.set(actual.links.toType, (r) => r.toType);
  g.set(actual.links.toId, (r) => r.toId);
  g.set(actual.documents.id, (r) => r.id);
  g.set(actual.documents.workspaceId, (r) => r.workspaceId);
  g.set(actual.documents.deletedAt, (r) => r.deletedAt ?? null);
  g.set(actual.entities.id, (r) => r.id);
  g.set(actual.entities.workspaceId, (r) => r.workspaceId ?? null);
  g.set(actual.entities.deletedAt, (r) => r.deletedAt ?? null);

  // Table identity so `.from(x)` knows which fixture to scan.
  const CHANNELS = actual.channels;
  const MESSAGES = actual.messages;
  const LINKS = actual.links;

  const filterMany = (rows: Row[], where: Node) =>
    rows.filter((r) => evalNode(where, r));

  const db = {
    query: {
      channels: {
        findFirst: ({ where }: { where: Node }) =>
          Promise.resolve(filterMany(m.channels, where)[0]),
        findMany: ({ where, limit }: { where: Node; limit?: number }) => {
          let rows = filterMany(m.channels, where);
          if (limit !== undefined) rows = rows.slice(0, limit);
          return Promise.resolve(rows);
        },
      },
      messages: {
        findMany: ({ where, limit }: { where: Node; limit?: number }) => {
          let rows = filterMany(m.messages, where).sort(
            (a, b) =>
              new Date(b.timestamp as Date).getTime() -
              new Date(a.timestamp as Date).getTime()
          );
          if (limit !== undefined) rows = rows.slice(0, limit);
          return Promise.resolve(rows);
        },
      },
      entities: {
        findMany: ({ where }: { where: Node }) =>
          Promise.resolve(filterMany(m.entities, where)),
      },
      documents: {
        findMany: ({ where, limit }: { where: Node; limit?: number }) => {
          let rows = filterMany(m.documents, where);
          if (limit !== undefined) rows = rows.slice(0, limit);
          return Promise.resolve(rows);
        },
      },
    },
    select: (_proj?: unknown) => {
      const b = new SelectBuilder();
      // Route `.from()` to the right fixture by table identity.
      const origFrom = b.from.bind(b);
      b.from = (tbl: unknown) => {
        if (tbl === MESSAGES) return origFrom(m.messages);
        if (tbl === LINKS) return origFrom(m.links);
        if (tbl === CHANNELS) return origFrom(m.channels);
        return origFrom([]);
      };
      return b;
    },
  };

  class EntityBodyService {
    constructor(_db: unknown, _ev: unknown) {}
    getPreview = (id: string) => Promise.resolve(m.docBodies[id] ?? null);
  }

  class ChannelRepository {
    constructor(_db: unknown) {}
  }
  class EntityRepository {
    constructor(_db: unknown) {}
  }

  return {
    ...actual,
    db,
    EntityBodyService,
    ChannelRepository,
    EntityRepository,
    eventRepository: {},
    // Tagged-node operators (variadic and/or drop undefined, like drizzle).
    and: (...parts: Node[]) => ({ _tag: "and", parts: parts.filter(Boolean) }),
    or: (...parts: Node[]) => ({ _tag: "or", parts: parts.filter(Boolean) }),
    eq: (col: unknown, val: unknown) => ({ _tag: "eq", col, val }),
    isNull: (col: unknown) => ({ _tag: "isNull", col }),
    inArray: (col: unknown, vals: unknown[]) => ({
      _tag: "inArray",
      col,
      vals,
    }),
    desc: (col: unknown) => ({ _tag: "desc", col }),
    // drizzleSql`${col} = ${val}` → an eq node (the channelType filter path).
    drizzleSql: (_strings: TemplateStringsArray, ...vals: unknown[]) => ({
      _tag: "eq",
      col: vals[0],
      val: vals[1],
    }),
  };
});

const { executeMessagesQueryStep } = await import("../automation-executor.js");

const WS_OWN = "ws-own";
const WS_OTHER = "ws-other";
const E1 = "11111111-1111-1111-1111-111111111111";
const E2 = "22222222-2222-2222-2222-222222222222";

const ctx = () => ({
  trigger: { payload: {} },
  steps: {},
  automation: { id: "auto-1", state: {} },
});

const ts = (iso: string) => new Date(iso);

beforeEach(() => {
  mocks.channels = [
    // Same entity E1: an EXTERNAL client-comms channel AND a team THREAD.
    {
      id: "ch-ext",
      workspaceId: WS_OWN,
      contextObjectType: "entity",
      contextObjectId: E1,
      channelType: "external",
      branchPurpose: "client-comms",
      title: "Client comms",
      updatedAt: ts("2026-08-01T10:00:00Z"),
    },
    {
      id: "ch-thread",
      workspaceId: WS_OWN,
      contextObjectType: "entity",
      contextObjectId: E1,
      channelType: "thread",
      branchPurpose: "team",
      title: "Team thread",
      updatedAt: ts("2026-08-01T09:00:00Z"),
    },
  ];
  mocks.messages = [
    // ch-ext (external) — two client messages.
    {
      channelId: "ch-ext",
      role: "user",
      content: "ext-1",
      metadata: { sender: { name: "Client" } },
      timestamp: ts("2026-08-01T08:00:00Z"),
      deletedAt: null,
      ephemeral: false,
    },
    {
      channelId: "ch-ext",
      role: "user",
      content: "ext-2",
      metadata: { sender: { name: "Client" } },
      timestamp: ts("2026-08-01T08:30:00Z"),
      deletedAt: null,
      ephemeral: false,
    },
    // ch-thread (team) — one internal note BETWEEN the two ext messages in time.
    {
      channelId: "ch-thread",
      role: "assistant",
      content: "thread-1",
      metadata: { sender: { name: "Teammate" } },
      timestamp: ts("2026-08-01T08:15:00Z"),
      deletedAt: null,
      ephemeral: false,
    },
  ];
  mocks.links = [];
  mocks.entities = [];
  mocks.documents = [];
  mocks.docBodies = {};
});

describe("messages_query — DEFAULT single-external is unchanged (claim a)", () => {
  it("returns ONLY the EXTERNAL channel history, chronological, no fan-out keys", async () => {
    const out = await executeMessagesQueryStep(
      { subjectEntityId: E1 },
      ctx() as any,
      WS_OWN
    );
    expect(out.channelId).toBe("ch-ext");
    expect(out.count).toBe(2);
    expect((out.messages as any[]).map((m) => m.content)).toEqual([
      "ext-1",
      "ext-2",
    ]);
    // author + ISO timestamp projection preserved
    expect((out.messages as any[])[0]).toMatchObject({
      role: "user",
      authorName: "Client",
      createdAt: "2026-08-01T08:00:00.000Z",
    });
    // NO fan-out superset keys, NO source tags — byte-for-byte back-compat.
    expect(out).not.toHaveProperty("channels");
    expect(out).not.toHaveProperty("truncated");
    expect(out).not.toHaveProperty("documents");
    expect((out.messages as any[])[0]).not.toHaveProperty("source");
  });
});

describe("messages_query — all-channels fan-out (claim b)", () => {
  it("gathers EVERY bound channel, merged chronologically, source-tagged", async () => {
    const out = await executeMessagesQueryStep(
      { subjectEntityId: E1, scope: "all-channels" },
      ctx() as any,
      WS_OWN
    );
    expect(out.channelId).toBeNull();
    expect(out.count).toBe(3);
    expect(out.truncated).toBe(false);
    // Merged chronologically ACROSS channels (ext 08:00, thread 08:15, ext 08:30).
    const msgs = out.messages as any[];
    expect(msgs.map((m) => m.content)).toEqual(["ext-1", "thread-1", "ext-2"]);
    // Each message attributed to its source channel.
    expect(msgs.map((m) => m.source.channelType)).toEqual([
      "external",
      "thread",
      "external",
    ]);
    expect(msgs[1].source).toMatchObject({
      channelId: "ch-thread",
      channelType: "thread",
      branchPurpose: "team",
    });
    // The gathered set is reported.
    expect((out.channels as any[]).map((c) => c.id).sort()).toEqual([
      "ch-ext",
      "ch-thread",
    ]);
  });

  it("channelTypes filter narrows the fan-out (external only)", async () => {
    const out = await executeMessagesQueryStep(
      {
        subjectEntityId: E1,
        scope: "all-channels",
        channelTypes: ["external"],
      },
      ctx() as any,
      WS_OWN
    );
    expect((out.channels as any[]).map((c) => c.id)).toEqual(["ch-ext"]);
    expect((out.messages as any[]).map((m) => m.content)).toEqual([
      "ext-1",
      "ext-2",
    ]);
  });
});

describe("messages_query — includeDocuments (claim c)", () => {
  it("gathers the entity's own body doc + linked-entity body docs, with preview body", async () => {
    // E1 owns doc D1; E1 --link--> E2, and E2 owns doc D2.
    mocks.entities = [
      {
        id: E1,
        title: "Acme",
        documentId: "D1",
        workspaceId: WS_OWN,
        deletedAt: null,
      },
      {
        id: E2,
        title: "Brief",
        documentId: "D2",
        workspaceId: WS_OWN,
        deletedAt: null,
      },
    ];
    mocks.links = [
      {
        workspaceId: WS_OWN,
        fromType: "entity",
        fromId: E1,
        toType: "entity",
        toId: E2,
      },
    ];
    mocks.documents = [
      { id: "D1", workspaceId: WS_OWN, title: "Acme profile", deletedAt: null },
      {
        id: "D2",
        workspaceId: WS_OWN,
        title: "Kickoff brief",
        deletedAt: null,
      },
    ];
    mocks.docBodies = { D1: "acme body text", D2: "brief body text" };

    const out = await executeMessagesQueryStep(
      { subjectEntityId: E1, includeDocuments: true },
      ctx() as any,
      WS_OWN
    );
    const docs = out.documents as any[];
    expect(docs.map((d) => d.documentId).sort()).toEqual(["D1", "D2"]);
    const d1 = docs.find((d) => d.documentId === "D1");
    expect(d1).toMatchObject({
      entityId: E1,
      title: "Acme profile",
      body: "acme body text",
    });
    // Default single-external message read still present alongside documents.
    expect(out.channelId).toBe("ch-ext");
  });
});

describe("messages_query — the ACCESS FLOOR holds (claim d)", () => {
  it("excludes a channel bound to the SAME entity in ANOTHER workspace", async () => {
    // A foreign-workspace channel on the same entity, with messages.
    mocks.channels.push({
      id: "ch-foreign",
      workspaceId: WS_OTHER,
      contextObjectType: "entity",
      contextObjectId: E1,
      channelType: "external",
      branchPurpose: "client-comms",
      title: "Leaked channel",
      updatedAt: ts("2026-08-01T11:00:00Z"),
    });
    mocks.messages.push({
      channelId: "ch-foreign",
      role: "user",
      content: "SECRET-cross-workspace",
      metadata: {},
      timestamp: ts("2026-08-01T08:45:00Z"),
      deletedAt: null,
      ephemeral: false,
    });

    const out = await executeMessagesQueryStep(
      { subjectEntityId: E1, scope: "all-channels" },
      ctx() as any,
      WS_OWN
    );
    // ch-foreign never enters the gathered set...
    expect((out.channels as any[]).map((c) => c.id)).not.toContain(
      "ch-foreign"
    );
    // ...and none of its messages leak into the merged history.
    const contents = (out.messages as any[]).map((m) => m.content);
    expect(contents).not.toContain("SECRET-cross-workspace");
    expect(out.count).toBe(3);
  });

  it("ephemeral recaps are never gathered into synthesis context", async () => {
    mocks.messages.push({
      channelId: "ch-ext",
      role: "assistant",
      content: "EPHEMERAL-recap",
      metadata: {},
      timestamp: ts("2026-08-01T08:50:00Z"),
      deletedAt: null,
      ephemeral: true,
    });
    const out = await executeMessagesQueryStep(
      { subjectEntityId: E1, scope: "all-channels" },
      ctx() as any,
      WS_OWN
    );
    expect((out.messages as any[]).map((m) => m.content)).not.toContain(
      "EPHEMERAL-recap"
    );
  });
});
