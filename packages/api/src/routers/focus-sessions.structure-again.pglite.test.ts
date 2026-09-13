/**
 * STRUCTURE AGAIN — driven through the REAL `focusSessions.structureAgain`
 * procedure on PGlite (W2: "the first extraction is not the only chance").
 *
 * Real: the procedure (auth, rate-limit middleware, NOT_FOUND mapping), the
 * access layer read (`scopedDb` over `entities` — the caller's floor), the
 * write gate, `ensureIntakeSession`, `stageIntakeSource` through the real
 * `DocumentRepository`, `recordSessionRunManifest`. Every assertion reads rows
 * back. Tables are generated from the Drizzle definitions.
 *
 * Stubbed, and why:
 *  - `openRunSession` — lives on `@synap/database`'s own connection; the stub
 *    inserts the row with what it was handed (origin, `subject_entity_id`,
 *    metadata), so it proves what the door PASSES, not openRunSession's insert.
 *  - `replayCaptureSource` — the capture door needs the IS, profiles and search.
 *    The spy is the IS boundary; it records what it was asked to structure.
 *  - `@synap/storage`, the event fan-out, and the read-only guard.
 *
 * NOT covered (NEEDS-DOGFOOD): a real structure → proposal landing in the room.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  opened: [] as Array<Record<string, unknown>>,
  replays: [] as Array<{ source: unknown; args: unknown; who: unknown }>,
  replayThrows: false,
  /** Stored objects by key — what `storage.downloadBuffer` serves. */
  objects: new Map<string, Buffer>(),
}));

vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {
    buildPath: (userId: string, kind: string, id: string, ext: string) =>
      `${userId}/${kind}/${id}.${ext}`,
    upload: async (key: string, body: Buffer | string) => ({
      url: `mem://${key}`,
      path: key,
      size: Buffer.byteLength(body),
    }),
    downloadBuffer: async (key: string) => {
      const bytes = h.objects.get(key);
      if (!bytes) throw new Error(`no stored object ${key}`);
      return bytes;
    },
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        entities: actual.entities as never,
        focusSessions: actual.focusSessions as never,
      },
    }),
    eventRepository: { append: async () => undefined },
    openRunSession: async (input: {
      userId: string;
      goal: string;
      workspaceId?: string | null;
      source: string;
      origin?: string;
      subjectEntityId?: string | null;
      extraMetadata?: Record<string, unknown>;
    }) => {
      h.opened.push(input as unknown as Record<string, unknown>);
      const metadata = { source: input.source, ...(input.extraMetadata ?? {}) };
      const { rows } = await client.query<{ id: string }>(
        `insert into focus_sessions (id, user_id, goal, status, workspace_id, origin, subject_entity_id, metadata)
         values (gen_random_uuid(), $1, $2, 'active', $3, $4, $5, $6::jsonb) returning id`,
        [
          input.userId,
          input.goal,
          input.workspaceId ?? null,
          input.origin ?? "agent",
          input.subjectEntityId ?? null,
          JSON.stringify(metadata),
        ]
      );
      return { sessionId: rows[0]!.id, reused: false };
    },
  };
});

vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

vi.mock(
  "../services/focus-sessions/rerun-session.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    replayCaptureSource: vi.fn(
      async (source: unknown, args: unknown, who: unknown) => {
        h.replays.push({ source, args, who });
        if (h.replayThrows) throw new Error("IS unreachable");
        return { outcome: "proposed", proposalId: randomUUID() };
      }
    ),
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  db,
  entities,
  entityFacets,
  relations,
  projectMembers,
  workspaces,
  workspaceMembers,
  podMembers,
  focusSessions,
  documents,
  documentVersions,
} from "@synap/database";
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
    const type =
      c.columnType === "PgEnumColumn" || !BASIC.test(t)
        ? "text"
        : t.replace(/\(.*\)/, "");
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${pk}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function entity(opts: {
  userId?: string;
  title: string;
  preview?: string;
  content?: string;
}): Promise<string> {
  const id = randomUUID();
  let documentId: string | null = null;
  if (opts.content !== undefined) {
    documentId = randomUUID();
    await q(
      `insert into documents (id, user_id, title, type, created_at, updated_at) values ($1, $2, $3, 'markdown', now(), now())`,
      [documentId, opts.userId ?? USER, opts.title]
    );
    await q(
      `insert into document_versions (id, document_id, version, content, author, author_id, created_at)
       values (gen_random_uuid(), $1, 1, $2, 'user', $3, now())`,
      [documentId, opts.content, opts.userId ?? USER]
    );
  }
  await q(
    `insert into entities (id, user_id, type, title, preview, document_id, properties, system_data, version, created_at, updated_at)
     values ($1, $2, 'note', $3, $4, $5, '{}'::jsonb, '{}'::jsonb, 1, now(), now())`,
    [id, opts.userId ?? USER, opts.title, opts.preview ?? null, documentId]
  );
  return id;
}

/** An entity whose document is a STORED OBJECT with no version row (decision C's kept blob). */
async function storedObjectEntity(opts: {
  title: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<string> {
  const id = randomUUID();
  const documentId = randomUUID();
  const key = `${USER}/entity/${documentId}`;
  h.objects.set(key, opts.bytes);
  await q(
    `insert into documents (id, user_id, title, type, storage_key, mime_type, created_at, updated_at)
     values ($1, $2, $3, 'file', $4, $5, now(), now())`,
    [documentId, USER, opts.title, key, opts.mimeType]
  );
  await q(
    `insert into entities (id, user_id, type, title, document_id, properties, system_data, version, created_at, updated_at)
     values ($1, $2, 'note', $3, $4, '{}'::jsonb, '{}'::jsonb, 1, now(), now())`,
    [id, USER, opts.title, documentId]
  );
  return id;
}

const caller = (over: Record<string, unknown> = {}) =>
  focusSessionsRouter.createCaller({
    db,
    authenticated: true,
    userId: USER,
    ...over,
  } as never);

async function sourceDocs() {
  const { rows } = await q<{
    id: string;
    metadata: { intakeSource: Record<string, unknown> };
  }>(
    `select id, metadata from documents where metadata ? 'intakeSource' order by created_at`
  );
  return rows;
}

async function versionBody(documentId: string): Promise<string | undefined> {
  const { rows } = await q<{ content: string }>(
    `select content from document_versions where document_id = $1`,
    [documentId]
  );
  return rows[0]?.content;
}

async function sessionRow(id: string) {
  const { rows } = await q<{
    origin: string;
    subject_entity_id: string | null;
    workspace_id: string | null;
    metadata: {
      intake?: { door?: string };
      run?: { sourceDocumentIds?: string[] };
    };
  }>(
    `select origin, subject_entity_id, workspace_id, metadata from focus_sessions where id = $1`,
    [id]
  );
  return rows[0];
}

describe("focusSessions.structureAgain — an entity's text through the capture door, as a new run", () => {
  beforeAll(async () => {
    for (const t of [
      entities,
      entityFacets,
      relations,
      projectMembers,
      workspaces,
      workspaceMembers,
      podMembers,
      focusSessions,
      documents,
      documentVersions,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from document_versions; delete from documents; delete from entities; delete from focus_sessions;"
    );
    h.opened.length = 0;
    h.replays.length = 0;
    h.replayThrows = false;
    h.objects.clear();
  });

  it("a kept PHOTO with no version is replayed as that FILE (base64, its mime) — its bytes are never sent as text", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const id = await storedObjectEntity({
      title: "receipt.jpg",
      mimeType: "image/jpeg",
      bytes: jpeg,
    });

    const result = await caller().structureAgain({ entityId: id });

    expect(result).toMatchObject({ ok: true, status: "structured" });
    expect(h.replays).toHaveLength(1);
    const source = h.replays[0]!.source as {
      kind: string;
      input: { text?: string; file?: Record<string, unknown> };
    };
    expect(source.kind).toBe("file");
    expect(source.input.text).toBeUndefined();
    expect(source.input.file).toEqual({
      content: jpeg.toString("base64"),
      mimeType: "image/jpeg",
      filename: "receipt.jpg",
      encoding: "base64",
    });
    const docs = await sourceDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.metadata.intakeSource).toMatchObject({
      kind: "file",
      door: "structure_again",
      mimeType: "image/jpeg",
    });
  });

  it("a text/* stored object with no version is still read as TEXT", async () => {
    const id = await storedObjectEntity({
      title: "Plan",
      mimeType: "text/markdown",
      bytes: Buffer.from("Ship the importer by Friday", "utf8"),
    });
    await caller().structureAgain({ entityId: id });
    expect(h.replays[0]!.source).toMatchObject({
      kind: "text",
      input: { text: "Plan\n\nShip the importer by Friday" },
    });
  });

  it("mints a run ABOUT the entity, keeps its text as the run's source, then replays that text through the capture door", async () => {
    const id = await entity({
      title: "Offsite notes",
      preview: "Ann owns the venue",
      content: "Ann owns the venue. Bob books flights by Friday.",
    });

    const result = await caller().structureAgain({ entityId: id });

    expect(result).toMatchObject({
      ok: true,
      status: "structured",
      entityId: id,
      outcome: "proposed",
      manifestRecorded: true,
    });
    const sessionId = (result as { sessionId: string }).sessionId;
    const row = await sessionRow(sessionId);
    expect(row).toMatchObject({ origin: "human", subject_entity_id: id });
    expect(row!.metadata.intake?.door).toBe("capture");

    const docs = await sourceDocs();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.metadata.intakeSource).toMatchObject({
      kind: "text",
      sessionId,
      door: "structure_again",
    });
    // Title, then the content; a preview the content starts with is not repeated.
    const text =
      "Offsite notes\n\nAnn owns the venue. Bob books flights by Friday.";
    expect(await versionBody(docs[0]!.id)).toBe(text);
    expect(row!.metadata.run?.sourceDocumentIds).toEqual([docs[0]!.id]);
    expect((result as { sourceDocumentId: string }).sourceDocumentId).toBe(
      docs[0]!.id
    );

    expect(h.replays).toHaveLength(1);
    expect(h.replays[0]).toMatchObject({
      source: {
        sourceDocumentId: docs[0]!.id,
        door: "capture",
        input: { text },
      },
      args: {
        childSessionId: sessionId,
        idempotencyNamespace: `structure-again:${sessionId}`,
      },
      who: { userId: USER, agentUserId: null },
    });
  });

  it("a double press inside the window reuses the run and replays NOTHING again", async () => {
    const id = await entity({ title: "Idea", content: "Ship a CSV importer" });
    const first = await caller().structureAgain({ entityId: id });
    const second = await caller().structureAgain({ entityId: id });
    expect(second).toMatchObject({ ok: true, status: "reused" });
    expect((second as { sessionId: string }).sessionId).toBe(
      (first as { sessionId: string }).sessionId
    );
    expect(h.opened).toHaveLength(1);
    expect(h.replays).toHaveLength(1);
  });

  it("an agent caller opens an AGENT run and replays under its attribution (the governed capture path)", async () => {
    const id = await entity({ title: "Lead", content: "Acme wants a demo" });
    const result = await caller({ agentUserId: AGENT }).structureAgain({
      entityId: id,
    });
    const sessionId = (result as { sessionId: string }).sessionId;
    expect((await sessionRow(sessionId))!.origin).toBe("agent");
    expect(h.opened[0]).toMatchObject({ agentUserId: AGENT });
    expect(h.replays[0]!.who).toMatchObject({ agentUserId: AGENT });
  });

  it("a title with no body is refused with a reason — nothing minted, nothing staged", async () => {
    const id = await entity({ title: "Just a title" });
    const result = await caller().structureAgain({ entityId: id });
    expect(result).toMatchObject({ ok: false, reason: "no_text" });
    expect(h.opened).toHaveLength(0);
    expect(await sourceDocs()).toHaveLength(0);
    expect(h.replays).toHaveLength(0);
  });

  it("another user's private entity is NOT FOUND through the access floor — its text is never read", async () => {
    const id = await entity({
      userId: OTHER,
      title: "Private",
      content: "Salary figures",
    });
    await expect(
      caller().structureAgain({ entityId: id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.opened).toHaveLength(0);
    expect(await sourceDocs()).toHaveLength(0);
  });

  it("a capture door that throws is a named failed outcome — the run and its source are KEPT for Rerun", async () => {
    h.replayThrows = true;
    const id = await entity({ title: "Memo", content: "Q3 plan draft" });
    const result = await caller().structureAgain({ entityId: id });
    expect(result).toMatchObject({
      ok: true,
      status: "structured",
      outcome: "failed",
      reason: "IS unreachable",
    });
    const sessionId = (result as { sessionId: string }).sessionId;
    const docs = await sourceDocs();
    expect(docs).toHaveLength(1);
    expect(
      (await sessionRow(sessionId))!.metadata.run?.sourceDocumentIds
    ).toEqual([docs[0]!.id]);
  });
});
