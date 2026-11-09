/**
 * A PART FOLLOWS ITS WHOLE (founder decision 22226da5, 2026-11-09): an
 * entity's BODY document is readable by exactly the principals who read the
 * entity, even when the body was stored pod-wide (`workspace_id` NULL) while
 * its entity sits in a space. The live case: Content Studio, a key limited to
 * the Content OS space, got not_found on the body of a composition it reads.
 *
 * Through the REAL `scopedDb(AccessContext)` (the registered `documents`
 * rule + the key's grant clause), the real tRPC `documents.get` and
 * `documents.list`, and the real document edit gate, compiled and run as SQL
 * on PGlite. A key reads as its PERSON, inside `runWithGrant`; the CONTROL
 * (no grant) shows the person's floor admits every row, so each row a granted
 * read drops is the GRANT at work.
 *
 * Rows rule out:
 *  - no body reach at all (the bug: B_CONTENT unread by the key or a member);
 *  - a reach that ignores WHICH space the entity is in (B_OTHER read);
 *  - a reach to the body of a pod-wide entity (B_POD read: "Video · Free
 *    take v1" must stay invisible to a space key) or of a trashed one;
 *  - a reach to a standalone pod-wide document (D_LOOSE read): it stays
 *    owner-only;
 *  - a guest gaining anything;
 *  - lists starting to show bodies (`filedDocumentWhere` still holds);
 *  - a member who reads the body but may not save it, and a viewer who may.
 *
 * Cannot see: production Postgres constraints (tables come from the Drizzle
 * definitions without FKs / NOT NULL / enums).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { documents } from "@synap/database/schema";
import { grantOfScope, runWithGrant } from "@synap/database";
import type { GrantScope } from "@synap/governance-policy/grants";
import { AccessContext, scopedDb } from "./index.js";
import { documentsRouter } from "../routers/documents.js";
import {
  canEditDocument,
  loadReadableDocument,
} from "../utils/document-edit-access.js";

const PERSON = randomUUID(); // owns every row; an app key reads as them
const EDITOR = randomUUID(); // editor of CONTENT only
const VIEWER = randomUUID(); // viewer of CONTENT only
const GUEST = randomUUID(); // a project guest, nothing else

const CONTENT = randomUUID(); // "Content OS"
const OTHER = randomUUID(); // another of the person's spaces
const PROJECT = randomUUID();
const KIND = randomUUID();

const E_CONTENT = randomUUID(); // composition in CONTENT, pod-wide body
const E_OTHER = randomUUID(); // entity in OTHER, pod-wide body
const E_POD = randomUUID(); // pod-wide entity, no home (1f72fc19-like)
const E_TRASHED = randomUUID(); // in CONTENT, trashed

const B_CONTENT = randomUUID();
const B_OTHER = randomUUID();
const B_POD = randomUUID();
const B_TRASHED = randomUUID();
const D_LOOSE = randomUUID(); // pod-wide, no entity points at it
const D_FILED = randomUUID(); // a document filed in CONTENT (not a body)

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const sorted = (ids: string[]) => [...new Set(ids)].sort();

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const id of [PERSON, EDITOR, VIEWER, GUEST]) {
    await q(
      `insert into users (id, email, user_type) values ($1, $2, 'human')`,
      [id, `${id}@x.test`]
    );
  }
  for (const id of [PERSON, EDITOR, VIEWER]) {
    await q(
      `insert into pod_members (id, user_id, pod_role) values ($1,$2,$3)`,
      [randomUUID(), id, id === PERSON ? "owner" : "member"]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Content OS',$3,'{}'::jsonb),($2,'Other',$3,'{}'::jsonb)`,
    [CONTENT, OTHER, PERSON]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       ($1,$2,$3,'owner'),($4,$5,$3,'owner'),($6,$2,$7,'editor'),($8,$2,$9,'viewer')`,
    [
      randomUUID(),
      CONTENT,
      PERSON,
      randomUUID(),
      OTHER,
      randomUUID(),
      EDITOR,
      randomUUID(),
      VIEWER,
    ]
  );
  // A guest: a guest role on a project, no participation anywhere.
  await q(`insert into projects (id, name, user_id) values ($1,'Portal',$2)`, [
    PROJECT,
    PERSON,
  ]);
  await q(
    `insert into project_members (id, project_id, user_id, role) values ($1,$2,$3,'guest')`,
    [randomUUID(), PROJECT, GUEST]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, workspace_id) values ($1,'content-composition','Composition','kind','system',null)`,
    [KIND]
  );
  const entity = (
    id: string,
    ws: string | null,
    doc: string,
    trashed = false
  ) =>
    q(
      `insert into entities (id, type, profile_id, user_id, workspace_id, home_workspace_id, document_id, deleted_at, title)
       values ($1,'content-composition',$2,$3,$4,null,$5,$6,'e')`,
      [id, KIND, PERSON, ws, doc, trashed ? new Date() : null]
    );
  await entity(E_CONTENT, CONTENT, B_CONTENT);
  await entity(E_OTHER, OTHER, B_OTHER);
  await entity(E_POD, null, B_POD);
  await entity(E_TRASHED, CONTENT, B_TRASHED, true);
  const doc = (id: string, ws: string | null) =>
    q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision, metadata)
       values ($1,$2,$3,'Doc','markdown',1,1,'{}'::jsonb)`,
      [id, PERSON, ws]
    );
  for (const d of [B_CONTENT, B_OTHER, B_POD, B_TRASHED, D_LOOSE])
    await doc(d, null);
  await doc(D_FILED, CONTENT);
}, 120_000);

const ALL: string[] = [B_CONTENT, B_OTHER, B_POD, B_TRASHED, D_LOOSE, D_FILED];

/** The documents `userId` reads among ALL, optionally inside a key's grant. */
const readAs = async (
  userId: string,
  opts: { grant?: GrantScope; lens?: string | null } = {}
) => {
  const access = AccessContext.operator({ userId });
  const run = () =>
    scopedDb(
      opts.lens !== undefined ? access.withLens(opts.lens) : access
    ).findMany<{ id: string }>(documents);
  const rows = opts.grant
    ? await runWithGrant(grantOfScope(opts.grant), run)
    : await run();
  return sorted(rows.map((r) => r.id).filter((id) => ALL.includes(id)));
};

const CONTENT_KEY: GrantScope = {
  permissions: ["document.read", "entity.read"],
  workspaceIds: [CONTENT],
};

describe("CONTROL — the person (no grant) reads every row", () => {
  it("their own pod-wide bodies and documents", async () => {
    expect(await readAs(PERSON)).toEqual(sorted(ALL));
  });
});

describe("a key limited to a space reads the bodies of the entities stored there", () => {
  it("THE LIVE CASE: the pod-wide body of a composition in Content OS", async () => {
    expect(await readAs(PERSON, { grant: CONTENT_KEY })).toContain(B_CONTENT);
  });

  it("NOT the body of an entity in another space, of a pod-wide entity, of a trashed one, nor a standalone document", async () => {
    // Exactly: what is stored in the space, plus the body that follows its
    // entity there.
    expect(await readAs(PERSON, { grant: CONTENT_KEY })).toEqual(
      sorted([B_CONTENT, D_FILED])
    );
  });

  it("a key limited to the OTHER space reads only that space's body", async () => {
    expect(
      await readAs(PERSON, {
        grant: { permissions: ["document.read"], workspaceIds: [OTHER] },
      })
    ).toEqual([B_OTHER]);
  });

  it("a key with no document.read reads no body, whatever its space", async () => {
    expect(
      await readAs(PERSON, {
        grant: { permissions: ["entity.read"], workspaceIds: [CONTENT] },
      })
    ).toEqual([]);
  });
});

describe("a member reads the body of an entity of their space", () => {
  it("an editor and a viewer of Content OS read its body, and the space's filed document", async () => {
    for (const member of [EDITOR, VIEWER]) {
      expect(await readAs(member)).toEqual(sorted([B_CONTENT, D_FILED]));
    }
  });

  it("the space lens holds the body; a lens on a space they are not in holds nothing", async () => {
    expect(await readAs(EDITOR, { lens: CONTENT })).toEqual(
      sorted([B_CONTENT, D_FILED])
    );
    expect(await readAs(EDITOR, { lens: OTHER })).toEqual([]);
    // The pod view (`null` lens) is not where a space's body lives.
    expect(await readAs(EDITOR, { lens: null })).toEqual([]);
  });

  it("a guest gets nothing new", async () => {
    expect(await readAs(GUEST)).toEqual([]);
  });
});

describe("the doors", () => {
  const ctx = (userId: string) =>
    ({ authenticated: true, userId, workspaceId: null }) as never;

  it("tRPC documents.get (the door Hub REST and MCP get_document reach): a space key reads the body", async () => {
    const res = await runWithGrant(grantOfScope(CONTENT_KEY), () =>
      documentsRouter.createCaller(ctx(PERSON)).get({ documentId: B_CONTENT })
    );
    expect(res.document.id).toBe(B_CONTENT);
  });

  it("tRPC documents.get: the same key gets not found for the other bodies and the loose document", async () => {
    for (const documentId of [B_OTHER, B_POD, B_TRASHED, D_LOOSE]) {
      await expect(
        runWithGrant(grantOfScope(CONTENT_KEY), () =>
          documentsRouter.createCaller(ctx(PERSON)).get({ documentId })
        )
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("documents.list does not start listing bodies", async () => {
    const res = await documentsRouter
      .createCaller(ctx(EDITOR))
      .list({ limit: 50, offset: 0 } as never);
    const ids = (res.documents as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain(D_FILED);
    expect(ids).not.toContain(B_CONTENT);
  });
});

describe("saving the body follows the entity's write floor", () => {
  it("an editor of the entity's space may save it; a viewer reads it only", async () => {
    const asEditor = await loadReadableDocument(EDITOR, B_CONTENT);
    expect(await canEditDocument(EDITOR, asEditor)).toEqual({
      allowed: true,
      reason: null,
    });
    const asViewer = await loadReadableDocument(VIEWER, B_CONTENT);
    expect(await canEditDocument(VIEWER, asViewer)).toEqual({
      allowed: false,
      reason: "view_only",
    });
  });

  it("a member still cannot reach a standalone pod-wide document", async () => {
    await expect(loadReadableDocument(EDITOR, D_LOOSE)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
