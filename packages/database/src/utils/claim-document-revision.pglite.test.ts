/**
 * REAL-POSTGRES (PGlite) test for `claimDocumentRevision` — the ONE content-write
 * door — and migration 0275 that adds its columns.
 *
 * Pinned:
 *   - 0275 adds `content_revision` (NOT NULL DEFAULT 1) and
 *     `working_state_revision` idempotently;
 *   - a same-author save bumps the revision, writes storage and cuts NO row;
 *   - an author switch cuts the pre-image under the PREVIOUS author only when the
 *     content drifted from their checkpoint, then a row under the NEW author;
 *   - a stale `baseRevision` (or legacy `baseVersion`) is a conflict and writes
 *     nothing;
 *   - a checkpoint-only claim skips when unchanged (the autosave cron) and cuts a
 *     row when changed;
 *   - only a collaborative write-back marks the Yjs cache current.
 *
 * ENGINE: one PGlite per file; `documents` / `document_versions` are created from
 * their drizzle definitions. Storage is an in-memory map (the door's upload is
 * what is under test, not MinIO).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const blobs = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("@synap/storage", () => ({
  storage: {
    upload: vi.fn(async (key: string, content: string | Buffer) => {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
      blobs.set(key, buf);
      const { createHash } = await import("node:crypto");
      return {
        url: `mem://${key}`,
        path: key,
        size: buf.byteLength,
        checksum: `sha256:${createHash("sha256").update(buf).digest("hex")}`,
      };
    }),
    downloadBuffer: vi.fn(async (key: string) => {
      const b = blobs.get(key);
      if (!b) throw new Error(`no blob ${key}`);
      return b;
    }),
    buildPath: (u: string, k: string, id: string, ext: string) =>
      `${u}/${k}/${id}.${ext}`,
  },
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { documents, documentVersions } from "../schema/documents.js";
import {
  claimDocumentRevision,
  DocumentRevisionConflictError,
  documentContentChecksum,
  INHERIT_LAST_AUTHOR,
} from "./claim-document-revision.js";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    const type = c.getSQLType();
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    const nn = c.notNull && !c.primary ? " not null" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${nn}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

const MIGRATION = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../migrations/0275_document_content_revision.sql"
  ),
  "utf8"
);

let pg: PGlite;
let db: ReturnType<typeof drizzle>;
const HUMAN = { authorKind: "user" as const, authorId: "user-1" };
const AGENT = { authorKind: "ai" as const, authorId: "agent-1" };

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg);
  await pg.exec(ddlFor(documents));
  await pg.exec(ddlFor(documentVersions));
}, 120_000);

beforeEach(() => blobs.clear());

async function seedDoc(content: string, v1Author = AGENT) {
  const id = randomUUID();
  const key = `u/doc/${id}.md`;
  blobs.set(key, Buffer.from(content));
  await db.insert(documents).values({
    id,
    userId: "user-1",
    title: "t",
    type: "markdown",
    mimeType: "text/markdown",
    storageKey: key,
  });
  await db.insert(documentVersions).values({
    documentId: id,
    version: 1,
    content,
    checksum: documentContentChecksum(content),
    author: v1Author.authorKind,
    authorId: v1Author.authorId,
    message: "Initial",
  });
  return { id, key };
}

const claim = (
  ...args: Parameters<typeof claimDocumentRevision> extends [
    unknown,
    ...infer R,
  ]
    ? R
    : never
) =>
  db.transaction((tx) =>
    claimDocumentRevision(
      tx as unknown as Parameters<typeof claimDocumentRevision>[0],
      ...args
    )
  );

async function rows(id: string) {
  const r = await pg.query<{
    version: number;
    author: string;
    content: string;
  }>(
    `select version, author, content from document_versions where document_id = $1 order by version`,
    [id]
  );
  return r.rows;
}
async function docRow(id: string) {
  const r = await pg.query<{
    content_revision: number;
    current_version: number;
    working_state_revision: number | null;
  }>(
    `select content_revision, current_version, working_state_revision from documents where id = $1`,
    [id]
  );
  return r.rows[0]!;
}

describe("migration 0275", () => {
  it("adds both columns idempotently on a pre-0275 table", async () => {
    const pre = new PGlite();
    await pre.exec(`create table documents (id uuid primary key, title text);`);
    await pre.exec(`insert into documents values (gen_random_uuid(), 'x');`);
    await pre.exec(MIGRATION);
    await pre.exec(MIGRATION);
    const { rows: r } = await pre.query<{
      content_revision: number;
      working_state_revision: number | null;
    }>(`select content_revision, working_state_revision from documents`);
    expect(r).toEqual([{ content_revision: 1, working_state_revision: null }]);
    await pre.close();
  }, 120_000);
});

describe("claimDocumentRevision", () => {
  it("same-author save: revision bumps, storage written, no row", async () => {
    const { id, key } = await seedDoc("a", HUMAN);
    const out = await claim(id, 1, HUMAN, { content: "ab" });
    expect(out.revision).toBe(2);
    expect(out.authorSwitched).toBe(false);
    expect(out.checkpointVersionId).toBeNull();
    expect(blobs.get(key)!.toString()).toBe("ab");
    expect(await rows(id)).toHaveLength(1);
    expect((await docRow(id)).current_version).toBe(1);
  });

  it("author switch: pre-image under the previous author only when drifted, then a row for the new author", async () => {
    const { id } = await seedDoc("agent text", AGENT);
    // human after agent, no drift → no pre-image, one human row
    const h1 = await claim(id, undefined, HUMAN, {
      content: "agent text\nhuman",
    });
    expect(h1.authorSwitched).toBe(true);
    expect(await rows(id)).toEqual([
      { version: 1, author: "ai", content: "agent text" },
      { version: 2, author: "user", content: "agent text\nhuman" },
    ]);
    // human keeps typing: same author, no rows
    await claim(id, undefined, HUMAN, { content: "agent text\nhuman more" });
    expect(await rows(id)).toHaveLength(2);
    // agent writes: the human's drift is captured under the HUMAN first
    const a = await claim(id, undefined, AGENT, {
      content: "rewritten",
      checkpoint: { message: "AI edit accepted" },
    });
    expect(await rows(id)).toEqual([
      { version: 1, author: "ai", content: "agent text" },
      { version: 2, author: "user", content: "agent text\nhuman" },
      { version: 3, author: "user", content: "agent text\nhuman more" },
      { version: 4, author: "ai", content: "rewritten" },
    ]);
    expect(a.currentVersion).toBe(4);
    expect((await docRow(id)).current_version).toBe(4);
    expect(a.undoVersionId).not.toBeNull();
  });

  it("stale baseRevision is a conflict and writes nothing", async () => {
    const { id, key } = await seedDoc("a", HUMAN);
    await claim(id, 1, HUMAN, { content: "b" });
    await expect(
      claim(id, 1, AGENT, { content: "evil" })
    ).rejects.toBeInstanceOf(DocumentRevisionConflictError);
    expect(blobs.get(key)!.toString()).toBe("b");
    expect((await docRow(id)).content_revision).toBe(2);
  });

  it("legacy baseVersion is checked against current_version", async () => {
    const { id } = await seedDoc("a", HUMAN);
    await expect(
      claim(id, undefined, AGENT, { content: "x", baseVersion: 7 })
    ).rejects.toBeInstanceOf(DocumentRevisionConflictError);
    await expect(
      claim(id, undefined, AGENT, { content: "x", baseVersion: 1 })
    ).resolves.toMatchObject({ contentChanged: true });
  });

  it("checkpoint-only: skips when unchanged, cuts a row when changed, never moves the revision", async () => {
    const { id } = await seedDoc("a", HUMAN);
    const same = await claim(id, undefined, HUMAN, {
      checkpoint: { message: "Auto-save checkpoint" },
      skipIfUnchanged: true,
    });
    expect(same.skipped).toBe(true);
    expect(await rows(id)).toHaveLength(1);
    await claim(id, undefined, HUMAN, { content: "a2" });
    const changed = await claim(id, undefined, HUMAN, {
      checkpoint: { message: "Auto-save checkpoint" },
      skipIfUnchanged: true,
    });
    expect(changed.skipped).toBe(false);
    expect(await rows(id)).toHaveLength(2);
    expect((await docRow(id)).content_revision).toBe(2);
  });

  it("a pod checkpoint inherits the last author; a content write may not inherit", async () => {
    const { id } = await seedDoc("a", AGENT);
    await claim(id, undefined, HUMAN, { content: "a+h" });
    await claim(id, undefined, HUMAN, { content: "a+h+more" });
    await claim(id, undefined, INHERIT_LAST_AUTHOR, {
      checkpoint: { message: "Auto-save checkpoint" },
      skipIfUnchanged: true,
    });
    const r = await rows(id);
    expect(r.at(-1)).toEqual({
      version: 3,
      author: "user",
      content: "a+h+more",
    });
    await expect(
      claim(id, undefined, INHERIT_LAST_AUTHOR, { content: "x" })
    ).rejects.toThrow(/must name its author/);
  });

  it("only a collaborative write-back marks the Yjs cache current", async () => {
    const { id } = await seedDoc("a", HUMAN);
    await claim(id, undefined, HUMAN, {
      content: "b",
      source: "collab-writeback",
    });
    expect(await docRow(id)).toMatchObject({
      content_revision: 2,
      working_state_revision: 2,
    });
    await claim(id, undefined, AGENT, {
      content: "c",
      checkpoint: { message: "AI edit accepted" },
    });
    expect(await docRow(id)).toMatchObject({
      content_revision: 3,
      working_state_revision: 2,
    });
  });
});
