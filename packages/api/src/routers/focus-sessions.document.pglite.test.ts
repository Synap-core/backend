/**
 * `focusSessions.document` — the pod tRPC read door for THE session document
 * (`readSessionDocument`, `services/session-document/upsert-section.ts`).
 * Mirrors the hub-protocol `getSessionDocument` procedure
 * (`routers/hub-protocol/documents.ts`) one-for-one: both call the SAME
 * function, never a re-implementation.
 *
 * Real: the router procedure, `readSessionDocument`, `loadOwnedSession`
 * (the owner floor), `findSessionDocumentId`, `parseSections`.
 *
 * Stubbed, and why:
 *  - `@synap/storage` — an in-memory blob map, same pattern as
 *    `upsert-section.pglite.test.ts`.
 *
 * Negative control run for this file: with the owner filter in
 * `loadOwnedSession` (`session-document.ts:56`) removed — reading
 * ANY user's row regardless of `userId` — the "other user's session is
 * NOT_FOUND" case below turned RED (it returned the document instead of
 * throwing). Confirmed, then reverted.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  blobs: new Map<string, string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        documents: schema.documents,
        documentVersions: schema.documentVersions,
        focusSessions: schema.focusSessions,
        artifacts: schema.artifacts,
      } as never,
    }),
  };
});

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (u: string, k: string, id: string, ext: string) =>
      `${u}/${k}/${id}.${ext}`,
    upload: async (key: string, body: string | Buffer) => {
      h.blobs.set(key, Buffer.isBuffer(body) ? body.toString("utf-8") : body);
      return { url: key, path: key, size: 1 };
    },
    downloadBuffer: async (key: string) =>
      Buffer.from(h.blobs.get(key) ?? "", "utf-8"),
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  documents,
  documentVersions,
  focusSessions,
  artifacts,
} from "@synap/database/schema";
import { db } from "@synap/database";
import { focusSessionsRouter } from "./focus-sessions.js";

const USER = "user-1";
const OTHER = "user-2";
const AGENT = "agent-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const document = (id: string, callerUserId: string) =>
  focusSessionsRouter
    .createCaller({ db, authenticated: true, userId: callerUserId } as never)
    .document({ sessionId: id });

async function newSession(userId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, current_stage) values ($1, $2, 'Find leads', 'active', '{}'::jsonb, 'draft')`,
    [id, userId]
  );
  return id;
}

/** Designates a document on the session the way `getOrCreateSessionDocument` would, with one section already written. */
async function seedDocument(
  sessionId: string,
  content: string
): Promise<string> {
  const documentId = randomUUID();
  const storageKey = `${USER}/document/${documentId}.md`;
  h.blobs.set(storageKey, content);
  await q(
    // content_revision spelled out: this file's DDL helper drops column
    // defaults (0275 gives it DEFAULT 1 in a real database).
    `insert into documents (id, user_id, title, type, storage_key, mime_type, current_version, last_saved_version, content_revision)
     values ($1, $2, 'Doc', 'markdown', $3, 'text/markdown', 1, 1, 1)`,
    [documentId, USER, storageKey]
  );
  await q(
    `insert into artifacts (id, user_id, kind, ref_id, title, origin_kind, session_id, state, props, created_at, updated_at)
     values ($1, $2, 'document', $3, 'Doc', 'agent', $4, 'kept', $5::jsonb, now(), now())`,
    [
      randomUUID(),
      USER,
      documentId,
      sessionId,
      JSON.stringify({ expectedLabel: "session-document" }),
    ]
  );
  return documentId;
}

const SECTION = `::::synap-section{id="approach" owner="ai" author="${AGENT}" writtenAt="2026-09-14T00:00:00.000Z" sessionState="active"}
## Approach

Draft one.
::::
`;

beforeAll(async () => {
  for (const table of [documents, documentVersions, focusSessions, artifacts]) {
    await h.client!.exec(ddlFor(table as PgTable));
  }
});

beforeEach(async () => {
  h.blobs.clear();
  await h.client!.exec(
    `delete from artifacts; delete from documents; delete from focus_sessions;`
  );
});

describe("focusSessions.document", () => {
  it("a session with a designated document returns its content, version and sections", async () => {
    const sessionId = await newSession(USER);
    const documentId = await seedDocument(sessionId, SECTION);

    const result = await document(sessionId, USER);
    expect(result).toMatchObject({
      documentId,
      version: 1,
      // The content revision reaches the reader — it is the base a writer
      // passes back as `baseRevision`.
      revision: 1,
      content: SECTION,
    });
    expect(result.sections).toEqual([
      {
        id: "approach",
        owner: "ai",
        author: AGENT,
        writtenAt: "2026-09-14T00:00:00.000Z",
        sessionState: "active",
      },
    ]);
  });

  it("a session with no document returns documentId null and no sections", async () => {
    const sessionId = await newSession(USER);
    const result = await document(sessionId, USER);
    expect(result).toEqual({
      documentId: null,
      version: null,
      revision: null,
      content: null,
      sections: [],
    });
  });

  it("another user's session is NOT_FOUND — the owner floor, not an empty document", async () => {
    const sessionId = await newSession(USER);
    await seedDocument(sessionId, SECTION);
    await expect(document(sessionId, OTHER)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("this door and the hub-protocol door read the identical function — mirrored, not a fork", async () => {
    const sessionId = await newSession(USER);
    await seedDocument(sessionId, SECTION);
    const { readSessionDocument } =
      await import("../services/session-document/upsert-section.js");
    const direct = await readSessionDocument({ sessionId, userId: USER });
    const viaRouter = await document(sessionId, USER);
    expect(viaRouter).toEqual(direct);
  });
});
