/**
 * What a hard delete reclaims, on PGlite: body + source-file documents and the
 * pod-held media copies — the latter only when the entity's owner owns them.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { reclaimableDocumentIds } from "./entity-reclaimable-documents.js";

const client = new PGlite();
const database = drizzle(client, { schema });

const OWNER = "rc-owner";
const OTHER = "rc-other";
const BODY = randomUUID();
const SRC = randomUUID();
const MEDIA = randomUUID();
const FOREIGN = randomUUID(); // OTHER's document listed in OWNER's systemData

const copy = (documentId: string) => ({
  documentId,
  mime: "image/png",
  bytes: 1,
  sourceUrl: `https://x.test/${documentId}.png`,
  copiedAt: "2026-10-14T00:00:00.000Z",
});

beforeAll(async () => {
  const docs = (schema as Record<string, unknown>).documents as PgTable;
  const cfg = getTableConfig(docs);
  const cols = cfg.columns.map(
    (c) => `"${c.name}" text${c.primary ? " primary key" : ""}`
  );
  await client.exec(`create table "${cfg.name}" (${cols.join(", ")});`);
  for (const [id, user] of [
    [BODY, OWNER],
    [SRC, OWNER],
    [MEDIA, OWNER],
    [FOREIGN, OTHER],
  ]) {
    await client.query(
      `insert into documents (id, user_id) values ($1, $2)`,
      [id, user]
    );
  }
});

describe("reclaimableDocumentIds", () => {
  it("body + source file + the owner's media copies; never another user's document", async () => {
    const ids = await reclaimableDocumentIds(database as never, {
      userId: OWNER,
      documentId: BODY,
      properties: { sourceFileDocumentId: SRC },
      systemData: { media: [copy(MEDIA), copy(FOREIGN)] },
    });
    expect(ids.sort()).toEqual([BODY, SRC, MEDIA].sort());
  });

  it("no media: exactly the owned body/source documents", async () => {
    expect(
      await reclaimableDocumentIds(database as never, {
        userId: OWNER,
        documentId: BODY,
        properties: {},
        systemData: { other: true },
      })
    ).toEqual([BODY]);
  });
});
