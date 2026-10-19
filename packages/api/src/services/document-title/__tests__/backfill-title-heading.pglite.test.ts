/**
 * The one-title backfill on PGlite: real `documents` / `document_versions` /
 * `pod_settings` rows, documents seeded through the REAL create door the way
 * they were stored before the one-title rule (`verbatim`, which skips it), the
 * real scope query, the real revision door (`claimDocumentRevision`) and the
 * real restore worker. Only the blob store and the realtime emit are faked.
 *
 * Rows that rule out a wrong rule:
 *   - a heading that DIFFERS from the name stays (an "any leading heading"
 *     rule would drop it);
 *   - an intake raw stays byte for byte (a re-structure replays it);
 *   - a nameless document, an html document, a deleted one and one created
 *     after the pass began are never written;
 *   - the second run changes nothing, with or without the stamp;
 *   - one document that cannot be read never stops the others, is retried on
 *     the next run, and is abandoned (listed, logged) after the max attempts —
 *     never counted as changed.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  blobs: new Map<string, string>(),
  unreadable: new Set<string>(),
  emitted: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return {
    ...actual,
    db,
    getDb: async () => db,
    emitDocumentContentReplaced: async (t: { documentId: string }) => {
      h.emitted.push(t.documentId);
      return { ok: true };
    },
  };
});

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (u: string, k: string, id: string, ext: string) =>
      `${u}/${k}/${id}.${ext}`,
    upload: async (key: string, body: string | Buffer) => {
      const text = Buffer.isBuffer(body) ? body.toString("utf-8") : body;
      h.blobs.set(key, text);
      const checksum = `sha256:${createHash("sha256").update(text).digest("hex")}`;
      return { url: key, path: key, size: text.length, checksum };
    },
    downloadBuffer: async (key: string) => {
      if (h.unreadable.has(key)) throw new Error("storage unavailable");
      return Buffer.from(h.blobs.get(key) ?? "", "utf-8");
    },
  },
}));

// The restore worker's own side effects — not this seam.
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("@synap/jobs/utils/realtime-broadcast.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastSuccess: vi.fn(async () => ({ success: true })),
}));

import {
  createDocumentWithContent,
  documents,
  documentVersions,
  podSettings,
} from "@synap/database";
import { handleDocumentRestore } from "@synap/jobs/workers/snapshot-worker.js";
import { pgliteSchemaDdl } from "../../../__tests__/pglite-ddl.js";
import {
  backfillDocumentTitleHeadings,
  DOCUMENT_TITLE_HEADING_BACKFILL_MAX_ATTEMPTS,
  DOCUMENT_TITLE_HEADING_BACKFILL_MESSAGE,
  DOCUMENT_TITLE_HEADING_BACKFILL_SETTINGS_KEY,
} from "../backfill-title-heading.js";

const USER = randomUUID();
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const eventRepo = { append: async () => ({ id: randomUUID() }) } as never;

/** A document stored as before the one-title rule: body exactly as given. */
async function seed(input: {
  title: string;
  content: string;
  type?: "markdown" | "html";
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const doc = await createDocumentWithContent(h.db, eventRepo, {
    ownerUserId: USER,
    title: input.title,
    type: input.type ?? "markdown",
    content: input.content,
    mimeType: "text/markdown",
    metadata: input.metadata,
    provenance: { createdByKind: "human" },
    verbatim: true,
  });
  // The pass's cutoff is "now" at its first run: seed strictly before it.
  await q(
    `update documents set created_at = now() - interval '1 hour' where id = $1`,
    [doc.id]
  );
  return doc.id;
}

async function stored(id: string) {
  const { rows } = await q<{
    title: string;
    storage_key: string;
    content_revision: number;
  }>(
    `select title, storage_key, content_revision from documents where id = $1`,
    [id]
  );
  const row = rows[0]!;
  return {
    title: row.title,
    body: h.blobs.get(row.storage_key),
    revision: row.content_revision,
    key: row.storage_key,
  };
}

async function versions(id: string) {
  const { rows } = await q<{
    id: string;
    version: number;
    author: string;
    author_id: string;
    message: string | null;
  }>(
    `select id, version, author, author_id, message from document_versions where document_id = $1 order by version`,
    [id]
  );
  return rows;
}

async function marker(): Promise<Record<string, any> | null> {
  const { rows } = await q<{ s: Record<string, any> }>(
    `select settings as s from pod_settings limit 1`
  );
  return rows[0]?.s?.[DOCUMENT_TITLE_HEADING_BACKFILL_SETTINGS_KEY] ?? null;
}

beforeAll(async () => {
  await h.client!.exec(
    pgliteSchemaDdl([documents, documentVersions, podSettings])
  );
});
beforeEach(async () => {
  await h.client!.exec(
    `delete from documents; delete from document_versions; delete from pod_settings;`
  );
  h.blobs.clear();
  h.unreadable.clear();
  h.emitted = [];
});

describe("backfillDocumentTitleHeadings", () => {
  it("drops a leading heading equal to the name — only there — and counts every skip by reason", async () => {
    const same = await seed({
      title: "Launch plan",
      content: "# Launch plan\n\nShip on Friday.\n",
    });
    const marked = await seed({
      title: "Q3 plan",
      content: "## **q3** `plan`\nGoals.\n",
    });
    const differs = await seed({
      title: "Pinned surfaces — spec",
      content: "# Pinned surfaces\n\nA pin.\n",
    });
    const noHeading = await seed({
      title: "Notes",
      content: "Just text.\n\n# Notes\n",
    });
    const raw = await seed({
      title: "Call with Inès",
      content: "# Call with Inès\n\nWants the portal.",
      metadata: { intakeSource: { door: "test" } },
    });
    const nameless = await seed({ title: "x", content: "# \n\nBody\n" });
    await q(`update documents set title = '  ' where id = $1`, [nameless]);
    const html = await seed({
      title: "Launch plan",
      content: "# Launch plan\n<p>x</p>",
      type: "html",
    });
    const deleted = await seed({
      title: "Old",
      content: "# Old\n\nGone.\n",
    });
    await q(`update documents set deleted_at = now() where id = $1`, [deleted]);
    const late = await seed({ title: "Late", content: "# Late\n\nNew.\n" });
    await q(
      `update documents set created_at = now() + interval '1 hour' where id = $1`,
      [late]
    );

    const r = await backfillDocumentTitleHeadings({ batchSize: 2 });

    expect(r).toEqual({
      status: "completed",
      scanned: 6,
      changed: 2,
      skipped: { nameless: 1, verbatim: 1, noHeading: 1, differs: 1 },
      failed: 0,
      abandoned: 0,
    });
    expect(await stored(same)).toMatchObject({
      title: "Launch plan",
      body: "Ship on Friday.\n",
      revision: 2,
    });
    expect((await stored(marked)).body).toBe("Goals.\n");
    expect((await stored(differs)).body).toBe("# Pinned surfaces\n\nA pin.\n");
    expect((await stored(noHeading)).body).toBe("Just text.\n\n# Notes\n");
    expect((await stored(raw)).body).toBe(
      "# Call with Inès\n\nWants the portal."
    );
    expect((await stored(html)).body).toBe("# Launch plan\n<p>x</p>");
    expect((await stored(deleted)).body).toBe("# Old\n\nGone.\n");
    expect((await stored(late)).body).toBe("# Late\n\nNew.\n");
    for (const id of [differs, noHeading, raw, nameless, html, deleted, late])
      expect((await stored(id)).revision).toBe(1);
    // Open editors of exactly the changed documents are told.
    expect(h.emitted.sort()).toEqual([same, marked].sort());
  });

  it("records each change as a system revision a person can restore", async () => {
    const id = await seed({
      title: "Launch plan",
      content: "# Launch plan\n\nShip on Friday.\n",
    });
    await backfillDocumentTitleHeadings();

    const rows = await versions(id);
    const last = rows[rows.length - 1]!;
    expect(last).toMatchObject({
      author: "system",
      author_id: "document-title-backfill",
      message: DOCUMENT_TITLE_HEADING_BACKFILL_MESSAGE,
    });
    // The version before it holds the body as it stood, under its author.
    const before = rows[rows.length - 2]!;
    expect(before.author).toBe("user");

    await handleDocumentRestore({
      data: { documentId: id, versionId: before.id, userId: USER },
    } as never);
    expect((await stored(id)).body).toBe("# Launch plan\n\nShip on Friday.\n");
  });

  it("a second run changes nothing — stamped, and also when the stamp is gone", async () => {
    const id = await seed({
      title: "Launch plan",
      content: "# Launch plan\n\nShip on Friday.\n",
    });
    await backfillDocumentTitleHeadings();
    const after = await stored(id);
    const rowCount = (await versions(id)).length;

    const again = await backfillDocumentTitleHeadings();
    expect(again.status).toBe("already-complete");

    await q(`update pod_settings set settings = '{}'::jsonb`);
    const rejudged = await backfillDocumentTitleHeadings();
    expect(rejudged).toMatchObject({ status: "completed", changed: 0 });
    expect(rejudged.skipped.noHeading).toBe(1);
    expect(await stored(id)).toEqual(after);
    expect(await versions(id)).toHaveLength(rowCount);
  });

  it("an unreadable document never stops the pass: retried next run, abandoned after the max", async () => {
    const ok = await seed({ title: "A", content: "# A\n\nBody A.\n" });
    const bad = await seed({ title: "B", content: "# B\n\nBody B.\n" });
    h.unreadable.add((await stored(bad)).key);

    const first = await backfillDocumentTitleHeadings();
    expect(first).toMatchObject({
      status: "pending-retries",
      changed: 1,
      failed: 1,
    });
    expect((await stored(ok)).body).toBe("Body A.\n");
    expect((await marker())?.completedAt).toBeUndefined();
    expect((await marker())?.failed?.[bad]?.attempts).toBe(1);

    // Readable again: the retry judges it like any other.
    h.unreadable.clear();
    const second = await backfillDocumentTitleHeadings();
    expect(second).toMatchObject({
      status: "completed",
      changed: 2,
      failed: 0,
    });
    expect((await stored(bad)).body).toBe("Body B.\n");
  });

  it("a document that keeps failing is abandoned and listed, never counted as changed", async () => {
    const bad = await seed({ title: "B", content: "# B\n\nBody B.\n" });
    h.unreadable.add((await stored(bad)).key);
    let r = await backfillDocumentTitleHeadings();
    for (let i = 1; i < DOCUMENT_TITLE_HEADING_BACKFILL_MAX_ATTEMPTS; i++)
      r = await backfillDocumentTitleHeadings();
    expect(r).toMatchObject({
      status: "completed",
      changed: 0,
      failed: 0,
      abandoned: 1,
    });
    expect((await marker())?.abandoned).toEqual([bad]);
    expect((await stored(bad)).body).toBe("# B\n\nBody B.\n");
  });
});
