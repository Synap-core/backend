/**
 * `documents.list` and `documents.listInWorkspace` list FILED documents only:
 * the body of a note (entity), a whiteboard (view) or a skill is not a
 * document, and neither is an entity's picture or a raw capture. Real routers
 * on PGlite; the predicate under test is `filedDocumentWhere`.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      documents: actual.documents as never,
      workspaceMembers: actual.workspaceMembers as never,
      workspaces: actual.workspaces as never,
    },
  });
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { documentsRouter } from "./documents.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const USER = "user-filed-docs";
const WS = randomUUID();
const D = {
  filed: randomUUID(),
  noteBody: randomUUID(),
  whiteboardBody: randomUUID(),
  skillBody: randomUUID(),
  picture: randomUUID(),
  capture: randomUUID(),
};
const TITLES: Record<string, string> = {
  filed: "Team handbook",
  noteBody: "Body of a note",
  whiteboardBody: "Body of a whiteboard",
  skillBody: "Body of a skill",
  picture: "Picture of a bookmark",
  capture: "Raw capture",
};
const META: Record<string, unknown> = {
  picture: { uploadKind: "media-copy" },
  capture: { intakeSource: { kind: "text" } },
};

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, user_type) values ($1, 'human')`, [USER]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb)`,
    [WS, USER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, USER]
  );
  for (const [k, id] of Object.entries(D)) {
    await q(
      `insert into documents (id, title, type, workspace_id, user_id, storage_key, metadata, current_version, created_at, updated_at)
       values ($1, $2, 'markdown', $3, $4, $5, $6::jsonb, 1, now(), now())`,
      [
        id,
        TITLES[k],
        WS,
        USER,
        `key-${k}`,
        META[k] ? JSON.stringify(META[k]) : null,
      ]
    );
  }
  await q(
    `insert into entities (id, document_id, workspace_id, user_id) values ($1,$2,$3,$4)`,
    [randomUUID(), D.noteBody, WS, USER]
  );
  await q(`insert into views (id, document_id) values ($1,$2)`, [
    randomUUID(),
    D.whiteboardBody,
  ]);
  await q(`insert into skills (id, body_document_id) values ($1,$2)`, [
    randomUUID(),
    D.skillBody,
  ]);
});

const ctx = { authenticated: true, userId: USER, workspaceId: WS } as never;

describe("documents.list / listInWorkspace: filed documents only", () => {
  it("documents.list omits bodies, pictures and captures", async () => {
    const res = await documentsRouter.createCaller(ctx).list({} as never);
    expect(res.documents.map((d: { title: string }) => d.title)).toEqual([
      "Team handbook",
    ]);
  });

  it("documents.listInWorkspace omits them too", async () => {
    const res = (await documentsRouter
      .createCaller(ctx)
      .listInWorkspace({} as never)) as unknown;
    const titles = JSON.stringify(res);
    expect(titles).toContain("Team handbook");
    for (const t of Object.values(TITLES).filter((t) => t !== "Team handbook"))
      expect(titles).not.toContain(t);
  });
});
