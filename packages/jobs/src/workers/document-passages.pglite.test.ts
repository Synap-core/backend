/**
 * Document passages on real SQL (PGlite) — recall plan A-W2.
 *
 * Driven from the EVENT, not the worker: each test emits a document
 * create/update through the live reactor registry (`getReactors()`, the loop
 * `fanOutSideEffects` runs), then runs every job those reactors queued with
 * the real worker. So "a body edit refreshes its passages" needs the reactor,
 * the one enqueue door and the build — removing any of them goes red.
 *
 * Real: the reactors, `enqueueDocumentPassages`, `handleDocumentPassages`,
 * the sweep's SQL, `loadDocumentBodyTexts`, markdown-core `segmentPassages` +
 * `markdownToPlainText`, the four tables on PGlite.
 * Stubbed, and why: `@synap/storage` (an in-memory blob map); the IS (a
 * `fetch` stub that records every batch, so "only changed passages are
 * embedded" is counted); `getBoss` (a recorder: the jobs are run by hand);
 * the IS endpoint lookup. PGlite has no pgvector: vectors are stored as text.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  blobs: new Map<string, string>(),
  sent: [] as Array<{ name: string; data: Record<string, unknown> }>,
  batches: [] as string[][],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client),
    resolveDefaultIntelligenceEndpoint: async () => ({
      endpoint: "http://is.local",
      apiKey: "k",
    }),
  };
});

vi.mock("@synap/storage", () => ({
  storage: {
    downloadBuffer: async (key: string) => {
      const body = h.blobs.get(key);
      if (body === undefined) throw new Error(`storage unreachable for ${key}`);
      return Buffer.from(body, "utf-8");
    },
  },
}));

const recorder = {
  send: async (name: string, data: Record<string, unknown>) => {
    h.sent.push({ name, data });
    return "job-id";
  },
};
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => recorder,
}));

const database = await import("@synap/database");
const { getReactors } = await import("@synap/events");
const {
  DOCUMENT_PASSAGES_QUEUE,
  handleDocumentPassages,
  handleDocumentPassagesSweep,
} = await import("./document-passages.js");

const USER = "user-1";
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

/** ~`size` chars of prose, tagged so a passage can be recognised. */
const prose = (tag: string, size = 600) =>
  `${tag} ${"word ".repeat(Math.floor(size / 5))}`.trim();

const NOTE = (pricing: string) =>
  `## Pricing\n\n${pricing} ${prose("pricing")}\n\n## Governance\n\n${prose("governance")}\n\n## Hiring\n\n${prose("hiring")}\n`;

/** A markdown document (and its owning entity) at `revision`, body in storage. */
async function seedDocument(body: string, revision = 1) {
  const documentId = randomUUID();
  const entityId = randomUUID();
  const storageKey = `${USER}/document/${documentId}.md`;
  h.blobs.set(storageKey, body);
  await q(
    `insert into documents (id, user_id, title, type, storage_key, mime_type, content_revision)
     values ($1, $2, 'Meeting notes', 'markdown', $3, 'text/markdown', $4)`,
    [documentId, USER, storageKey, revision]
  );
  await q(
    `insert into entities (id, user_id, type, title, document_id) values ($1, $2, 'note', 'Meeting notes', $3)`,
    [entityId, USER, documentId]
  );
  return { documentId, entityId, storageKey };
}

/** A body edit through the one content door's effect: new body, revision + 1. */
async function editBody(
  doc: { documentId: string; storageKey: string },
  body: string
) {
  h.blobs.set(doc.storageKey, body);
  await q(
    `update documents set content_revision = content_revision + 1 where id = $1`,
    [doc.documentId]
  );
}

/** The emit loop of `fanOutSideEffects`, over the live reactor registry. */
async function emit(action: "create" | "update", documentId: string) {
  const payload = {
    subjectType: "document",
    action,
    subjectId: documentId,
    userId: USER,
    workspaceId: null,
  };
  for (const reactor of getReactors()) {
    if (reactor.match && !reactor.match(payload)) continue;
    await reactor.handler(payload, { boss: recorder as never });
  }
}

/** Run every queued passage build (the debounce collapses a burst to one). */
async function drain() {
  const jobs = h.sent.filter((s) => s.name === DOCUMENT_PASSAGES_QUEUE);
  h.sent = h.sent.filter((s) => s.name !== DOCUMENT_PASSAGES_QUEUE);
  const results = [];
  for (const job of jobs) {
    results.push(
      await handleDocumentPassages({ data: job.data as { documentId: string } })
    );
  }
  return results;
}

const passagesOf = async (documentId: string) =>
  (
    await q<{
      ordinal: number;
      heading_path: string;
      text: string;
      text_hash: string;
      embedding: string;
      source_revision: number;
    }>(
      `select ordinal, heading_path, text, text_hash, embedding, source_revision
       from document_passages where document_id = $1 order by ordinal`,
      [documentId]
    )
  ).rows;

const stateOf = async (documentId: string) =>
  (
    await q<{
      source_revision: number | null;
      passage_count: number;
      failure: string | null;
    }>(
      `select source_revision, passage_count, failure from document_passage_state where document_id = $1`,
      [documentId]
    )
  ).rows[0];

const embeddedFor = (entityId: string) =>
  h.sent.filter(
    (s) => s.name === "entity-embedding" && s.data.entityId === entityId
  );

beforeAll(async () => {
  for (const t of [
    database.documents,
    database.entities,
    database.documentPassages,
    database.documentPassageState,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
}, 60_000);

beforeEach(() => {
  h.sent = [];
  h.batches = [];
  // The IS batch endpoint: one vector per text, recording every call.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      expect(url).toBe("http://is.local/api/embeddings/batch");
      const { texts } = JSON.parse(init.body) as { texts: string[] };
      h.batches.push(texts);
      return {
        ok: true,
        json: async () => ({
          embeddings: texts.map((t) => [t.length, h.batches.length]),
          model: "text-embedding-3-small",
        }),
      };
    })
  );
});

describe("document-passages — a document body as recall passages, kept current", () => {
  it("a created document is cut into passages, each embedded as 'title › heading' + prose; its entity is re-embedded", async () => {
    const doc = await seedDocument(NOTE("The seat price is **39 EUR**."));
    await emit("create", doc.documentId);
    const [result] = await drain();
    expect(result).toMatchObject({ status: "built", passages: 3, embedded: 3 });

    const rows = await passagesOf(doc.documentId);
    expect(rows.map((r) => r.heading_path)).toEqual([
      "Pricing",
      "Governance",
      "Hiring",
    ]);
    // Prose, not markdown: no marks, no heading syntax.
    expect(rows[0]!.text).toContain("The seat price is 39 EUR.");
    expect(rows[0]!.text).not.toMatch(/\*\*|##/);
    expect(rows.every((r) => r.source_revision === 1)).toBe(true);
    // ONE IS batch call; the heading path is embedded with the text.
    expect(h.batches).toHaveLength(1);
    // (markdown-core plain text runs a section's blocks together: "Pricing The…")
    expect(h.batches[0]![0]).toMatch(
      /^Meeting notes › Pricing\n\nPricing The seat price is 39 EUR\./
    );
    expect(await stateOf(doc.documentId)).toMatchObject({
      source_revision: 1,
      passage_count: 3,
      failure: null,
    });
    expect(embeddedFor(doc.entityId)).toHaveLength(1);
  });

  it("an edited section's passage changes; only that passage is re-embedded and the entity vector refreshed", async () => {
    const doc = await seedDocument(NOTE("The seat price is 39 EUR."));
    await emit("create", doc.documentId);
    await drain();
    const before = await passagesOf(doc.documentId);
    h.sent = [];
    h.batches = [];

    await editBody(doc, NOTE("The seat price is 49 EUR (changed Monday)."));
    await emit("update", doc.documentId);
    const [result] = await drain();
    expect(result).toMatchObject({
      status: "built",
      embedded: 1,
      changed: true,
    });

    const after = await passagesOf(doc.documentId);
    expect(after[0]!.text).toContain("49 EUR");
    expect(after[0]!.text).not.toContain("39 EUR");
    expect(after[0]!.text_hash).not.toBe(before[0]!.text_hash);
    // Untouched sections keep their vectors: one text went to the IS.
    expect(h.batches).toEqual([[expect.stringContaining("49 EUR")]]);
    expect(after[1]!.embedding).toBe(before[1]!.embedding);
    expect(after[2]!.embedding).toBe(before[2]!.embedding);
    expect(after.every((r) => r.source_revision === 2)).toBe(true);
    expect(embeddedFor(doc.entityId)).toHaveLength(1);
  });

  it("an update that leaves the body as it was embeds nothing and re-embeds no entity", async () => {
    const doc = await seedDocument(NOTE("Same."));
    await emit("create", doc.documentId);
    await drain();
    h.sent = [];
    h.batches = [];

    await emit("update", doc.documentId); // a title-only save
    const [result] = await drain();
    expect(result).toMatchObject({
      status: "built",
      embedded: 0,
      changed: false,
    });
    expect(h.batches).toHaveLength(0);
    expect(embeddedFor(doc.entityId)).toHaveLength(0);
  });

  it("short sections merge into one passage: the splitter's size rule reaches the index", async () => {
    const doc = await seedDocument(
      "## One\n\nA short first note.\n\n## Two\n\nA short second note.\n"
    );
    await emit("create", doc.documentId);
    await drain();
    const rows = await passagesOf(doc.documentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.heading_path).toBe("One · Two");
    expect(rows[0]!.text).toContain("first note");
    expect(rows[0]!.text).toContain("second note");
  });

  it("a body that cannot be read keeps its old passages and records the failure, never 'no text'", async () => {
    const doc = await seedDocument(NOTE("The seat price is 39 EUR."));
    await emit("create", doc.documentId);
    await drain();
    h.sent = [];

    h.blobs.delete(doc.storageKey);
    await q(
      `update documents set content_revision = content_revision + 1 where id = $1`,
      [doc.documentId]
    );
    await emit("update", doc.documentId);
    const [result] = await drain();
    expect(result).toMatchObject({ status: "failed" });

    const rows = await passagesOf(doc.documentId);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text).toContain("39 EUR");
    expect(await stateOf(doc.documentId)).toMatchObject({
      source_revision: 1,
      passage_count: 3,
      failure: expect.stringMatching(/storage unreachable/),
    });
    expect(embeddedFor(doc.entityId)).toHaveLength(0);
  });

  it("the sweep re-queues a document whose passages trail its revision, and only that one", async () => {
    const current = await seedDocument(NOTE("Current."));
    const missed = await seedDocument(NOTE("Before the missed edit."));
    await emit("create", current.documentId);
    await emit("create", missed.documentId);
    await drain();

    // An edit whose event never fired (e.g. a write path that emits none).
    await editBody(missed, NOTE("After the missed edit."));
    h.sent = [];
    await handleDocumentPassagesSweep();
    const queued = h.sent
      .filter((s) => s.name === DOCUMENT_PASSAGES_QUEUE)
      .map((s) => s.data.documentId);
    expect(queued).toContain(missed.documentId);
    expect(queued).not.toContain(current.documentId);

    await drain();
    expect((await passagesOf(missed.documentId))[0]!.text).toContain(
      "After the missed edit."
    );
    expect(await stateOf(missed.documentId)).toMatchObject({
      source_revision: 2,
    });
  });
});
