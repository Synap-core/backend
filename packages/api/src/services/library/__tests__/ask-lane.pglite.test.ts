/**
 * The Library LANE of `ask` on a real Postgres (PGlite) — what the person kept,
 * found by its words:
 *   - an item is found by words that appear ONLY in its READ TEXT (not in its
 *     title, URL, summary or note) — through the search index, simulated here
 *     from the stored text objects themselves, so the test fails if the lane
 *     stops consulting it;
 *   - a hit carries id, title, source URL, a snippet of the read text AROUND
 *     the match, and the reader stamp when the read carries one;
 *   - the owner floor holds even when the index names someone else's item;
 *   - a failed SQL read THROWS (ask turns that into `degraded:["library"]`),
 *     and an unreachable index is reported as `down`, never as "no hits".
 *
 * Stubbed, and why: `@synap/storage` (in-memory objects). The search index
 * (Typesense) is an injected lookup, as it is the pod's only external leg.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  objects: new Map<string, Buffer>(),
}));

vi.mock("@synap/storage", () => ({
  storage: {
    downloadBuffer: async (key: string) => {
      const b = h.objects.get(key);
      if (!b) throw new Error(`no object ${key}`);
      return b;
    },
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

import { documents, libraryReadTextKey } from "@synap/database";
import { pgliteSchemaDdl } from "../../../__tests__/pglite-ddl.js";
import { libraryItemMetadata } from "./fixtures.js";
import {
  ASK_LIBRARY_SNIPPET_MAX,
  ASK_LIBRARY_TEXT_FETCH_MAX,
  readerOf,
  searchLibraryForAsk,
  snippetOf,
  snippetTerms,
} from "../ask-lane.js";
import type { LibraryReadTextLookup } from "../read-text-search.js";

const USER = "user-ask-1";
const OTHER = "user-ask-2";
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function keepRead(over: {
  userId?: string;
  title: string;
  url?: string;
  summary?: string;
  /** The read text; omitted ⇒ the read landed but its object is gone. */
  text?: string;
  status?: string;
  note?: string;
}): Promise<string> {
  const userId = over.userId ?? USER;
  const { rows } = await q<{ id: string }>(
    `insert into documents (user_id, title, type, metadata)
     values ($1, $2, 'text', $3::jsonb) returning id`,
    [
      userId,
      over.title,
      JSON.stringify({
        ...libraryItemMetadata({
          item: {
            title: over.title,
            source: { kind: "url", url: over.url ?? "https://example.com/x" },
            lightRead: true,
          },
          curation: {
            decision: "keep",
            groupKeys: [],
            ...(over.note ? { note: over.note } : {}),
          },
          read: {
            status: (over.status ?? "read") as never,
            ...(over.summary ? { summary: over.summary } : {}),
          },
        }),
      }),
    ]
  );
  const id = rows[0]!.id;
  if (over.text !== undefined) {
    h.objects.set(libraryReadTextKey(userId, id), Buffer.from(over.text));
  }
  return id;
}

/**
 * A stand-in for the search index built from the SAME objects the real index
 * reads (`documentTextStorageKey` → the read text): every stored read text whose
 * words include all query words. It returns EVERY owner's ids — the lane's SQL
 * floor, not the index, must keep another person's item out.
 */
const indexFromStoredText: LibraryReadTextLookup = async ({ q: query }) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const ids: string[] = [];
  for (const [key, body] of h.objects) {
    const text = body.toString("utf-8").toLowerCase();
    if (words.every((w) => text.includes(w))) {
      ids.push(key.split("/").pop()!.replace(".txt", ""));
    }
  }
  return ids;
};

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl([documents]));
});
beforeEach(async () => {
  h.objects.clear();
  await h.client!.exec(`delete from documents;`);
});

describe("ask · library lane", () => {
  it("finds a kept item by words that appear ONLY in its read text, and quotes them", async () => {
    const id = await keepRead({
      title: "Carousel by @studio",
      url: "https://example.com/p/abc",
      summary: "A post about design.",
      text:
        "Slide one introduces the brand. ".repeat(20) +
        "The palette is terracotta and bone with a grotesque headline face. " +
        "Slide three closes with the logo.",
    });
    await keepRead({ title: "Unrelated page", text: "Bread and butter." });

    const lane = await searchLibraryForAsk(
      { userId: USER, query: "terracotta palette", limit: 5 },
      { lookup: indexFromStoredText }
    );

    expect(lane.readTextSearch).toBe("ok");
    expect(lane.items.map((i) => i.id)).toEqual([id]);
    const hit = lane.items[0]!;
    expect(hit).toMatchObject({
      title: "Carousel by @studio",
      sourceUrl: "https://example.com/p/abc",
      readStatus: "read",
      snippetFrom: "read_text",
    });
    // The snippet is the text AROUND the match — not the summary, not the opening.
    expect(hit.snippet).toContain("terracotta");
    expect(hit.snippet!.length).toBeLessThanOrEqual(
      ASK_LIBRARY_SNIPPET_MAX + 2
    );
    expect(hit.snippet).not.toContain("A post about design");
  });

  it("a title word is found with NO index at all (SQL leg), and a down index is SAID", async () => {
    await keepRead({ title: "Sourdough starter notes", text: "flour water" });
    const lane = await searchLibraryForAsk(
      { userId: USER, query: "sourdough", limit: 5 },
      {
        lookup: async () => {
          throw new Error("typesense unreachable");
        },
      }
    );
    expect(lane.items.map((i) => i.title)).toEqual(["Sourdough starter notes"]);
    expect(lane.readTextSearch).toBe("down");
  });

  it("an index that names ANOTHER person's item never leaks it (owner floor in SQL)", async () => {
    await keepRead({
      userId: OTHER,
      title: "Their secret page",
      text: "the shared word zeppelin appears here",
    });
    const lane = await searchLibraryForAsk(
      { userId: USER, query: "zeppelin", limit: 5 },
      { lookup: indexFromStoredText }
    );
    expect(lane.items).toEqual([]);
    expect(lane.readTextSearch).toBe("ok");
  });

  it("falls back to the read summary when the text object is gone, and says so", async () => {
    await keepRead({
      title: "Lost text",
      summary: "A short summary about pottery glazes.",
    });
    const lane = await searchLibraryForAsk(
      { userId: USER, query: "Lost text", limit: 5 },
      { lookup: async () => [] }
    );
    expect(lane.items[0]).toMatchObject({
      snippet: "A short summary about pottery glazes.",
      snippetFrom: "summary",
    });
  });

  it("fetches read texts for the top hits only; a summary holding the words costs no fetch", async () => {
    // 6 items whose read text holds the word; 2 of them say it in their
    // summary too. Only ASK_LIBRARY_TEXT_FETCH_MAX of the other 4 are fetched.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(
        await keepRead({
          title: `Page ${i}`,
          summary: i < 2 ? `A note on ceramics, part ${i}.` : `Part ${i}.`,
          text: `Long text ${i} about ceramics and kilns.`,
        })
      );
    }
    const fetched: string[] = [];
    const lane = await searchLibraryForAsk(
      { userId: USER, query: "ceramics", limit: 10 },
      {
        lookup: indexFromStoredText,
        readText: async (key) => {
          fetched.push(key);
          return h.objects.get(key)!.toString("utf-8");
        },
      }
    );
    expect(lane.items).toHaveLength(6);
    expect(fetched).toHaveLength(ASK_LIBRARY_TEXT_FETCH_MAX);
    const from = lane.items.map((i) => i.snippetFrom);
    expect(from.filter((f) => f === "read_text")).toHaveLength(
      ASK_LIBRARY_TEXT_FETCH_MAX
    );
    // Every hit still carries a snippet (the summary stands in, said so).
    expect(lane.items.every((i) => i.snippet)).toBe(true);
    const summaryHits = lane.items.filter(
      (i) => i.snippet?.includes("ceramics") && i.snippetFrom === "summary"
    );
    expect(summaryHits).toHaveLength(2);
  });

  it("a failed SQL read THROWS — it is never an empty lane", async () => {
    const broken = {
      select: () => {
        throw new Error("db down");
      },
    } as never;
    await expect(
      searchLibraryForAsk(
        { userId: USER, query: "anything", limit: 5 },
        { database: broken, lookup: async () => [] }
      )
    ).rejects.toThrow("db down");
  });
});

describe("ask · library lane helpers", () => {
  it("carries the reader stamp when the read has one, and nothing without one", () => {
    const stamp = {
      id: "builtin:article",
      name: "Synap reader",
      billed: false,
      readAt: "2026-10-14T09:00:00.000Z",
      contentHash: "dropped",
    };
    expect(
      readerOf({ read: { status: "read", reader: stamp } } as never)
    ).toEqual({
      id: "builtin:article",
      name: "Synap reader",
      billed: false,
      readAt: "2026-10-14T09:00:00.000Z",
    });
    // A malformed stamp never reaches here: the read model parses it
    // (`readLibraryItemRead` → `readReaderStamp`) before a view exists.
    expect(readerOf({ read: { status: "read" } } as never)).toBeUndefined();
  });

  it("content terms drop question and filler words; the snippet centres on the first match", () => {
    expect(
      snippetTerms("What do my branding references have in common?")
    ).toEqual(["branding", "references", "have", "common"]);
    const text = `${"x ".repeat(300)}needle in the haystack${" y".repeat(300)}`;
    const s = snippetOf(text, ["needle"]);
    expect(s).toContain("needle");
    expect(s.startsWith("…")).toBe(true);
  });
});
