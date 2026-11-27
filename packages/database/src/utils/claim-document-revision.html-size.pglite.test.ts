import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const blobs = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("@synap/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/storage")>();
  const minio = new actual.MinIOStorageProvider({
    endpoint: "http://minio.test",
    accessKeyId: "k",
    secretAccessKey: "s",
    bucketName: "b",
  });
  (minio as unknown as { client: unknown }).client = {
    send: async (cmd: { input: { Key?: string; Body?: Buffer } }) => {
      if (cmd.input.Key && cmd.input.Body !== undefined) {
        blobs.set(cmd.input.Key, Buffer.from(cmd.input.Body));
      }
      return {};
    },
  };
  return {
    ...actual,
    storage: {
      upload: vi.fn(
        (
          key: string,
          content: string | Buffer,
          opts?: { contentType?: string }
        ) => minio.upload(key, content, opts)
      ),
      downloadBuffer: vi.fn(async (key: string) => {
        const b = blobs.get(key);
        if (!b) throw new Error(`no blob ${key}`);
        return b;
      }),
      buildPath: (u: string, k: string, id: string, ext: string) =>
        `${u}/${k}/${id}.${ext}`,
    },
  };
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { storage } from "@synap/storage";
import { documents, documentVersions } from "../schema/documents.js";
import {
  claimDocumentRevision,
  DocumentWriteTargetError,
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

let pg: PGlite;
let db: ReturnType<typeof drizzle>;
const HUMAN = { authorKind: "user" as const, authorId: "user-1" };
/** One byte over the 2 MB a page may hold (`CELL_FRAME_MAX_BYTES`). */
const TOO_BIG = "<p>" + "x".repeat(2 * 1024 * 1024) + "</p>";

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg);
  await pg.exec(ddlFor(documents));
  await pg.exec(ddlFor(documentVersions));
}, 120_000);

beforeEach(() => blobs.clear());

async function seedDoc(type: string, mimeType: string, content: string) {
  const id = randomUUID();
  const key = `u/doc/${id}.${type}`;
  const stamped = await storage.upload(key, content);
  await db.insert(documents).values({
    id,
    userId: "user-1",
    title: "t",
    type,
    mimeType,
    storageKey: key,
  });
  await db.insert(documentVersions).values({
    documentId: id,
    version: 1,
    content,
    checksum: stamped.checksum,
    author: HUMAN.authorKind,
    authorId: HUMAN.authorId,
    message: "Initial",
  });
  return { id, key };
}

const claim = (id: string, content: string) =>
  db.transaction((tx) =>
    claimDocumentRevision(
      tx as unknown as Parameters<typeof claimDocumentRevision>[0],
      id,
      undefined,
      HUMAN,
      { content }
    )
  );

const revisionOf = async (id: string) =>
  (
    await pg.query<{ content_revision: number }>(
      `select content_revision from documents where id = $1`,
      [id]
    )
  ).rows[0]!.content_revision;

/**
 * An HTML page is at most 2 MB on EVERY content write, not only at create
 * (surfaces review S4, 27 Nov 2026): the claim door refuses a larger one,
 * inside its transaction, so nothing moves.
 *
 * Rows, each ruling out a wrong outcome:
 *  - an html page edited past 2 MB: refused (BAD_REQUEST, the create door's
 *    sentence), the revision and the stored bytes unchanged (rules out "an
 *    edit grows a page past what create refuses");
 *  - a legacy html-embed source (`text` + `text/html`): refused the same;
 *  - the same content into a markdown document or a stored file: written
 *    (rules out "every large write is refused");
 *  - an html page edited within 2 MB: written.
 */
describe("claimDocumentRevision — an HTML page stays within 2 MB", () => {
  it("an html page edited past 2 MB: refused, nothing moves", async () => {
    const { id, key } = await seedDoc("html", "text/html", "<p>v1</p>");
    const err = await claim(id, TOO_BIG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DocumentWriteTargetError);
    expect(err).toMatchObject({ code: "BAD_REQUEST" });
    expect((err as Error).message).toContain("at most");
    expect(await revisionOf(id)).toBe(1);
    expect(blobs.get(key)!.toString()).toBe("<p>v1</p>");
  });

  it("a legacy html-embed source (text + text/html): refused the same", async () => {
    const { id } = await seedDoc("text", "text/html", "<p>v1</p>");
    await expect(claim(id, TOO_BIG)).rejects.toBeInstanceOf(
      DocumentWriteTargetError
    );
    expect(await revisionOf(id)).toBe(1);
  });

  it("the same bytes into a markdown document or a stored file: written", async () => {
    const md = await seedDoc("markdown", "text/markdown", "v1");
    expect((await claim(md.id, TOO_BIG)).revision).toBe(2);
    const file = await seedDoc("file", "text/html", "v1");
    expect((await claim(file.id, TOO_BIG)).revision).toBe(2);
  });

  it("an html page edited within 2 MB: written", async () => {
    const { id } = await seedDoc("html", "text/html", "<p>v1</p>");
    expect((await claim(id, "<p>v2</p>")).revision).toBe(2);
  });
});
