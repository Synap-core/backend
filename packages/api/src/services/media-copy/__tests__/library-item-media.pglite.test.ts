/**
 * A Library item's media copy on PGlite (tables from the Drizzle schema),
 * through the REAL SQL: the owner-floored item read, the bytes-ledger dedup
 * (`findStoredDocumentBySha256`), the locked three-key record on the item,
 * the purge with the item (keep-alive) and the hand-off read the entity copy
 * uses. Downloads go through the REAL guarded fetchers (`fetchExternalImage`,
 * `fetchExternalVideoToSink`) over injected responses; storage is a fake that
 * records what it was given (its own streamed upload is tested in
 * packages/storage).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { db as DatabaseHandle } from "@synap/database";
import type { UrlReadMedia } from "@synap-core/types/url-read";
import {
  copyLibraryItemMedia,
  type CopyLibraryItemMediaDeps,
} from "../copy-library-item-media.js";
import { fetchExternalImage } from "../fetch-image.js";
import { fetchExternalVideoToSink } from "../fetch-video.js";
import { imageFromLibraryCopy } from "../library-handoff.js";
import { purgeDeletedLibraryItems } from "../../library/keep-alive.js";
import { toLibraryItemView } from "../../library/read-model.js";
import { mp4Head, png } from "./fixtures.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const A = "user-a";
const B = "user-b";
let client: PGlite;
let database: typeof DatabaseHandle;

beforeAll(async () => {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  database = drizzle(client, { schema }) as unknown as typeof DatabaseHandle;
}, 120_000);

async function item(
  user: string,
  extra: Record<string, unknown> = {},
  opts: { deletedDaysAgo?: number } = {}
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into documents (id, user_id, title, type, storage_url, storage_key, size, metadata, created_at, updated_at, deleted_at)
     values ($1, $2, 'A kept post', 'text', '', '', 0, $3::jsonb, now(), now(), $4::timestamptz)`,
    [
      id,
      user,
      JSON.stringify({
        importItem: {
          version: 1,
          title: "A kept post",
          source: { kind: "url", url: "https://instagram.com/p/x" },
          contentStatus: "needs_file",
        },
        importRead: { status: "read", summary: "kept" },
        importCuration: { note: "the person's note" },
        ...extra,
      }),
      opts.deletedDaysAgo === undefined
        ? null
        : new Date(Date.now() - opts.deletedDaysAgo * 86_400_000).toISOString(),
    ]
  );
  return id;
}

async function metaOf(id: string): Promise<Record<string, any>> {
  const {
    rows: [row],
  } = await client.query<{ m: Record<string, any> }>(
    `select metadata as m from documents where id = $1`,
    [id]
  );
  return row!.m;
}

/** A stored document row, as the store-only door / body door would write it. */
async function insertDoc(args: {
  user: string;
  mime: string;
  size: number;
  metadata: Record<string, unknown>;
  storageKey?: string;
}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into documents (id, user_id, title, type, storage_url, storage_key, size, mime_type, metadata, created_at, updated_at)
     values ($1, $2, 'copy', 'file', '', $3, $4, $5, $6::jsonb, now(), now())`,
    [
      id,
      args.user,
      args.storageKey ?? `files/pod/${id}/f`,
      args.size,
      args.mime,
      JSON.stringify(args.metadata),
    ]
  );
  return id;
}

/** A response served chunk by chunk (no network). */
function respond(
  chunks: Uint8Array[],
  init: { status?: number; type?: string } = {}
): Response {
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        const next = chunks[i++];
        if (next) c.enqueue(next);
        else c.close();
      },
    }),
    {
      status: init.status ?? 200,
      headers: { "content-type": init.type ?? "application/octet-stream" },
    }
  );
}

const PNG = Buffer.from(png(40, 30));
const MP4 = Buffer.concat([Buffer.from(mp4Head("isom")), Buffer.alloc(300, 5)]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
);
const HTML = new TextEncoder().encode(
  "<!doctype html><html><body>an error page, padded to pass the sniff head</body></html>"
);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The web, as a URL → response table; counts requests per URL. */
function web(table: Record<string, () => Response>) {
  const hits: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    hits.push(url);
    const make = table[url];
    if (!make) throw new Error(`unexpected fetch ${url}`);
    return make();
  });
  return { fetch, hits };
}

interface Harness {
  deps: CopyLibraryItemMediaDeps;
  uploads: Map<string, Buffer>;
  removed: string[];
  discarded: string[];
  stored: Array<Record<string, unknown>>;
}

function harness(
  net: ReturnType<typeof web>,
  over: Partial<CopyLibraryItemMediaDeps> = {}
): Harness {
  const uploads = new Map<string, Buffer>();
  const removed: string[] = [];
  const discarded: string[] = [];
  const stored: Array<Record<string, unknown>> = [];
  const deps: CopyLibraryItemMediaDeps = {
    database,
    fetchImage: (u) => fetchExternalImage(u, { fetch: net.fetch }),
    fetchVideo: (u, sink) =>
      fetchExternalVideoToSink(u, sink, { fetch: net.fetch }),
    // The store-only door, as a row with the metadata it was handed.
    store: (async (p: {
      userId: string;
      buffer: Buffer;
      mimeType: string;
      metadata?: Record<string, unknown>;
      storedBySystem?: boolean;
    }) => {
      stored.push(p as unknown as Record<string, unknown>);
      const documentId = await insertDoc({
        user: p.userId,
        mime: p.mimeType,
        size: p.buffer.byteLength,
        metadata: { uploadKind: "file-upload", ...p.metadata },
      });
      return { documentId };
    }) as never,
    uploadStream: async (key, body) => {
      const parts: Buffer[] = [];
      for await (const c of body) parts.push(Buffer.from(c));
      uploads.set(key, Buffer.concat(parts));
      return { size: uploads.get(key)!.byteLength };
    },
    adoptStoredObject: async (a) =>
      insertDoc({
        user: a.userId,
        mime: a.mimeType,
        size: a.size,
        storageKey: a.storageKey,
        metadata: { uploadKind: "presigned-upload", ...a.metadata },
      }),
    removeObject: async (key) => {
      removed.push(key);
    },
    discard: async (id) => {
      discarded.push(id);
    },
    liveDocuments: async (ids) => {
      if (ids.length === 0) return new Set();
      const { rows } = await client.query<{ id: string }>(
        `select id from documents where id = any($1::uuid[]) and deleted_at is null`,
        [ids]
      );
      return new Set(rows.map((r) => r.id));
    },
    now: () => new Date("2026-10-15T10:00:00Z"),
    ...over,
  };
  return { deps, uploads, removed, discarded, stored };
}

const IMG1 = "https://scontent.cdninstagram.com/slide1.jpg";
const IMG2 = "https://scontent.cdninstagram.com/slide2.jpg";
const VID = "https://scontent.cdninstagram.com/reel.mp4";
const media = (
  ...m: Array<[string, "image" | "video", number]>
): UrlReadMedia[] =>
  m.map(([url, kind, order]) => ({
    url,
    kind,
    order,
    ...(order === 0 ? { role: "cover" as const } : { role: "slide" as const }),
  }));

beforeEach(async () => {
  await client.exec(`delete from documents`);
});

describe("copyLibraryItemMedia", () => {
  it("copies a carousel's images and its video, records them in order on the ITEM, keeps every other key", async () => {
    const id = await item(A);
    const net = web({
      [IMG1]: () => respond([PNG], { type: "image/jpeg" }),
      [IMG2]: () => respond([Buffer.from(png(10, 10))]),
      [VID]: () =>
        respond([MP4.subarray(0, 40), MP4.subarray(40)], { type: "video/mp4" }),
    });
    const h = harness(net);

    const result = await copyLibraryItemMedia(
      {
        userId: A,
        itemId: id,
        media: media([VID, "video", 2], [IMG1, "image", 0], [IMG2, "image", 1]),
      },
      h.deps
    );

    expect(result).toEqual({
      status: "copied",
      copied: 3,
      reused: 0,
      failed: 0,
    });
    const m = await metaOf(id);
    expect(
      m.importMedia.map((x: any) => [x.sourceUrl, x.kind, x.order, x.role])
    ).toEqual([
      [IMG1, "image", 0, "cover"],
      [IMG2, "image", 1, "slide"],
      [VID, "video", 2, "slide"],
    ]);
    expect(m.importMedia[0]).toMatchObject({
      mime: "image/png",
      width: 40,
      height: 30,
      bytes: PNG.byteLength,
    });
    expect(m.importMedia[2]).toMatchObject({
      mime: "video/mp4",
      bytes: MP4.byteLength,
    });
    expect(m.importMediaFailed).toBe(0);
    expect(m.importMediaFailures).toEqual([]);
    // Every other key untouched.
    expect(m.importRead).toEqual({ status: "read", summary: "kept" });
    expect(m.importCuration).toEqual({ note: "the person's note" });
    // The video was STREAMED into storage, byte-exact, and adopted.
    const [key, bytes] = [...h.uploads.entries()][0]!;
    expect(bytes.equals(MP4)).toBe(true);
    expect(key).toMatch(/^files\/pod\/[0-9a-f-]{36}\/reel\.mp4$/);
    // Each copy is marked: a media copy (lists leave it out), minted for THIS
    // item, with its bytes in the ledger.
    for (const copy of m.importMedia) {
      const doc = await metaOf(copy.documentId);
      expect(doc).toMatchObject({
        uploadKind: "media-copy",
        mediaCopyOfLibraryItem: id,
      });
    }
    expect((await metaOf(m.importMedia[2].documentId)).intakeSource).toEqual({
      fileSha256: sha(MP4),
    });
    // The Library read model shows them (the value ARRIVES, not just the key).
    const [row] = (
      await client.query<{ id: string; metadata: unknown; created_at: Date }>(
        `select id, metadata, created_at from documents where id = $1`,
        [id]
      )
    ).rows;
    const view = toLibraryItemView({
      id: row!.id,
      metadata: row!.metadata,
      createdAt: row!.created_at,
    });
    expect(view?.media?.map((x) => x.sourceUrl)).toEqual([IMG1, IMG2, VID]);
    expect(view?.mediaFailed).toBeUndefined();
  });

  it("SVG disguised as PNG and HTML disguised as mp4 are refused, recorded, and never stored", async () => {
    const id = await item(A);
    const net = web({
      [IMG1]: () => respond([SVG], { type: "image/png" }),
      [VID]: () => respond([HTML], { type: "video/mp4" }),
    });
    const h = harness(net);
    const result = await copyLibraryItemMedia(
      {
        userId: A,
        itemId: id,
        media: media([IMG1, "image", 0], [VID, "video", 1]),
      },
      h.deps
    );
    expect(result).toEqual({
      status: "copied",
      copied: 0,
      reused: 0,
      failed: 2,
    });
    expect(h.stored).toEqual([]);
    expect(h.uploads.size).toBe(0);
    const m = await metaOf(id);
    expect(m.importMediaFailed).toBe(2);
    expect(
      m.importMediaFailures.map((f: any) => [f.sourceUrl, f.reason, f.attempts])
    ).toEqual([
      [IMG1, "not_image", 1],
      [VID, "not_video", 1],
    ]);
    const [row] = (
      await client.query<{ metadata: unknown }>(
        `select metadata from documents where id = $1`,
        [id]
      )
    ).rows;
    expect(
      toLibraryItemView({ id, metadata: row!.metadata, createdAt: new Date() })
        ?.mediaFailed
    ).toBe(2);

    // A permanent refusal is never fetched again.
    const again = await copyLibraryItemMedia(
      {
        userId: A,
        itemId: id,
        media: media([IMG1, "image", 0], [VID, "video", 1]),
      },
      h.deps
    );
    expect(again).toMatchObject({ status: "skipped", reason: "nothing_owed" });
    expect(net.hits).toEqual([IMG1, VID]);
  });

  it("a private-address URL is refused as blocked, without a request", async () => {
    const id = await item(A);
    const net = web({});
    const h = harness(net);
    await copyLibraryItemMedia(
      {
        userId: A,
        itemId: id,
        media: media(
          ["http://169.254.169.254/latest", "image", 0],
          ["http://10.0.0.5/v.mp4", "video", 1]
        ),
      },
      h.deps
    );
    expect(net.fetch).not.toHaveBeenCalled();
    expect(
      (await metaOf(id)).importMediaFailures.map((f: any) => f.reason)
    ).toEqual(["blocked", "blocked"]);
  });

  it("a transient failure is retried on the next run, then succeeds and clears the failure", async () => {
    const id = await item(A);
    let first = true;
    const net = web({
      [IMG1]: () => {
        if (first) {
          first = false;
          return respond([], { status: 503 });
        }
        return respond([PNG]);
      },
    });
    const h = harness(net);
    await copyLibraryItemMedia(
      { userId: A, itemId: id, media: media([IMG1, "image", 0]) },
      h.deps
    );
    expect((await metaOf(id)).importMediaFailures).toMatchObject([
      { reason: "http_5xx", attempts: 1 },
    ]);
    const r = await copyLibraryItemMedia(
      { userId: A, itemId: id, media: media([IMG1, "image", 0]) },
      h.deps
    );
    expect(r).toMatchObject({ copied: 1, failed: 0 });
    const m = await metaOf(id);
    expect(m.importMediaFailures).toEqual([]);
    expect(m.importMediaFailed).toBe(0);
    // Copied once: a third run fetches nothing.
    await copyLibraryItemMedia(
      { userId: A, itemId: id, media: media([IMG1, "image", 0]) },
      h.deps
    );
    expect(net.hits).toEqual([IMG1, IMG1]);
  });

  it("DEDUP: the same bytes kept again (another item, image or video) reuse the stored document", async () => {
    const first = await item(A);
    const second = await item(A);
    const net = web({
      [IMG1]: () => respond([PNG]),
      [IMG2]: () => respond([PNG]), // same bytes, another URL
      [VID]: () => respond([MP4]),
      "https://other.cdn.test/same.mp4": () => respond([MP4]),
    });
    const h = harness(net);
    await copyLibraryItemMedia(
      {
        userId: A,
        itemId: first,
        media: media([IMG1, "image", 0], [VID, "video", 1]),
      },
      h.deps
    );
    const r = await copyLibraryItemMedia(
      {
        userId: A,
        itemId: second,
        media: media(
          [IMG2, "image", 0],
          ["https://other.cdn.test/same.mp4", "video", 1]
        ),
      },
      h.deps
    );
    expect(r).toEqual({ status: "copied", copied: 2, reused: 2, failed: 0 });
    expect(h.stored).toHaveLength(1);
    const a = (await metaOf(first)).importMedia;
    const b = (await metaOf(second)).importMedia;
    expect(b.map((x: any) => x.documentId)).toEqual(
      a.map((x: any) => x.documentId)
    );
    expect(b.map((x: any) => x.sourceUrl)).toEqual([
      IMG2,
      "https://other.cdn.test/same.mp4",
    ]);
    // The streamed duplicate's object was deleted, not left behind.
    expect(h.uploads.size).toBe(2);
    expect(h.removed).toHaveLength(1);
    expect(h.uploads.has(h.removed[0]!)).toBe(true);
  });

  it("dedup is per person: another user's identical bytes are never reused", async () => {
    const theirs = await item(B);
    const mine = await item(A);
    const net = web({ [IMG1]: () => respond([PNG]) });
    const h = harness(net);
    await copyLibraryItemMedia(
      { userId: B, itemId: theirs, media: media([IMG1, "image", 0]) },
      h.deps
    );
    const r = await copyLibraryItemMedia(
      { userId: A, itemId: mine, media: media([IMG1, "image", 0]) },
      h.deps
    );
    expect(r).toMatchObject({ copied: 1, reused: 0 });
    expect(h.stored).toHaveLength(2);
  });

  it("owner floor: another person's item id is not_found and nothing is fetched", async () => {
    const theirs = await item(B);
    const net = web({ [IMG1]: () => respond([PNG]) });
    const r = await copyLibraryItemMedia(
      { userId: A, itemId: theirs, media: media([IMG1, "image", 0]) },
      harness(net).deps
    );
    expect(r).toMatchObject({ status: "skipped", reason: "not_found" });
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it("an item deleted while its media downloaded keeps nothing: the minted copies are discarded", async () => {
    const id = await item(A);
    const net = web({
      [IMG1]: () => {
        // The person deletes the item mid-run.
        void client.query(
          `update documents set deleted_at = now() where id = $1`,
          [id]
        );
        return respond([PNG]);
      },
    });
    const h = harness(net);
    const r = await copyLibraryItemMedia(
      { userId: A, itemId: id, media: media([IMG1, "image", 0]) },
      h.deps
    );
    expect(r).toMatchObject({ copied: 0 });
    expect(h.discarded).toHaveLength(1);
    expect((await metaOf(id)).importMedia).toBeUndefined();
  });

  it("unconfigured storage records every remaining URL as store_unavailable (never silent) and stops", async () => {
    const id = await item(A);
    const net = web({
      [IMG1]: () => respond([PNG]),
      [IMG2]: () => respond([PNG]),
    });
    const unconfigured = Object.assign(new Error("R2 storage requires …"), {
      name: "ValidationError",
      context: { provider: "r2" },
    });
    const h = harness(net, {
      store: (async () => {
        throw unconfigured;
      }) as never,
    });
    const r = await copyLibraryItemMedia(
      {
        userId: A,
        itemId: id,
        media: media([IMG1, "image", 0], [IMG2, "image", 1]),
      },
      h.deps
    );
    expect(r).toMatchObject({ copied: 0, failed: 2 });
    expect(net.hits).toEqual([IMG1]);
    expect(
      (await metaOf(id)).importMediaFailures.map((f: any) => f.reason)
    ).toEqual(["store_unavailable", "store_unavailable"]);
  });

  it("never throws: a broken database reads as skipped", async () => {
    const r = await copyLibraryItemMedia(
      { userId: A, itemId: randomUUID(), media: media([IMG1, "image", 0]) },
      {
        database: {
          select: () => {
            throw new Error("db down");
          },
        } as never,
      }
    );
    expect(r).toMatchObject({ status: "skipped", copied: 0 });
  });
});

describe("purge with the item (keep-alive)", () => {
  it("past the undo window: deletes the copies the Library minted and nobody else names; never a reused upload", async () => {
    const gone = await item(A, {}, { deletedDaysAgo: 400 });
    const live = await item(A);
    const minted = await insertDoc({
      user: A,
      mime: "image/png",
      size: 3,
      metadata: { uploadKind: "media-copy", mediaCopyOfLibraryItem: gone },
    });
    const shared = await insertDoc({
      user: A,
      mime: "image/png",
      size: 3,
      metadata: { uploadKind: "media-copy", mediaCopyOfLibraryItem: gone },
    });
    const upload = await insertDoc({
      user: A,
      mime: "image/png",
      size: 3,
      metadata: {
        uploadKind: "file-upload",
        intakeSource: { fileSha256: "x" },
      },
    });
    const copy = (documentId: string, order: number) => ({
      documentId,
      mime: "image/png",
      bytes: 3,
      sourceUrl: `https://cdn.test/${order}`,
      copiedAt: "2026-01-01T00:00:00Z",
      kind: "image",
      order,
    });
    await client.query(
      `update documents set metadata = metadata || $2::jsonb where id = $1`,
      [
        gone,
        JSON.stringify({
          importMedia: [copy(minted, 0), copy(shared, 1), copy(upload, 2)],
          importMediaFailed: 1,
          importMediaFailures: [
            { sourceUrl: "u", reason: "http_4xx", attempts: 1 },
          ],
        }),
      ]
    );
    await client.query(
      `update documents set metadata = metadata || $2::jsonb where id = $1`,
      [live, JSON.stringify({ importMedia: [copy(shared, 0)] })]
    );
    const removedDocs: string[] = [];
    const purged = await purgeDeletedLibraryItems({
      database,
      remove: async () => undefined,
      removeDocument: async (documentId) => {
        removedDocs.push(documentId);
      },
    });
    expect(purged).toBe(1);
    expect(removedDocs).toEqual([minted]);
    const m = await metaOf(gone);
    expect(m.importMedia).toBeUndefined();
    expect(m.importMediaFailed).toBeUndefined();
    expect(m.importMediaFailures).toBeUndefined();
    expect(m.importCuration.purgedAt).toBeTruthy();
  });

  it("inside the undo window nothing is touched", async () => {
    const recent = await item(A, {}, { deletedDaysAgo: 1 });
    const minted = await insertDoc({
      user: A,
      mime: "image/png",
      size: 3,
      metadata: { uploadKind: "media-copy", mediaCopyOfLibraryItem: recent },
    });
    await client.query(
      `update documents set metadata = metadata || $2::jsonb where id = $1`,
      [
        recent,
        JSON.stringify({
          importMedia: [
            {
              documentId: minted,
              mime: "image/png",
              bytes: 3,
              sourceUrl: "https://cdn.test/a",
              copiedAt: "x",
              kind: "image",
              order: 0,
            },
          ],
        }),
      ]
    );
    const removedDocs: string[] = [];
    await purgeDeletedLibraryItems({
      database,
      remove: async () => undefined,
      removeDocument: async (d) => {
        removedDocs.push(d);
      },
    });
    expect(removedDocs).toEqual([]);
    expect((await metaOf(recent)).importMedia).toHaveLength(1);
  });
});

describe("imageFromLibraryCopy (the hand-off read)", () => {
  async function libraryHolding(
    user: string,
    sourceUrl: string,
    bytes: Buffer,
    opts: { deletedDaysAgo?: number } = {}
  ) {
    const docId = await insertDoc({
      user,
      mime: "image/png",
      size: bytes.byteLength,
      storageKey: `k/${randomUUID()}`,
      metadata: { uploadKind: "media-copy" },
    });
    const id = await item(
      user,
      {
        importMedia: [
          {
            documentId: docId,
            mime: "image/png",
            bytes: bytes.byteLength,
            sourceUrl,
            copiedAt: "x",
            kind: "image",
            order: 0,
          },
        ],
      },
      opts
    );
    return { id, docId };
  }

  // Coverage boundary (measured): the owner floor is applied TWICE (the item
  // query and the copy-document query). Removing ONE leaves this green — the
  // other still holds; removing both turns it red.
  it("answers the person's own Library copy, re-sniffed; null for anyone else, a deleted item, or bytes that are not an image", async () => {
    await libraryHolding(A, IMG1, PNG);
    await libraryHolding(A, IMG2, Buffer.from(SVG));
    await libraryHolding(A, "https://cdn.test/deleted.png", PNG, {
      deletedDaysAgo: 1,
    });
    const blobs = new Map<string, Buffer>();
    const { rows } = await client.query<{ storage_key: string; size: number }>(
      `select storage_key, size from documents where storage_key like 'k/%'`
    );
    for (const r of rows)
      blobs.set(
        r.storage_key,
        r.size === PNG.byteLength ? PNG : Buffer.from(SVG)
      );
    const download = vi.fn(async (key: string) => blobs.get(key)!);

    const got = await imageFromLibraryCopy(A, IMG1, { database, download });
    expect(got).toMatchObject({
      ok: true,
      mime: "image/png",
      width: 40,
      height: 30,
    });
    expect(got!.bytes.equals(PNG)).toBe(true);
    expect(
      await imageFromLibraryCopy(B, IMG1, { database, download })
    ).toBeNull();
    expect(
      await imageFromLibraryCopy(A, IMG2, { database, download })
    ).toBeNull();
    expect(
      await imageFromLibraryCopy(A, "https://cdn.test/deleted.png", {
        database,
        download,
      })
    ).toBeNull();
    expect(
      await imageFromLibraryCopy(A, "https://cdn.test/never-kept.png", {
        database,
        download,
      })
    ).toBeNull();
  });
});
