/**
 * The Library's READERS on a real Postgres (PGlite): `library.readers` and
 * `library.readWith`, driven through the service doors from real rows.
 *   - one item: the door's live offers, the one that read it marked current;
 *     a typed note has none (a true empty);
 *   - a group: only its WAITING items (needs a reader / title only / could
 *     not be read; not archived, not read) — one offer per reader, counted;
 *   - a failed reader lookup THROWS (never an empty list);
 *   - readWith: one job per item with the reader; a billed reader past
 *     today's budget is counted overBudget and NOT queued; foreign / no link /
 *     not-ready items are skipped; a queue that took nothing is an error.
 *
 * Stubbed, and why: the reader lookup (`listReadersForUrl`, own suites —
 * here a fake keyed by URL) and the queue send.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { documents, libraryGroups } from "@synap/database";
import type { UrlReaderOffer } from "@synap-core/types/url-read";
import {
  readsAllSpaces,
  type UrlReadersContext,
} from "../../capabilities/url-readers.js";
import { pgliteSchemaDdl } from "../../../__tests__/pglite-ddl.js";
import type {
  ImportItemMetadata,
  LibraryItemRead,
} from "@synap-core/types/imports";
import { libraryItemMetadata } from "./fixtures.js";
import {
  libraryCancelReadWith,
  libraryReaderAvailability,
  libraryReaders,
  libraryReadWith,
  type LibraryReadersDeps,
} from "../readers.js";
import { libraryRetryMedia } from "../retry-media.js";
import { listLibraryItems } from "../read-model.js";

const USER = "user-readers-1";
const OTHER = "user-readers-2";
const NOW = new Date("2026-10-15T09:00:00.000Z");
/** NOW + the default 7 consent days. */
const CONSENT_END = "2026-10-22T09:00:00.000Z";
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const BUILTIN: UrlReaderOffer = {
  readerId: "builtin",
  name: "Synap page reader",
  billing: "none",
  state: "ready",
};
const APIFY: UrlReaderOffer = {
  readerId: "capture_social_post",
  name: "Apify social reader",
  verbId: "capture_social_post",
  serviceId: "apify",
  billing: "account",
  state: "ready",
};

/** The door's offers per URL family (IG → Apify only; the web → built-in). */
function offersFor(url: string): UrlReaderOffer[] {
  return url.includes("instagram") ? [APIFY] : [BUILTIN];
}

let seq = 0;
async function item(over: {
  userId?: string;
  url?: string;
  status?: string;
  groupIds?: string[];
  archived?: boolean;
  read?: Record<string, unknown>;
}): Promise<string> {
  seq++;
  const meta = libraryItemMetadata({
    item: {
      title: `Item ${seq}`,
      stagedAt: NOW.toISOString(),
      source: (over.url
        ? { kind: "url", url: over.url }
        : { kind: "text" }) as ImportItemMetadata["source"],
    },
    curation: {
      decision: "keep",
      groupIds: over.groupIds ?? [],
      ...(over.archived ? { archivedAt: NOW.toISOString() } : {}),
    },
    ...(over.status || over.read
      ? {
          read: {
            status: (over.status ?? "read") as LibraryItemRead["status"],
            ...over.read,
          },
        }
      : {}),
  });
  const { rows } = await q<{ id: string }>(
    `insert into documents (user_id, title, type, metadata) values ($1, $2, 'text', $3::jsonb) returning id`,
    [over.userId ?? USER, `Item ${seq}`, JSON.stringify(meta)]
  );
  return rows[0]!.id;
}

async function group(userId = USER): Promise<string> {
  const { rows } = await q<{ id: string }>(
    `insert into library_groups (user_id, key, name, origin) values ($1, $2, 'Branding inspiration', 'user') returning id`,
    [userId, `g-${++seq}`]
  );
  return rows[0]!.id;
}

function fakeDeps(
  over: Partial<LibraryReadersDeps> & {
    /** The door's offers per URL (default {@link offersFor}); may throw. */
    offers?: (url: string) => UrlReaderOffer[];
  } = {}
) {
  const sent: unknown[] = [];
  const lookups: string[] = [];
  /** One entry per SOURCE LOAD (`readerLookup`): the lens it was loaded for. */
  const loads: UrlReadersContext[] = [];
  const offers = over.offers ?? offersFor;
  const deps: Partial<LibraryReadersDeps> = {
    listReaders: async (_ctx, url) => {
      lookups.push(url);
      return offers(url);
    },
    readerLookup: async (ctx) => {
      loads.push(ctx);
      return (url) => {
        lookups.push(url);
        return offers(url);
      };
    },
    enqueue: async (items) => {
      sent.push(...items);
      return items.length;
    },
    usedToday: async () => 0,
    perDay: () => 200,
    now: () => NOW,
    ...over,
  };
  return { deps, sent, lookups, loads };
}

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl([documents, libraryGroups]));
});
beforeEach(async () => {
  await h.client!.exec(`delete from documents; delete from library_groups;`);
});

describe("library.readers — one item", () => {
  it("the door's live offers; the reader that read it is current; a note has none", async () => {
    const ig = await item({
      url: "https://www.instagram.com/p/a",
      read: {
        reader: {
          id: "capture_social_post",
          name: "Apify social reader",
          billed: true,
          readAt: NOW.toISOString(),
        },
      },
    });
    const page = await item({
      url: "https://example.com/a",
      read: {
        reader: {
          id: "builtin:article",
          name: "Synap article reader",
          billed: false,
          readAt: NOW.toISOString(),
        },
      },
    });
    const note = await item({});
    const { deps } = fakeDeps();
    expect(await libraryReaders({ userId: USER, itemId: ig, deps })).toEqual({
      offers: [{ ...APIFY, current: true }],
    });
    // `builtin:<rung>` stamps are the `builtin` offer.
    expect(
      (await libraryReaders({ userId: USER, itemId: page, deps })).offers
    ).toEqual([{ ...BUILTIN, current: true }]);
    expect(await libraryReaders({ userId: USER, itemId: note, deps })).toEqual({
      offers: [],
    });
  });

  it("another person's item is NOT_FOUND", async () => {
    const theirs = await item({
      userId: OTHER,
      url: "https://www.instagram.com/p/x",
    });
    await expect(
      libraryReaders({ userId: USER, itemId: theirs, deps: fakeDeps().deps })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an item's readers are the PERSON's, every space (allSpaces), for readers AND readWith", async () => {
    // A pod-wide kept post (workspace_id NULL): a reader installed in a space
    // must be in view — the lookup asks for every space the person can see.
    const ig = await item({ url: "https://www.instagram.com/p/a" });
    const ctxs: unknown[] = [];
    const { deps } = fakeDeps({
      listReaders: async (ctx, url) => {
        ctxs.push(ctx);
        return offersFor(url);
      },
      readerLookup: async (ctx) => {
        ctxs.push(ctx);
        return offersFor;
      },
    });
    await libraryReaders({ userId: USER, itemId: ig, deps });
    await libraryReadWith({
      userId: USER,
      itemIds: [ig],
      readerId: APIFY.readerId,
      deps,
    });
    expect(ctxs).toEqual([
      { userId: USER, workspaceId: null, allSpaces: true },
      { userId: USER, workspaceId: null, allSpaces: true },
    ]);
  });

  it("an AGENT caller keeps the item's lens: never every space (item AND group)", async () => {
    // `readsAllSpaces` is false for an agent — the ctx the door gets
    // must carry the agent and must not ask for every space.
    const g = await group();
    const ig = await item({
      url: "https://www.instagram.com/p/a",
      status: "needs_file",
      groupIds: [g],
    });
    const ctxs: UrlReadersContext[] = [];
    const { deps } = fakeDeps({
      listReaders: async (ctx, url) => {
        ctxs.push(ctx);
        return offersFor(url);
      },
      readerLookup: async (ctx) => {
        ctxs.push(ctx);
        return offersFor;
      },
    });
    for (const caller of [
      { agentUserId: "agent-1" },
      { keyType: "is_internal" },
    ]) {
      ctxs.length = 0;
      await libraryReaders({ userId: USER, itemId: ig, caller, deps });
      await libraryReaders({ userId: USER, groupId: g, caller, deps });
      expect(ctxs).toHaveLength(2);
      for (const ctx of ctxs) {
        expect(readsAllSpaces(ctx)).toBe(false);
        expect(ctx).toMatchObject({ userId: USER, workspaceId: null });
      }
    }
    expect(ctxs[0]).toMatchObject({ allSpaces: false });
    // The person (no agent) still sees every space.
    ctxs.length = 0;
    await libraryReaders({ userId: USER, itemId: ig, caller: {}, deps });
    expect(readsAllSpaces(ctxs[0]!)).toBe(true);
  });

  it("a failed reader lookup is an ERROR, never an empty list", async () => {
    const ig = await item({ url: "https://www.instagram.com/p/a" });
    const { deps } = fakeDeps({
      listReaders: async () => {
        throw new Error("registry down");
      },
    });
    await expect(
      libraryReaders({ userId: USER, itemId: ig, deps })
    ).rejects.toThrow(/registry down/);
  });
});

describe("library.readers — a group's waiting items", () => {
  it("counts per reader over WAITING items only", async () => {
    const g = await group();
    const other = await group();
    for (const s of ["needs_file", "needs_file", "unreadable"]) {
      await item({
        url: `https://www.instagram.com/p/${seq}`,
        status: s,
        groupIds: [g],
      });
    }
    await item({
      url: "https://example.com/t",
      status: "title_only",
      groupIds: [g],
    });
    // Not waiting: read, never read yet, archived, another group, no link.
    await item({
      url: "https://www.instagram.com/p/r",
      status: "read",
      groupIds: [g],
    });
    await item({ url: "https://www.instagram.com/p/n", groupIds: [g] });
    await item({
      url: "https://www.instagram.com/p/z",
      status: "needs_file",
      groupIds: [g],
      archived: true,
    });
    await item({
      url: "https://www.instagram.com/p/o",
      status: "needs_file",
      groupIds: [other],
    });
    await item({ status: "unreadable", groupIds: [g] });

    const { deps, lookups } = fakeDeps();
    const res = await libraryReaders({ userId: USER, groupId: g, deps });
    expect(res).toEqual({
      offers: [
        { ...APIFY, count: 3 },
        { ...BUILTIN, count: 1 },
      ],
      waiting: 4,
      consented: 0,
    });
    expect(lookups).toHaveLength(4);
  });

  it("a foreign group is NOT_FOUND; a failed lookup on any item is an ERROR", async () => {
    const theirs = await group(OTHER);
    await expect(
      libraryReaders({ userId: USER, groupId: theirs, deps: fakeDeps().deps })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const g = await group();
    await item({
      url: "https://example.com/a",
      status: "title_only",
      groupIds: [g],
    });
    await item({
      url: "https://www.instagram.com/p/b",
      status: "needs_file",
      groupIds: [g],
    });
    const { deps } = fakeDeps({
      offers: (url) => {
        if (url.includes("instagram")) throw new Error("catalog cache down");
        return offersFor(url);
      },
    });
    await expect(
      libraryReaders({ userId: USER, groupId: g, deps })
    ).rejects.toThrow(/catalog cache down/);
    // A source load that fails is an error too.
    await expect(
      libraryReaders({
        userId: USER,
        groupId: g,
        deps: fakeDeps({
          readerLookup: async () => {
            throw new Error("registry down");
          },
        }).deps,
      })
    ).rejects.toThrow(/registry down/);
  });
});

describe("the whole Library's waiting items (`waiting: true`)", () => {
  /** Waiting items across groups and none, plus the ones that never count. */
  async function library() {
    const g = await group();
    const inGroup = await item({
      url: "https://www.instagram.com/p/g1",
      status: "needs_file",
      groupIds: [g],
    });
    const loose = await item({
      url: "https://www.instagram.com/p/l1",
      status: "unreadable",
    });
    const page = await item({
      url: "https://example.com/t",
      status: "title_only",
    });
    // Never counted: read, not read yet, archived, no link, another person's.
    await item({ url: "https://www.instagram.com/p/r", status: "read" });
    await item({ url: "https://www.instagram.com/p/n" });
    await item({
      url: "https://www.instagram.com/p/z",
      status: "needs_file",
      archived: true,
    });
    await item({ status: "unreadable" });
    await item({
      userId: OTHER,
      url: "https://www.instagram.com/p/o",
      status: "needs_file",
    });
    return { inGroup, loose, page };
  }

  it("readers: one offer per reader with its count over EVERY waiting item, for ONE source load", async () => {
    await library();
    const { deps, loads } = fakeDeps({
      listReaders: async () => {
        throw new Error("never one door read per item");
      },
    });
    expect(await libraryReaders({ userId: USER, waiting: true, deps })).toEqual(
      {
        offers: [
          { ...APIFY, count: 2 },
          { ...BUILTIN, count: 1 },
        ],
        waiting: 3,
        consented: 0,
      }
    );
    expect(loads).toEqual([
      { userId: USER, workspaceId: null, allSpaces: true },
    ]);
  });

  it("readWith: queues every waiting item that reader serves, the budget rules held", async () => {
    const { inGroup, loose } = await library();
    const { deps, sent } = fakeDeps({
      perDay: () => 200,
      usedToday: async () => 199,
    });
    const res = await libraryReadWith({
      userId: USER,
      waiting: true,
      readerId: APIFY.readerId,
      deps,
    });
    // Oldest first: one unit of room → the first queued, the second waits;
    // the page (not Apify's) and the note (no link) are skipped.
    expect(res).toEqual({
      queued: 1,
      overBudget: 1,
      skipped: 2,
      consentExpiresAt: CONSENT_END,
    });
    expect(sent).toEqual([
      { userId: USER, itemId: inGroup, reader: APIFY.readerId, force: true },
    ]);
    expect((await readOf(loose)).status).toBe("over_budget");
  });

  it("names nothing → BAD_REQUEST, never every item by accident", async () => {
    await expect(
      libraryReaders({ userId: USER, deps: fakeDeps().deps })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      libraryReadWith({
        userId: USER,
        readerId: "builtin",
        deps: fakeDeps().deps,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("library.readWith", () => {
  it("one job per waiting item with the reader; a billed reader past today's budget is overBudget, NOT queued", async () => {
    const g = await group();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        await item({
          url: `https://www.instagram.com/p/w${i}`,
          status: "needs_file",
          groupIds: [g],
        })
      );
    }
    // Already holding a unit from today: reuses it, costs no room.
    const stamped = await item({
      url: "https://www.instagram.com/p/stamped",
      status: "unreadable",
      groupIds: [g],
      read: { aiAt: new Date(NOW.getTime() - 3600_000).toISOString() },
    });
    // A web page: Apify does not read it.
    await item({
      url: "https://example.com/x",
      status: "title_only",
      groupIds: [g],
    });
    const { deps, sent } = fakeDeps({
      perDay: () => 200,
      usedToday: async () => 198,
    });
    const res = await libraryReadWith({
      userId: USER,
      groupId: g,
      readerId: APIFY.readerId,
      deps,
    });
    expect(res).toEqual({
      queued: 3,
      overBudget: 2,
      skipped: 1,
      consentExpiresAt: CONSENT_END,
    });
    expect(sent).toEqual([
      { userId: USER, itemId: ids[0], reader: APIFY.readerId, force: true },
      { userId: USER, itemId: ids[1], reader: APIFY.readerId, force: true },
      { userId: USER, itemId: stamped, reader: APIFY.readerId, force: true },
    ]);
  });

  it("a free reader never touches the budget", async () => {
    const a = await item({
      url: "https://example.com/a",
      status: "unreadable",
    });
    const { deps, sent } = fakeDeps({
      usedToday: async () => 9999,
      perDay: () => 0,
    });
    expect(
      await libraryReadWith({
        userId: USER,
        itemIds: [a],
        readerId: "builtin",
        deps,
      })
    ).toEqual({ queued: 1, overBudget: 0, skipped: 0 });
    expect(sent).toHaveLength(1);
  });

  it("skips foreign items, notes, and a reader that is not ready (install / enable are their own doors)", async () => {
    const mine = await item({ url: "https://www.instagram.com/p/m" });
    const note = await item({});
    const theirs = await item({
      userId: OTHER,
      url: "https://www.instagram.com/p/t",
    });
    const { deps, sent } = fakeDeps({
      offers: () => [{ ...APIFY, state: "install" }],
    });
    expect(
      await libraryReadWith({
        userId: USER,
        itemIds: [mine, note, theirs],
        readerId: APIFY.readerId,
        deps,
      })
    ).toEqual({ queued: 0, overBudget: 0, skipped: 3 });
    expect(sent).toEqual([]);
  });

  it("a queue that took nothing is an ERROR, never a quiet 'queued: 0'", async () => {
    const a = await item({ url: "https://www.instagram.com/p/q" });
    const { deps } = fakeDeps({ enqueue: async () => 0 });
    await expect(
      libraryReadWith({
        userId: USER,
        itemIds: [a],
        readerId: APIFY.readerId,
        deps,
      })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("a failed reader lookup is an ERROR (nothing queued)", async () => {
    const a = await item({ url: "https://www.instagram.com/p/q" });
    const { deps, sent } = fakeDeps({
      readerLookup: async () => {
        throw new Error("registry down");
      },
    });
    await expect(
      libraryReadWith({
        userId: USER,
        itemIds: [a],
        readerId: APIFY.readerId,
        deps,
      })
    ).rejects.toThrow(/registry down/);
    expect(sent).toEqual([]);
  });
});

async function readOf(id: string): Promise<Record<string, unknown>> {
  const { rows } = await q<{ r: Record<string, unknown> }>(
    `select metadata -> 'importRead' as r from documents where id = $1`,
    [id]
  );
  return rows[0]!.r;
}

describe("library.readWith — what today's budget cannot hold WAITS with the choice", () => {
  it("over budget → marked over_budget with the reader (the sweep reads it); a read item waits BESIDE its read", async () => {
    const waiting = await item({
      url: "https://www.instagram.com/p/wait",
      status: "needs_file",
      read: {
        blocked: { reason: "needs_reader", nextStep: "install_reader" },
        suggestedActions: [{ id: "date-0", kind: "date" }],
      },
    });
    const read = await item({
      url: "https://www.instagram.com/p/read",
      status: "read",
      read: { summary: "kept" },
    });
    const { deps, sent } = fakeDeps({ usedToday: async () => 200 });
    expect(
      await libraryReadWith({
        userId: USER,
        itemIds: [waiting, read],
        readerId: APIFY.readerId,
        deps,
      })
    ).toEqual({
      queued: 0,
      overBudget: 2,
      skipped: 0,
      consentExpiresAt: CONSENT_END,
    });
    expect(sent).toEqual([]);
    // The mark changes NOW (the client re-reads on settle) and the sweep has
    // the reader the person chose; why it was blocked and its chips are kept.
    expect(await readOf(waiting)).toMatchObject({
      status: "over_budget",
      requestedReader: APIFY.readerId,
      // The consent is dated (it ends 7 days later) and remembers where the
      // item goes back to when it ends.
      requestedAt: NOW.toISOString(),
      heldFrom: "needs_file",
      blocked: { reason: "needs_reader" },
      suggestedActions: [{ id: "date-0" }],
    });
    // Never masked by the wait: still `read` with its read, the consent
    // beside it (the result's "waits" is true for it too).
    expect(await readOf(read)).toEqual({
      status: "read",
      summary: "kept",
      suggestedActions: [],
      requestedReader: APIFY.readerId,
      requestedAt: NOW.toISOString(),
    });
  });

  it("a queued item is not marked; another person's item is never touched", async () => {
    const mine = await item({
      url: "https://www.instagram.com/p/m1",
      status: "needs_file",
    });
    const theirs = await item({
      userId: OTHER,
      url: "https://www.instagram.com/p/t1",
      status: "needs_file",
    });
    const { deps } = fakeDeps({ usedToday: async () => 199 });
    await libraryReadWith({
      userId: USER,
      itemIds: [mine, theirs],
      readerId: APIFY.readerId,
      deps,
    });
    expect((await readOf(mine)).status).toBe("needs_file");
    expect((await readOf(theirs)).status).toBe("needs_file");
  });
});

describe("the rows' reader bit (readerAvailable) — one lookup per lens, the preview's rule", () => {
  function lookupDeps(over: Partial<LibraryReadersDeps> = {}) {
    const loads: UrlReadersContext[] = [];
    const deps: Partial<LibraryReadersDeps> = {
      readerLookup: async (ctx) => {
        loads.push(ctx);
        return (url) => offersFor(url);
      },
      listReaders: async () => {
        throw new Error("a row must never ask the door one by one");
      },
      ...over,
    };
    return { deps, loads };
  }

  it("a needs-a-reader row says so in the LIST itself (the value arrives), for one source load", async () => {
    const ig = await item({
      url: "https://www.instagram.com/p/a",
      status: "needs_file",
    });
    const ig2 = await item({
      url: "https://www.instagram.com/p/b",
      status: "needs_file",
    });
    // Read by the only reader there is: nobody ELSE can serve it.
    const page = await item({
      url: "https://example.com/t",
      status: "title_only",
      read: {
        reader: {
          id: "builtin:article",
          name: "Synap article reader",
          billed: false,
          readAt: NOW.toISOString(),
        },
      },
    });
    // Not weak: never asked.
    const done = await item({
      url: "https://www.instagram.com/p/c",
      status: "read",
    });
    const note = await item({ status: "unreadable" });
    const { deps, loads } = lookupDeps();
    const { items } = await listLibraryItems({
      userId: USER,
      input: {},
      readerAvailability: libraryReaderAvailability({ userId: USER, deps }),
    });
    const bit = Object.fromEntries(items.map((i) => [i.id, i.readerAvailable]));
    expect(bit).toEqual({
      [ig]: true,
      [ig2]: true,
      [page]: false,
      [done]: undefined,
      [note]: undefined,
    });
    // Every row of the page (one lens) from ONE source load, as the person.
    expect(loads).toEqual([
      { userId: USER, workspaceId: null, allSpaces: true },
    ]);
  });

  it("an agent caller's bit is asked in the agent's lens", async () => {
    await item({ url: "https://www.instagram.com/p/a", status: "needs_file" });
    const { deps, loads } = lookupDeps();
    await listLibraryItems({
      userId: USER,
      input: {},
      readerAvailability: libraryReaderAvailability({
        userId: USER,
        caller: { agentUserId: "agent-1" },
        deps,
      }),
    });
    expect(readsAllSpaces(loads[0]!)).toBe(false);
  });

  it("a failed lookup leaves the bit UNKNOWN (absent) — never false, never a failed list", async () => {
    const ig = await item({
      url: "https://www.instagram.com/p/a",
      status: "needs_file",
    });
    const { deps } = lookupDeps({
      readerLookup: async () => {
        throw new Error("registry down");
      },
    });
    const { items } = await listLibraryItems({
      userId: USER,
      input: {},
      readerAvailability: libraryReaderAvailability({ userId: USER, deps }),
    });
    expect(items.map((i) => i.id)).toEqual([ig]);
    expect("readerAvailable" in items[0]!).toBe(false);
  });
});

describe("library.retryMedia — the person's Try again on the pictures", () => {
  const FAILED = {
    importMediaFailed: 1,
    importMediaFailures: [
      {
        sourceUrl: "https://cdn.test/a.jpg",
        kind: "image",
        reason: "http_4xx",
        attempts: 3,
        lastAttemptAt: NOW.toISOString(),
      },
    ],
  };
  async function withMedia(userId = USER, extra: object = FAILED) {
    const id = await item({ userId, url: "https://www.instagram.com/p/m" });
    await q(
      `update documents set metadata = metadata || $2::jsonb where id = $1`,
      [id, JSON.stringify(extra)]
    );
    return id;
  }

  it("queues ONE media-only job (no reader, no budget) and counts what it retries", async () => {
    const id = await withMedia();
    const sent: unknown[] = [];
    expect(
      await libraryRetryMedia({
        userId: USER,
        itemId: id,
        deps: { enqueue: async (items) => (sent.push(...items), items.length) },
      })
    ).toEqual({ queued: 1 });
    expect(sent).toEqual([{ userId: USER, itemId: id, media: "retry" }]);
  });

  it("nothing failed → a true zero, nothing queued; another person's item is NOT_FOUND; a down queue is an ERROR", async () => {
    const clean = await withMedia(USER, {});
    const sent: unknown[] = [];
    const enqueue = async (items: unknown[]) => (
      sent.push(...items),
      items.length
    );
    expect(
      await libraryRetryMedia({
        userId: USER,
        itemId: clean,
        deps: { enqueue },
      })
    ).toEqual({ queued: 0 });
    expect(sent).toEqual([]);
    const theirs = await withMedia(OTHER);
    await expect(
      libraryRetryMedia({ userId: USER, itemId: theirs, deps: { enqueue } })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const mine = await withMedia();
    await expect(
      libraryRetryMedia({
        userId: USER,
        itemId: mine,
        deps: { enqueue: async () => 0 },
      })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});

/** Merge raw keys into an item's metadata (what a writer elsewhere left there). */
async function patchMeta(id: string, patch: Record<string, unknown>) {
  await q(
    `update documents set metadata = metadata || $2::jsonb where id = $1`,
    [id, JSON.stringify(patch)]
  );
}

describe('library.cancelReadWith — the person ends a waiting "Read with X"', () => {
  const consent = (at: string, heldFrom = "needs_file") => ({
    requestedReader: APIFY.readerId,
    requestedAt: at,
    heldFrom,
  });

  it("an over-budget item goes back to its waiting status; the reader is forgotten; nothing queued", async () => {
    const held = await item({
      url: "https://www.instagram.com/p/h1",
      status: "over_budget",
      read: {
        ...consent(NOW.toISOString(), "unreadable"),
        blocked: { reason: "private" },
      },
    });
    const retry = await item({
      url: "https://www.instagram.com/p/h2",
      status: "not_read",
      read: consent(NOW.toISOString()),
    });
    const plain = await item({
      url: "https://www.instagram.com/p/h3",
      status: "needs_file",
    });
    const notified: string[] = [];
    const res = await libraryCancelReadWith({
      userId: USER,
      itemIds: [held, retry, plain],
      notify: (r) => notified.push(r.id),
    });
    expect(res).toEqual({ cancelled: 2 });
    expect(notified.sort()).toEqual([held, retry].sort());
    const h1 = await readOf(held);
    expect(h1).toMatchObject({
      status: "unreadable",
      blocked: { reason: "private" },
    });
    expect(h1).not.toHaveProperty("requestedReader");
    expect(h1).not.toHaveProperty("requestedAt");
    expect(h1).not.toHaveProperty("heldFrom");
    const h2 = await readOf(retry);
    expect(h2.status).toBe("not_read");
    expect(h2).not.toHaveProperty("requestedReader");
    expect((await readOf(plain)).status).toBe("needs_file");
  });

  it("group and every-waiting scopes; another person's consent is never touched", async () => {
    const g = await group();
    const inGroup = await item({
      url: "https://www.instagram.com/p/g",
      status: "over_budget",
      groupIds: [g],
      read: consent(NOW.toISOString()),
    });
    const loose = await item({
      url: "https://www.instagram.com/p/l",
      status: "over_budget",
      read: consent(NOW.toISOString()),
    });
    const theirs = await item({
      userId: OTHER,
      url: "https://www.instagram.com/p/t",
      status: "over_budget",
      read: consent(NOW.toISOString()),
    });
    const quiet = () => undefined;
    expect(
      await libraryCancelReadWith({ userId: USER, groupId: g, notify: quiet })
    ).toEqual({ cancelled: 1 });
    expect((await readOf(inGroup)).status).toBe("needs_file");
    expect((await readOf(loose)).status).toBe("over_budget");
    expect(
      await libraryCancelReadWith({
        userId: USER,
        waiting: true,
        notify: quiet,
      })
    ).toEqual({ cancelled: 1 });
    expect((await readOf(loose)).status).toBe("needs_file");
    expect(await readOf(theirs)).toMatchObject({
      status: "over_budget",
      requestedReader: APIFY.readerId,
    });
    await expect(
      libraryCancelReadWith({ userId: USER, groupId: await group(OTHER) })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(libraryCancelReadWith({ userId: USER })).rejects.toMatchObject(
      { code: "BAD_REQUEST" }
    );
  });

  it("the item view carries the consent and when it ends — and not once it has ended", async () => {
    const now = Date.now();
    const live = await item({
      url: "https://www.instagram.com/p/live",
      status: "over_budget",
      read: consent(new Date(now - 2 * 86_400_000).toISOString()),
    });
    const ended = await item({
      url: "https://www.instagram.com/p/ended",
      status: "over_budget",
      read: consent(new Date(now - 8 * 86_400_000).toISOString()),
    });
    const undated = await item({
      url: "https://www.instagram.com/p/undated",
      status: "over_budget",
      read: { requestedReader: APIFY.readerId },
    });
    const { items } = await listLibraryItems({ userId: USER, input: {} });
    const byId = new Map(items.map((i) => [i.id, i.read]));
    expect(byId.get(live)!.consent).toEqual({
      readerId: APIFY.readerId,
      givenAt: new Date(now - 2 * 86_400_000).toISOString(),
      expiresAt: new Date(now + 5 * 86_400_000).toISOString(),
    });
    expect(byId.get(ended)!.consent).toBeUndefined();
    expect(byId.get(undated)!.consent).toBeUndefined();
  });
});

describe("missingMedia — old posts whose expired pictures were skipped", () => {
  const SKIP = {
    importMediaSkipped: {
      reason: "expired",
      sourceUrl: "https://scontent.cdninstagram.com/x.jpg?oe=5F000000",
      expiredAt: "2020-07-04T00:00:00.000Z",
      at: NOW.toISOString(),
    },
  };
  const TIKTOK: UrlReaderOffer = { ...APIFY, options: ["withVideo"] };

  async function library() {
    const ig = await item({
      url: "https://www.instagram.com/p/old1",
      status: "read",
      read: { summary: "kept text" },
    });
    await patchMeta(ig, SKIP);
    const tt = await item({
      url: "https://www.tiktok.com/@a/video/1",
      status: "needs_file",
    });
    await patchMeta(tt, SKIP);
    // Never in scope: a copy since landed; archived; not skipped; another person's.
    const copied = await item({
      url: "https://www.instagram.com/p/c",
      status: "read",
    });
    await patchMeta(copied, {
      ...SKIP,
      importMedia: [
        {
          documentId: "d",
          mime: "image/jpeg",
          sourceUrl: "u",
          kind: "image",
          order: 0,
        },
      ],
    });
    const archived = await item({
      url: "https://www.instagram.com/p/a",
      status: "read",
      archived: true,
    });
    await patchMeta(archived, SKIP);
    await item({ url: "https://www.instagram.com/p/n", status: "read" });
    const theirs = await item({
      userId: OTHER,
      url: "https://www.instagram.com/p/t",
      status: "read",
    });
    await patchMeta(theirs, SKIP);
    return { ig, tt, copied };
  }
  const offers = (url: string) =>
    url.includes("tiktok")
      ? [TIKTOK]
      : url.includes("instagram")
        ? [APIFY]
        : [BUILTIN];

  it("readers: one offer per reader with its count, and the platforms", async () => {
    await library();
    const { deps } = fakeDeps({ offers });
    const res = await libraryReaders({
      userId: USER,
      missingMedia: true,
      deps,
    });
    expect(res.waiting).toBe(2);
    // One reader for both links; the TikTok link's "with video" is offered
    // for the list (readWith sends it only where the link's offer declares it).
    expect(res.offers).toEqual([
      { ...APIFY, options: ["withVideo"], count: 2 },
    ]);
    expect(res.platforms).toEqual(
      expect.arrayContaining([
        { serviceId: "instagram", count: 1 },
        { serviceId: "tiktok", count: 1 },
      ])
    );
    expect(res.platforms).toHaveLength(2);
  });

  it("the item view says mediaExpired (no failure mark) until a copy lands", async () => {
    const { ig, copied } = await library();
    const { items } = await listLibraryItems({ userId: USER, input: {} });
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(ig)!.mediaExpired).toBe(true);
    expect(byId.get(ig)!.mediaFailed).toBeUndefined();
    expect(byId.get(copied)!.mediaExpired).toBeUndefined();
  });

  it("readWith: keepRead on every job; withVideo ONLY for the reader that declares it", async () => {
    const { ig, tt } = await library();
    const { deps, sent } = fakeDeps({ offers });
    const res = await libraryReadWith({
      userId: USER,
      missingMedia: true,
      readerId: APIFY.readerId,
      withVideo: true,
      deps,
    });
    expect(res).toEqual({ queued: 2, overBudget: 0, skipped: 0 });
    const job = (id: string) =>
      (sent as Array<Record<string, unknown>>).find((j) => j.itemId === id);
    // IG's offer declares no options: the choice never reaches it.
    expect(job(ig)).toEqual({
      userId: USER,
      itemId: ig,
      reader: APIFY.readerId,
      force: true,
      keepRead: true,
    });
    expect(job(tt)).toEqual({
      userId: USER,
      itemId: tt,
      reader: APIFY.readerId,
      force: true,
      keepRead: true,
      withVideo: true,
    });
  });
});

describe('the "with video" choice waits WITH the consent (and ends with it)', () => {
  const TIKTOK_OFFER: UrlReaderOffer = { ...APIFY, options: ["withVideo"] };
  const offers = (url: string) =>
    url.includes("tiktok")
      ? [TIKTOK_OFFER]
      : url.includes("instagram")
        ? [APIFY]
        : [BUILTIN];

  it("held over budget: remembered only where the reader declares it; a new tap replaces it; cancel ends it", async () => {
    const tt = await item({
      url: "https://www.tiktok.com/@a/video/9",
      status: "needs_file",
    });
    const ig = await item({
      url: "https://www.instagram.com/p/v9",
      status: "needs_file",
    });
    const { deps } = fakeDeps({ offers, usedToday: async () => 200 });
    expect(
      await libraryReadWith({
        userId: USER,
        itemIds: [tt, ig],
        readerId: APIFY.readerId,
        withVideo: true,
        deps,
      })
    ).toMatchObject({ queued: 0, overBudget: 2 });
    expect(await readOf(tt)).toMatchObject({
      status: "over_budget",
      requestedReader: APIFY.readerId,
      requestedWithVideo: true,
    });
    expect(await readOf(ig)).not.toHaveProperty("requestedWithVideo");
    // The value reaches the item view: the consent says "with video".
    await q(
      `update documents set metadata = jsonb_set(metadata, '{importRead,requestedAt}', to_jsonb($2::text)) where id = $1`,
      [tt, new Date().toISOString()]
    );
    const { items } = await listLibraryItems({ userId: USER, input: {} });
    expect(items.find((i) => i.id === tt)!.read.consent).toMatchObject({
      readerId: APIFY.readerId,
      withVideo: true,
    });
    // A new tap without the choice replaces it.
    await libraryReadWith({
      userId: USER,
      itemIds: [tt],
      readerId: APIFY.readerId,
      deps,
    });
    expect(await readOf(tt)).not.toHaveProperty("requestedWithVideo");
    // Set again, then cancel: the choice goes with the consent.
    await libraryReadWith({
      userId: USER,
      itemIds: [tt],
      readerId: APIFY.readerId,
      withVideo: true,
      deps,
    });
    expect((await readOf(tt)).requestedWithVideo).toBe(true);
    await libraryCancelReadWith({
      userId: USER,
      itemIds: [tt],
      notify: () => undefined,
    });
    expect(await readOf(tt)).not.toHaveProperty("requestedWithVideo");
    expect(await readOf(tt)).not.toHaveProperty("requestedReader");
  });
});

describe("a re-read of a READ item waits beside its read; consents are counted", () => {
  const consent = (at: string) => ({
    requestedReader: APIFY.readerId,
    requestedAt: at,
  });

  it('"Get the pictures" over budget: the read item keeps its read, holds the consent with keepRead; cancel ends it, the read stays', async () => {
    const ig = await item({
      url: "https://www.instagram.com/p/old-read",
      status: "read",
      read: { summary: "kept text" },
    });
    await patchMeta(ig, {
      importMediaSkipped: {
        reason: "expired",
        sourceUrl: "https://scontent.cdninstagram.com/x.jpg?oe=5F000000",
        expiredAt: "2020-07-04T00:00:00.000Z",
        at: NOW.toISOString(),
      },
    });
    const { deps, sent } = fakeDeps({ usedToday: async () => 200 });
    expect(
      await libraryReadWith({
        userId: USER,
        missingMedia: true,
        readerId: APIFY.readerId,
        deps,
      })
    ).toEqual({
      queued: 0,
      overBudget: 1,
      skipped: 0,
      consentExpiresAt: CONSENT_END,
    });
    expect(sent).toEqual([]);
    expect(await readOf(ig)).toEqual({
      status: "read",
      summary: "kept text",
      suggestedActions: [],
      requestedReader: APIFY.readerId,
      requestedAt: NOW.toISOString(),
      requestedKeepRead: true,
    });
    await libraryCancelReadWith({
      userId: USER,
      itemIds: [ig],
      notify: () => undefined,
    });
    expect(await readOf(ig)).toEqual({
      status: "read",
      summary: "kept text",
      suggestedActions: [],
    });
  });

  it("readers counts the scope's LIVE consents — exactly the items whose view shows read.consent; cancel ends that many", async () => {
    const now = Date.now();
    const live = new Date(now - 86_400_000).toISOString();
    const g = await group();
    const inGroup = await item({
      url: "https://www.instagram.com/p/c1",
      status: "over_budget",
      groupIds: [g],
      read: consent(live),
    });
    const beside = await item({
      url: "https://www.instagram.com/p/c2",
      status: "read",
      groupIds: [g],
      read: { summary: "s", ...consent(live) },
    });
    const loose = await item({
      url: "https://www.instagram.com/p/c3",
      status: "not_read",
      read: consent(live),
    });
    // Not counted: ended, undated, archived, another person's, no consent.
    await item({
      url: "https://www.instagram.com/p/c4",
      status: "over_budget",
      groupIds: [g],
      read: consent(new Date(now - 8 * 86_400_000).toISOString()),
    });
    await item({
      url: "https://www.instagram.com/p/c5",
      status: "over_budget",
      read: { requestedReader: APIFY.readerId },
    });
    await item({
      url: "https://www.instagram.com/p/c6",
      status: "over_budget",
      archived: true,
      read: consent(live),
    });
    await item({
      userId: OTHER,
      url: "https://www.instagram.com/p/c7",
      status: "over_budget",
      read: consent(live),
    });
    await item({ url: "https://www.instagram.com/p/c8", status: "needs_file" });
    const { deps } = fakeDeps();
    const all = await libraryReaders({ userId: USER, waiting: true, deps });
    const inG = await libraryReaders({ userId: USER, groupId: g, deps });
    // The count is the set the item views mark (the value arrives).
    const { items } = await listLibraryItems({ userId: USER, input: {} });
    const marked = items.filter((i) => i.read.consent).map((i) => i.id);
    expect(marked.sort()).toEqual([inGroup, beside, loose].sort());
    expect(all.consented).toBe(3);
    expect(inG.consented).toBe(2);
    const quiet = () => undefined;
    expect(
      await libraryCancelReadWith({ userId: USER, groupId: g, notify: quiet })
    ).toMatchObject({ cancelled: expect.any(Number) });
    expect(
      (await libraryReaders({ userId: USER, groupId: g, deps })).consented
    ).toBe(0);
    expect(
      (await libraryReaders({ userId: USER, waiting: true, deps })).consented
    ).toBe(1);
  });
});
