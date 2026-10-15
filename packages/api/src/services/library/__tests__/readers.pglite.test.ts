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
import {
  libraryReaders,
  libraryReadWith,
  type LibraryReadersDeps,
} from "../readers.js";

const USER = "user-readers-1";
const OTHER = "user-readers-2";
const NOW = new Date("2026-10-15T09:00:00.000Z");
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
  const meta = {
    importItem: {
      version: 1,
      title: `Item ${seq}`,
      contentStatus: "readable",
      stagedAt: NOW.toISOString(),
      source: over.url ? { kind: "url", url: over.url } : { kind: "text" },
    },
    importCuration: {
      decision: "keep",
      groupIds: over.groupIds ?? [],
      ...(over.archived ? { archivedAt: NOW.toISOString() } : {}),
    },
    ...(over.status || over.read
      ? {
          importRead: {
            status: over.status ?? "read",
            suggestedActions: [],
            ...over.read,
          },
        }
      : {}),
  };
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

function fakeDeps(over: Partial<LibraryReadersDeps> = {}) {
  const sent: unknown[] = [];
  const lookups: string[] = [];
  const deps: Partial<LibraryReadersDeps> = {
    listReaders: async (_ctx, url) => {
      lookups.push(url);
      return offersFor(url);
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
  return { deps, sent, lookups };
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
    // R2-M1: `readsAllSpaces` is false for an agent — the ctx the door gets
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
      listReaders: async (_c, url) => {
        if (url.includes("instagram")) throw new Error("catalog cache down");
        return offersFor(url);
      },
    });
    await expect(
      libraryReaders({ userId: USER, groupId: g, deps })
    ).rejects.toThrow(/catalog cache down/);
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
    expect(res).toEqual({ queued: 3, overBudget: 2, skipped: 1 });
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
      listReaders: async () => [{ ...APIFY, state: "install" }],
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
      listReaders: async () => {
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
