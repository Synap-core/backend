/**
 * DOCUMENT EDIT RIGHTS follow the document's own floor (founder decision D-gov,
 * 2026-09-25) — driven through the REAL `loadEditableDocument` /
 * `loadReadableDocument`, the real access-layer `documents` VisibilityRule
 * (`scopedDb`) and the real `assertWorkspaceWrite`, on PGlite.
 *
 * Pinned:
 *   - workspace document: an editor member may edit; a viewer member may READ
 *     but not edit; a non-member gets NOT_FOUND (cannot probe ids);
 *   - pod-wide document: only its owner edits;
 *   - project document (a `belongs_to_project` edge): an editor+ project member
 *     may edit even without workspace membership; a viewer project member may
 *     read, not edit; `visible_to` (client portal) exposure never grants edit;
 *   - a document FOLLOWS ITS ENTITY: the body of a pod-shared entity (pod-wide
 *     entity + live pod-wide facet) is readable AND editable by a pod member;
 *     a standalone pod-wide document stays owner-only; a non-pod-member, or a
 *     document whose entity's facet was detached, gets nothing.
 *
 * What this CANNOT see: production Postgres (tables are generated from the
 * Drizzle definitions without FKs/NOT NULL/enums).
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
  return { ...actual, db: drizzle(client, { schema }) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  canEditDocument,
  loadEditableDocument,
  loadReadableDocument,
} from "./document-edit-access.js";

const OWNER = "owner-1";
const EDITOR = "ws-editor";
const VIEWER = "ws-viewer";
const STRANGER = "stranger";
const PROJ_EDITOR = "proj-editor";
const PROJ_VIEWER = "proj-viewer";
const CLIENT = "portal-client";
const POD_MEMBER = "pod-member";

const WS = randomUUID();
const PROJECT = randomUUID();
const CLIENT_ANCHOR = randomUUID();
const WS_DOC = randomUUID();
const POD_DOC = randomUUID();
const PROJECT_DOC = randomUUID();
const PORTAL_DOC = randomUUID();
const SHARED_BODY_DOC = randomUUID();
const DETACHED_BODY_DOC = randomUUID();
const SHARED_ENTITY = randomUUID();
const DETACHED_ENTITY = randomUUID();

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

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor'),($4,$2,$5,'viewer')`,
    [randomUUID(), WS, EDITOR, randomUUID(), VIEWER]
  );
  await q(
    `insert into project_members (id, project_id, user_id, role) values ($1,$2,$3,'editor'),($4,$2,$5,'viewer'),($6,$7,$8,'editor')`,
    [
      randomUUID(),
      PROJECT,
      PROJ_EDITOR,
      randomUUID(),
      PROJ_VIEWER,
      randomUUID(),
      CLIENT_ANCHOR,
      CLIENT,
    ]
  );
  for (const [id, ws] of [
    [WS_DOC, WS],
    [POD_DOC, null],
    [PROJECT_DOC, null],
    [PORTAL_DOC, null],
    [SHARED_BODY_DOC, null],
    [DETACHED_BODY_DOC, null],
  ] as const) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,$3,'Doc','markdown',1,1)`,
      [id, OWNER, ws]
    );
  }
  await q(
    `insert into relations (id, user_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,'belongs_to_project'),($5,$2,$6,$7,'visible_to')`,
    [
      randomUUID(),
      OWNER,
      PROJECT_DOC,
      PROJECT,
      randomUUID(),
      PORTAL_DOC,
      CLIENT_ANCHOR,
    ]
  );
  // Pod membership: the owner and one member (EDITOR / STRANGER are not).
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member')`,
    [randomUUID(), OWNER, randomUUID(), POD_MEMBER]
  );
  // Two pod-wide entities whose bodies are documents; one carries a LIVE
  // pod-wide facet (pod-shared), the other's facet was detached.
  await q(
    `insert into entities (id, user_id, workspace_id, title, document_id) values ($1,$2,null,'Shared note',$3),($4,$2,null,'Unshared note',$5)`,
    [SHARED_ENTITY, OWNER, SHARED_BODY_DOC, DETACHED_ENTITY, DETACHED_BODY_DOC]
  );
  await q(
    `insert into entity_facets (id, entity_id, workspace_id, deleted_at) values ($1,$2,null,null),($3,$4,null,now())`,
    [randomUUID(), SHARED_ENTITY, randomUUID(), DETACHED_ENTITY]
  );
}, 60_000);

describe("document edit rights follow the document's floor", () => {
  it("workspace document: editor edits, viewer reads only, stranger cannot see it", async () => {
    expect(await codeOf(loadEditableDocument(EDITOR, WS_DOC))).toBe("OK");
    expect(await codeOf(loadReadableDocument(VIEWER, WS_DOC))).toBe("OK");
    expect(await codeOf(loadEditableDocument(VIEWER, WS_DOC))).toBe(
      "FORBIDDEN"
    );
    expect(await codeOf(loadEditableDocument(STRANGER, WS_DOC))).toBe(
      "NOT_FOUND"
    );
  });

  it("pod-wide document: only the owner edits", async () => {
    expect(await codeOf(loadEditableDocument(OWNER, POD_DOC))).toBe("OK");
    expect(await codeOf(loadEditableDocument(EDITOR, POD_DOC))).toBe(
      "NOT_FOUND"
    );
  });

  it("project document: an editor project member edits; a viewer project member reads only", async () => {
    expect(await codeOf(loadEditableDocument(PROJ_EDITOR, PROJECT_DOC))).toBe(
      "OK"
    );
    expect(await codeOf(loadReadableDocument(PROJ_VIEWER, PROJECT_DOC))).toBe(
      "OK"
    );
    expect(await codeOf(loadEditableDocument(PROJ_VIEWER, PROJECT_DOC))).toBe(
      "FORBIDDEN"
    );
  });

  it("visible_to (client portal) exposure grants read, never edit", async () => {
    expect(await codeOf(loadReadableDocument(CLIENT, PORTAL_DOC))).toBe("OK");
    expect(await codeOf(loadEditableDocument(CLIENT, PORTAL_DOC))).toBe(
      "FORBIDDEN"
    );
  });

  it("a document follows its pod-shared entity: a pod member reads AND edits its body", async () => {
    expect(
      await codeOf(loadReadableDocument(POD_MEMBER, SHARED_BODY_DOC))
    ).toBe("OK");
    expect(
      await codeOf(loadEditableDocument(POD_MEMBER, SHARED_BODY_DOC))
    ).toBe("OK");
  });

  it("a standalone pod-level document stays owner-only for pod members", async () => {
    expect(await codeOf(loadEditableDocument(POD_MEMBER, POD_DOC))).toBe(
      "NOT_FOUND"
    );
    expect(await codeOf(loadEditableDocument(OWNER, POD_DOC))).toBe("OK");
  });

  it("a detached facet shares nothing, and a non-pod-member gets nothing", async () => {
    expect(
      await codeOf(loadEditableDocument(POD_MEMBER, DETACHED_BODY_DOC))
    ).toBe("NOT_FOUND");
    expect(await codeOf(loadEditableDocument(STRANGER, SHARED_BODY_DOC))).toBe(
      "NOT_FOUND"
    );
  });
});

/**
 * `canEditDocument` — the reader's `canEdit` (documents.get). It must be the
 * SAME gate as the writes, and a failed membership read must be an ERROR,
 * never a quiet "cannot edit" (EMPTY ≠ FAILED).
 */
describe("canEditDocument = the edit gate as a boolean", () => {
  // The row as a reader who can see it (the owner is not a workspace member).
  const READER: Record<string, string> = {
    [WS_DOC]: EDITOR,
    [PROJECT_DOC]: PROJ_EDITOR,
    [PORTAL_DOC]: CLIENT,
    [SHARED_BODY_DOC]: POD_MEMBER,
    [POD_DOC]: OWNER,
  };
  const row = (id: string) => loadReadableDocument(READER[id]!, id);

  it("agrees with loadEditableDocument on every floor", async () => {
    expect(await canEditDocument(EDITOR, await row(WS_DOC))).toBe(true);
    expect(await canEditDocument(VIEWER, await row(WS_DOC))).toBe(false);
    expect(await canEditDocument(PROJ_EDITOR, await row(PROJECT_DOC))).toBe(
      true
    );
    expect(await canEditDocument(PROJ_VIEWER, await row(PROJECT_DOC))).toBe(
      false
    );
    expect(await canEditDocument(CLIENT, await row(PORTAL_DOC))).toBe(false);
    expect(await canEditDocument(POD_MEMBER, await row(SHARED_BODY_DOC))).toBe(
      true
    );
    expect(await canEditDocument(OWNER, await row(POD_DOC))).toBe(true);
    expect(await canEditDocument(POD_MEMBER, await row(POD_DOC))).toBe(false);
  });

  it("a failed membership read is an error, not canEdit: false", async () => {
    const doc = await row(WS_DOC);
    await h.client!.exec(
      `alter table workspace_members rename to workspace_members_gone`
    );
    try {
      await expect(canEditDocument(VIEWER, doc)).rejects.toBeTruthy();
    } finally {
      await h.client!.exec(
        `alter table workspace_members_gone rename to workspace_members`
      );
    }
    expect(await canEditDocument(VIEWER, doc)).toBe(false);
  });
});
