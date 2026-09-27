/**
 * Regression for the file-upload FORBIDDEN bug (2026-09-27): every file
 * upload (`synap upload` / `POST /files` / `synap_store_file`) was refused
 * with FORBIDDEN "That document belongs to another workspace" because
 * `createGovernedFileEntityFromBuffer` stores the DOCUMENT in the caller's
 * real workspace while the `file` kind entity is pod-scope
 * (`entity.workspaceId === null`) — neither branch of the old
 * `assertDocumentAttachable` scope check matched: `doc.workspaceId ===
 * entity.workspaceId` was false (workspace !== null), and
 * `doc.workspaceId === null && doc.userId === userId` was false (document
 * workspace is NOT null).
 *
 * THE FIX (packages/api/src/routers/entities/mutate.ts,
 * `assertDocumentAttachable`): `sameScope = doc.workspaceId ===
 * entity.workspaceId || doc.userId === userId` — a document the CALLER
 * THEMSELF authored may always be attached, regardless of workspace scope
 * (closes the upload case), while a document only reachable through someone
 * ELSE's workspace membership still requires matching workspaces (preserves
 * H2: a caller must never repoint a broadly-exposed entity at another
 * author's document to read it through the exposure).
 *
 * This file calls the REAL exported `assertDocumentAttachable` directly
 * against a real PGlite database (through the real access layer —
 * `loadEditableDocument` → `scopedDb`/`AccessContext`/`assertWorkspaceWrite`),
 * modeled on `entities.create-pod-kind-placement.pglite.test.ts`'s harness.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { assertDocumentAttachable } from "./entities/mutate.js";

// Two distinct authors: CALLER is the person invoking assertDocumentAttachable
// (the uploader / editor); OTHER authored a document CALLER can only reach via
// workspace membership, never by authorship.
const CALLER = randomUUID();
const OTHER = randomUUID();
const CRM = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function insertDocument(row: {
  workspaceId: string | null;
  userId: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into documents (id, user_id, workspace_id, title, type) values ($1,$2,$3,'Doc','text')`,
    [id, row.userId, row.workspaceId]
  );
  return id;
}

async function insertEntity(row: {
  workspaceId: string | null;
  userId: string;
  documentId?: string | null;
}): Promise<{ id: string; workspaceId: string | null }> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, document_id) values ($1,$2,$3,'file',$4)`,
    [id, row.userId, row.workspaceId, row.documentId ?? null]
  );
  return { id, workspaceId: row.workspaceId };
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email) values ($1, 'caller@x.test')`, [
    CALLER,
  ]);
  await q(`insert into users (id, email) values ($1, 'other@x.test')`, [OTHER]);
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings) values ($1,'CRM',$2,'team','{}'::jsonb)`,
    [CRM, CALLER]
  );
  // CALLER is an editor+ ("owner") member of CRM — grants read AND write
  // access to any document/entity scoped to CRM, regardless of who
  // authored the row (assertWorkspaceWrite gates on workspace membership,
  // never on the loaded row's own userId).
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), CRM, CALLER]
  );
}, 120_000);

describe("assertDocumentAttachable — file-upload scope regression", () => {
  it("(a) THE BUG CASE: pod-scope entity + caller's OWN workspace document — no longer throws", async () => {
    const doc = await insertDocument({ workspaceId: CRM, userId: CALLER });
    const entity = await insertEntity({ workspaceId: null, userId: CALLER });
    await expect(
      assertDocumentAttachable(CALLER, entity, doc)
    ).resolves.toBeUndefined();
  });

  it("(b) THE SECURITY CASE: pod-scope entity + ANOTHER author's workspace document — still throws FORBIDDEN, even though caller can EDIT it via workspace membership", async () => {
    const doc = await insertDocument({ workspaceId: CRM, userId: OTHER });
    const entity = await insertEntity({ workspaceId: null, userId: CALLER });

    // Sanity: CALLER really can load/edit this document (workspace editor+
    // membership) — the security case is about ATTACHING it to a
    // differently-scoped entity, not about read/edit access to the document
    // itself.
    const { loadEditableDocument } =
      await import("../utils/document-edit-access.js");
    await expect(loadEditableDocument(CALLER, doc)).resolves.toBeDefined();

    await expect(
      assertDocumentAttachable(CALLER, entity, doc)
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("belongs to another workspace"),
    });
  });

  it("(c) same-workspace entity + document — no throw (pre-existing, unchanged)", async () => {
    const doc = await insertDocument({ workspaceId: CRM, userId: OTHER });
    const entity = await insertEntity({ workspaceId: CRM, userId: CALLER });
    await expect(
      assertDocumentAttachable(CALLER, entity, doc)
    ).resolves.toBeUndefined();
  });

  it("(d) a document already the body of another live entity is refused regardless of scope (unchanged ownership check)", async () => {
    const doc = await insertDocument({ workspaceId: CRM, userId: CALLER });
    // The document is already the body of a DIFFERENT live entity.
    await insertEntity({ workspaceId: CRM, userId: CALLER, documentId: doc });
    const entity = await insertEntity({ workspaceId: null, userId: CALLER });

    await expect(
      assertDocumentAttachable(CALLER, entity, doc)
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("already the body of another object"),
    });
  });
});
