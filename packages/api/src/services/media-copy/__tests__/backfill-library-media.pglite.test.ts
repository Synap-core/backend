/**
 * The Library thumbnail backfill on PGlite: real `documents` / `pod_settings`
 * rows, the real scope query and — in the reachability case — the real copy
 * door (`copyLibraryItemMedia`) with only the network and the blob store faked.
 *
 * Rows that rule out a wrong rule:
 *   - an item that already HOLDS a copy, a `data:` card image, a deleted item
 *     and a non-Library document are never handed over (an "any document with
 *     a card image" rule would copy them all); an EMPTY `importMedia` is in;
 *   - an expired card URL ends RECORDED as a failed copy on the item (honest),
 *     a live one as a held copy — the value reaches the item;
 *   - the completed stamp short-circuits the next run;
 *   - a copy RUN that failed stops the pass and the next run retries THAT item
 *     (the cursor never passes it); the run cap pauses and the next run resumes.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

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

import { documents, podSettings } from "@synap/database";
import type { UrlReadMedia } from "@synap-core/types/url-read";
import { pgliteSchemaDdl } from "../../../__tests__/pglite-ddl.js";
import {
  backfillLibraryItemMedia,
  LIBRARY_MEDIA_BACKFILL_SETTINGS_KEY,
} from "../backfill-library-media.js";
import {
  copyLibraryItemMedia,
  type CopyLibraryItemMediaResult,
} from "../copy-library-item-media.js";
import { png } from "./fixtures.js";

const A = "user-backfill-a";
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function doc(over: {
  card?: string;
  media?: unknown[];
  library?: boolean;
  deleted?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const metadata = {
    ...(over.library === false
      ? { card: { imageUrl: over.card } }
      : {
          importItem: {
            version: 1,
            title: "A kept post",
            source: { kind: "url", url: "https://example.com/p" },
            contentStatus: "readable",
            ...(over.card ? { card: { imageUrl: over.card } } : {}),
          },
          importRead: { status: "read", suggestedActions: [] },
        }),
    ...(over.media ? { importMedia: over.media } : {}),
  };
  await q(
    `insert into documents (id, user_id, title, type, metadata, deleted_at) values ($1, $2, 'A kept post', 'text', $3::jsonb, $4)`,
    [
      id,
      A,
      JSON.stringify(metadata),
      over.deleted ? new Date().toISOString() : null,
    ]
  );
  return id;
}

async function metaOf(id: string): Promise<Record<string, any>> {
  const { rows } = await q<{ m: Record<string, any> }>(
    `select metadata as m from documents where id = $1`,
    [id]
  );
  return rows[0]!.m;
}

function recorder(result?: (itemId: string) => CopyLibraryItemMediaResult) {
  const calls: Array<{ itemId: string; media: UrlReadMedia[] }> = [];
  return {
    calls,
    copy: async (input: {
      userId: string;
      itemId: string;
      media: UrlReadMedia[];
    }) => {
      calls.push({ itemId: input.itemId, media: input.media });
      return (
        result?.(input.itemId) ?? {
          status: "copied" as const,
          copied: 1,
          reused: 0,
          failed: 0,
        }
      );
    },
  };
}

const noSleep = async () => undefined;

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl([documents, podSettings]));
});
beforeEach(async () => {
  await h.client!.exec(`delete from documents; delete from pod_settings;`);
});

describe("backfillLibraryItemMedia", () => {
  it("hands over exactly the live Library items with no copy and an http(s) card image", async () => {
    const plain = await doc({ card: "https://cdn.example.com/a.jpg" });
    const emptyMedia = await doc({
      card: "http://cdn.example.com/b.png",
      media: [],
    });
    await doc({
      card: "https://cdn.example.com/held.jpg",
      media: [
        {
          documentId: randomUUID(),
          mime: "image/jpeg",
          sourceUrl: "https://cdn.example.com/held.jpg",
          kind: "image",
          order: 0,
        },
      ],
    });
    await doc({ card: "data:image/png;base64,AAAA" });
    await doc({ card: "https://cdn.example.com/gone.jpg", deleted: true });
    await doc({ card: "https://cdn.example.com/x.jpg", library: false });
    await doc({});

    const r = recorder();
    const result = await backfillLibraryItemMedia({
      copy: r.copy,
      sleep: noSleep,
    });
    expect(result).toMatchObject({ status: "completed", scanned: 2 });
    expect(r.calls.map((c) => c.itemId).sort()).toEqual(
      [plain, emptyMedia].sort()
    );
    expect(r.calls.find((c) => c.itemId === plain)!.media).toEqual([
      {
        url: "https://cdn.example.com/a.jpg",
        kind: "image",
        role: "cover",
        order: 0,
      },
    ]);

    // The stamp short-circuits the next boot.
    const again = recorder();
    expect(
      await backfillLibraryItemMedia({ copy: again.copy, sleep: noSleep })
    ).toMatchObject({ status: "already-complete" });
    expect(again.calls).toEqual([]);
  });

  it("through the REAL copy door: a live image is held, an expired link is recorded as failed", async () => {
    const LIVE = "https://cdn.example.com/live.png";
    const EXPIRED = "https://scontent.cdninstagram.com/expired.jpg";
    const live = await doc({ card: LIVE });
    const expired = await doc({ card: EXPIRED });
    const bytes = Buffer.from(png(40, 30));

    const copy = (input: {
      userId: string;
      itemId: string;
      media: UrlReadMedia[];
    }) =>
      copyLibraryItemMedia(input, {
        fetchImage: async (url) =>
          url === LIVE
            ? { ok: true, bytes, mime: "image/png", width: 40, height: 30 }
            : { ok: false, reason: "http_4xx" },
        findBySha256: async () => null,
        store: (async () => ({ documentId: randomUUID() })) as never,
        liveDocuments: async () => new Set(),
      });
    const result = await backfillLibraryItemMedia({ copy, sleep: noSleep });
    expect(result).toMatchObject({
      status: "completed",
      scanned: 2,
      copied: 1,
      failed: 1,
    });

    const held = await metaOf(live);
    expect(held.importMedia).toHaveLength(1);
    expect(held.importMedia[0]).toMatchObject({
      sourceUrl: LIVE,
      kind: "image",
      role: "cover",
    });
    const lost = await metaOf(expired);
    expect(lost.importMedia ?? []).toEqual([]);
    expect(lost.importMediaFailed).toBe(1);
  });

  it("a copy RUN that failed stops the pass; the next run retries that item", async () => {
    const ids = [
      await doc({ card: "https://cdn.example.com/1.jpg" }),
      await doc({ card: "https://cdn.example.com/2.jpg" }),
    ].sort();
    const down = recorder((itemId) =>
      itemId === ids[1]
        ? {
            status: "failed",
            error: "db down",
            copied: 0,
            reused: 0,
            failed: 0,
          }
        : { status: "copied", copied: 1, reused: 0, failed: 0 }
    );
    await expect(
      backfillLibraryItemMedia({ copy: down.copy, sleep: noSleep })
    ).rejects.toThrow(/db down/);

    const up = recorder();
    expect(
      await backfillLibraryItemMedia({ copy: up.copy, sleep: noSleep })
    ).toMatchObject({ status: "completed" });
    // The cursor never passed the page that failed: both are handed over again.
    expect(up.calls.map((c) => c.itemId)).toEqual(ids);
  });

  it("the run cap pauses the pass and the next run resumes after it, rate-limited", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await doc({ card: `https://cdn.example.com/${i}.jpg` }));
    }
    ids.sort();
    const slept: number[] = [];
    const first = recorder();
    expect(
      await backfillLibraryItemMedia({
        copy: first.copy,
        sleep: async (ms) => {
          slept.push(ms);
        },
        runMax: 3,
        batchSize: 2,
        spacingMs: 1234,
      })
    ).toMatchObject({ status: "paused", scanned: 3 });
    expect(first.calls.map((c) => c.itemId)).toEqual(ids.slice(0, 3));
    expect(slept).toEqual([1234, 1234]);

    const second = recorder();
    expect(
      await backfillLibraryItemMedia({
        copy: second.copy,
        sleep: noSleep,
        runMax: 3,
        batchSize: 2,
      })
    ).toMatchObject({ status: "completed", scanned: 5 });
    expect(second.calls.map((c) => c.itemId)).toEqual(ids.slice(3));
    const { rows } = await q<{ s: Record<string, any> }>(
      `select settings as s from pod_settings`
    );
    expect(rows[0]!.s[LIBRARY_MEDIA_BACKFILL_SETTINGS_KEY]).toMatchObject({
      scanned: 5,
      completedAt: expect.any(String),
    });
  });
});
