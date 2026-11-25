/**
 * The backfill: file in its entity's space every pod-wide body of a live
 * entity stored in exactly one space (a part follows its whole, founder
 * decision 22226da5). Real SQL on PGlite, DDL from the Drizzle schema.
 *
 * Rows rule out: a dry run that writes, a run that misses the bug's row
 * (D_BUG), one that touches anything else (a trashed entity's body, a pod-wide
 * or homed entity's body, a standalone document, a trashed document, a body
 * already in a space, a body of entities in two spaces), one that changes
 * more than `workspace_id`, and a second run that is not a no-op.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { documents, entities } from "../schema/index.js";
import { fileSpaceEntityBodies } from "./file-space-entity-bodies.js";

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

const USER = randomUUID();
const W = randomUUID();
const X = randomUUID();

const D_BUG = randomUUID(); // pod-wide body of an entity in W → filed
const D_TRASHED_ENTITY = randomUUID(); // body of a trashed entity in W
const D_POD = randomUUID(); // body of a pod-wide entity
const D_HOMED = randomUUID(); // body of a pod-wide entity homed in W
const D_LOOSE = randomUUID(); // attached to nothing
const D_TRASHED = randomUUID(); // trashed document, body of an entity in W
const D_STORED = randomUUID(); // body already stored in X, entity in W
const D_TWO = randomUUID(); // body of entities in W and X → ambiguous

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

const snapshot = async () =>
  (
    await pg.query<{
      id: string;
      workspace_id: string | null;
      updated_at: string | null;
      title: string;
    }>(`select id, workspace_id, updated_at, title from documents order by id`)
  ).rows;

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [entities, documents]) await pg.exec(ddlFor(t as PgTable));
  db = drizzle(pg);

  const doc = (id: string, ws: string | null, trashed = false) =>
    pg.query(
      `insert into documents (id, user_id, workspace_id, title, type, updated_at, deleted_at)
       values ($1,$2,$3,'Body','markdown','2026-10-27T00:00:00Z',$4)`,
      [id, USER, ws, trashed ? new Date() : null]
    );
  for (const id of [D_BUG, D_TRASHED_ENTITY, D_POD, D_HOMED, D_LOOSE, D_TWO])
    await doc(id, null);
  await doc(D_TRASHED, null, true);
  await doc(D_STORED, X);

  const entity = (
    docId: string,
    ws: string | null,
    opts: { home?: string; trashed?: boolean } = {}
  ) =>
    pg.query(
      `insert into entities (id, user_id, workspace_id, home_workspace_id, document_id, deleted_at, type, title)
       values ($1,$2,$3,$4,$5,$6,'content-composition','e')`,
      [
        randomUUID(),
        USER,
        ws,
        opts.home ?? null,
        docId,
        opts.trashed ? new Date() : null,
      ]
    );
  await entity(D_BUG, W);
  await entity(D_TRASHED_ENTITY, W, { trashed: true });
  await entity(D_POD, null);
  await entity(D_HOMED, null, { home: W });
  await entity(D_TRASHED, W);
  await entity(D_STORED, W);
  await entity(D_TWO, W);
  await entity(D_TWO, X);
}, 60_000);

describe("fileSpaceEntityBodies", () => {
  it("a dry run counts and writes nothing", async () => {
    const before = await snapshot();
    expect(await fileSpaceEntityBodies(db, { apply: false })).toEqual({
      fileable: 1,
      ambiguous: 1,
      filed: 0,
    });
    expect(await snapshot()).toEqual(before);
  });

  it("an apply files exactly the bug's row, and changes nothing but its workspace", async () => {
    const before = await snapshot();
    expect(await fileSpaceEntityBodies(db, { apply: true })).toEqual({
      fileable: 1,
      ambiguous: 1,
      filed: 1,
    });
    const after = await snapshot();
    expect(after).toEqual(
      before.map((row) =>
        row.id === D_BUG ? { ...row, workspace_id: W } : row
      )
    );
  });

  it("a second apply is a no-op", async () => {
    const before = await snapshot();
    expect(await fileSpaceEntityBodies(db, { apply: true })).toEqual({
      fileable: 0,
      ambiguous: 1,
      filed: 0,
    });
    expect(await snapshot()).toEqual(before);
  });
});
