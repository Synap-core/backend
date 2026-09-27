/**
 * The body escalation door ("Open as document", text tiers W3), driven for real
 * on PGlite: `promotePropertyToBody` + `undoPromotePropertyToBody` against real
 * `entities` / `documents` / `document_versions` rows and the REAL
 * `DocumentRepository.create` + `EntityBodyService.deleteBody`.
 *
 * Stubbed, and why:
 *  - the write floor — `entityWriteVisibleWhere` becomes "the caller owns the
 *    row" and `assertWorkspaceWrite` admits `h.writers`. Both have their own
 *    suites (access layer); the seam here is that the door CONSULTS them and
 *    writes nothing when they refuse.
 *  - `@synap/storage` — an in-memory blob map.
 *  - `getActingAgentUserId` — `h.agent`, the ambient attribution.
 *  - `ProfileResolutionService` — `h.defs`, the entity's effective property defs.
 *  - `recordDomainMutation`, `PropertyIndexService`, the event log — recorded /
 *    no-op (fan-out, not the move).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  blobs: new Map<string, string>(),
  writers: new Set<string>(),
  agent: undefined as string | undefined,
  defs: [] as Array<{ slug: string; uiHints?: Record<string, unknown> }>,
  mutations: [] as Array<Record<string, unknown>>,
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
        entities: schema.entities,
        documents: schema.documents,
        documentVersions: schema.documentVersions,
      } as never,
    }),
    eventRepository: { append: async () => ({}) },
    getActingAgentUserId: () => h.agent,
    ProfileResolutionService: class {
      async getEffectiveProperties() {
        return h.defs;
      }
    },
    PropertyIndexService: class {
      async reindexEntity() {}
    },
    uploadDocumentVersionSnapshot: async (i: {
      versionId: string;
      content: string | Buffer;
      mimeType?: string | null;
    }) => {
      const key = `versions/${i.versionId}`;
      h.blobs.set(key, String(i.content));
      return {
        storageUrl: key,
        storageKey: key,
        size: String(i.content).length,
        mimeType: i.mimeType ?? "text/markdown",
        checksum: "sha256:x",
        contentPreview: String(i.content).slice(0, 100),
      };
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
      return { url: key, path: key, size: text.length, checksum: "sha256:x" };
    },
    downloadBuffer: async (key: string) =>
      Buffer.from(h.blobs.get(key) ?? "", "utf-8"),
    delete: async (key: string) => {
      h.blobs.delete(key);
    },
  },
}));

vi.mock("../../routers/entities/helpers.js", async () => {
  const { sql } = await import("drizzle-orm");
  const { entities } = await import("@synap/database/schema");
  return {
    entityWriteVisibleWhere: (userId: string) =>
      sql`${entities.userId} = ${userId}`,
  };
});

vi.mock("../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: async (_db: unknown, userId: string) => {
    if (!h.writers.has(userId)) {
      const { TRPCError } = await import("@trpc/server");
      throw new TRPCError({ code: "FORBIDDEN", message: "not an editor" });
    }
  },
}));

vi.mock("../../utils/domain-mutation.js", () => ({
  recordDomainMutation: async (opts: Record<string, unknown>) => {
    h.mutations.push(opts);
    return null;
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { entities, documents, documentVersions } from "@synap/database/schema";
import {
  promotePropertyToBody,
  undoPromotePropertyToBody,
} from "./promote-property-to-body.js";

const OWNER = "user-owner";
const VIEWER = "user-viewer";
const WS = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const PROSE = "First line.\n\n- one\n- two\n";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    let def = "";
    if (c.hasDefault) {
      if (typeof c.default === "number" || typeof c.default === "boolean")
        def = ` default ${c.default}`;
      else if (typeof c.default === "string")
        def = ` default '${c.default.replace(/'/g, "''")}'`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
      else if (type === "jsonb") def = " default '{}'::jsonb";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function newEntity(
  properties: Record<string, unknown>,
  documentId: string | null = null
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, document_id)
     values ($1, $2, $3, $4, 'note', 'Plan', $5::jsonb, $6)`,
    [id, OWNER, WS, PROFILE, JSON.stringify(properties), documentId]
  );
  return id;
}

async function entityRow(id: string) {
  const { rows } = await q<{
    document_id: string | null;
    properties: Record<string, unknown>;
  }>(`select document_id, properties from entities where id = $1`, [id]);
  return rows[0]!;
}

async function docRow(id: string) {
  const { rows } = await q<{
    storage_key: string;
    content_revision: number;
    metadata: Record<string, unknown> | null;
    workspace_id: string | null;
  }>(
    `select storage_key, content_revision, metadata, workspace_id from documents where id = $1`,
    [id]
  );
  return rows[0];
}

const count = async (table: string) =>
  Number(
    (await q<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!
      .n
  );

beforeAll(async () => {
  for (const t of [entities, documents, documentVersions])
    await h.client!.exec(ddlFor(t as PgTable));
});

beforeEach(async () => {
  h.writers = new Set([OWNER]);
  h.agent = undefined;
  h.defs = [];
  h.mutations = [];
});

describe("promotePropertyToBody", () => {
  it("MOVES the prose: a linked body document holds it and the property is gone", async () => {
    const id = await newEntity({ content: PROSE, status: "draft" });
    const res = await promotePropertyToBody({
      userId: OWNER,
      entityId: id,
      propertySlug: "content",
    });
    expect(res.status).toBe("promoted");
    if (res.status !== "promoted") return;

    const entity = await entityRow(id);
    expect(entity.document_id).toBe(res.documentId);
    expect(entity.properties).toEqual({ status: "draft" });

    const doc = await docRow(res.documentId);
    expect(h.blobs.get(doc!.storage_key)).toBe(PROSE);
    expect(doc!.workspace_id).toBe(WS);
    expect(doc!.metadata).toMatchObject({
      promotedFrom: { entityId: id, propertySlug: "content", revision: 1 },
    });
    // v1 history row, authored by the person.
    const { rows } = await q<{ author: string; author_id: string }>(
      `select author, author_id from document_versions where document_id = $1`,
      [res.documentId]
    );
    expect(rows).toEqual([{ author: "user", author_id: OWNER }]);
    expect(h.mutations).toHaveLength(1);
  });

  it("promotes a property that declares displayAs: body", async () => {
    h.defs = [{ slug: "brief", uiHints: { displayAs: "body" } }];
    const id = await newEntity({ brief: PROSE });
    const res = await promotePropertyToBody({
      userId: OWNER,
      entityId: id,
      propertySlug: "brief",
    });
    expect(res.status).toBe("promoted");
  });

  it("REFUSES when the entity already has a body document, moving nothing", async () => {
    const existingDoc = randomUUID();
    const id = await newEntity({ content: PROSE }, existingDoc);
    const docsBefore = await count("documents");
    const res = await promotePropertyToBody({
      userId: OWNER,
      entityId: id,
      propertySlug: "content",
    });
    expect(res).toMatchObject({ status: "refused", reason: "body_exists" });
    expect(await entityRow(id)).toEqual({
      document_id: existingDoc,
      properties: { content: PROSE },
    });
    expect(await count("documents")).toBe(docsBefore);
  });

  it("refuses a property that is not the body, and an empty one", async () => {
    h.defs = [{ slug: "summary", uiHints: { inputType: "richtext" } }];
    const id = await newEntity({ summary: PROSE, content: "  " });
    expect(
      await promotePropertyToBody({
        userId: OWNER,
        entityId: id,
        propertySlug: "summary",
      })
    ).toMatchObject({ status: "refused", reason: "not_body_property" });
    expect(
      await promotePropertyToBody({
        userId: OWNER,
        entityId: id,
        propertySlug: "content",
      })
    ).toMatchObject({ status: "refused", reason: "empty_value" });
  });

  it("a user without write rights cannot promote — nothing is written", async () => {
    const id = await newEntity({ content: PROSE });
    const docsBefore = await count("documents");
    // Not the owner → the write floor does not even find the entity.
    await expect(
      promotePropertyToBody({
        userId: VIEWER,
        entityId: id,
        propertySlug: "content",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Found, but the workspace write floor refuses (e.g. a viewer seat).
    h.writers = new Set();
    await expect(
      promotePropertyToBody({
        userId: OWNER,
        entityId: id,
        propertySlug: "content",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await entityRow(id)).toEqual({
      document_id: null,
      properties: { content: PROSE },
    });
    expect(await count("documents")).toBe(docsBefore);
  });

  it("an agent-attributed caller is refused", async () => {
    h.agent = "agent-1";
    const id = await newEntity({ content: PROSE });
    expect(
      await promotePropertyToBody({
        userId: OWNER,
        entityId: id,
        propertySlug: "content",
      })
    ).toMatchObject({ status: "refused", reason: "agent_caller" });
    expect((await entityRow(id)).properties).toEqual({ content: PROSE });
  });
});

describe("undoPromotePropertyToBody", () => {
  async function promoted() {
    const id = await newEntity({ content: PROSE, status: "draft" });
    const res = await promotePropertyToBody({
      userId: OWNER,
      entityId: id,
      propertySlug: "content",
    });
    if (res.status !== "promoted") throw new Error("setup: not promoted");
    return { id, documentId: res.documentId };
  }

  it("RESTORES the property from the body and removes the document", async () => {
    const { id, documentId } = await promoted();
    const res = await undoPromotePropertyToBody({
      userId: OWNER,
      entityId: id,
      documentId,
    });
    expect(res).toMatchObject({ status: "restored", propertySlug: "content" });
    expect(await entityRow(id)).toEqual({
      document_id: null,
      properties: { status: "draft", content: PROSE },
    });
    expect(await docRow(documentId)).toBeUndefined();
  });

  it("refuses once the document was edited after the move", async () => {
    const { id, documentId } = await promoted();
    await q(
      `update documents set content_revision = content_revision + 1 where id = $1`,
      [documentId]
    );
    expect(
      await undoPromotePropertyToBody({
        userId: OWNER,
        entityId: id,
        documentId,
      })
    ).toMatchObject({ status: "refused", reason: "edited_since" });
    expect((await entityRow(id)).document_id).toBe(documentId);
  });

  it("refuses a document that no promotion of this entity created", async () => {
    const { documentId } = await promoted();
    const other = await newEntity({}, documentId);
    expect(
      await undoPromotePropertyToBody({
        userId: OWNER,
        entityId: other,
        documentId,
      })
    ).toMatchObject({ status: "refused", reason: "not_promoted" });
  });

  it("a user without write rights cannot undo", async () => {
    const { id, documentId } = await promoted();
    h.writers = new Set();
    await expect(
      undoPromotePropertyToBody({ userId: OWNER, entityId: id, documentId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await entityRow(id)).document_id).toBe(documentId);
  });
});
