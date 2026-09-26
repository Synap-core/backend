/**
 * The per-comment THREAD → object-room backfill, on PGlite through the REAL
 * `backfillCommentThreads` and the REAL `ensureObjectChannel` mint.
 *
 * Pinned: a dry run writes NOTHING and plans every thread; the apply moves the
 * first message as an ANCHORED root and the rest as replies into the ONE room
 * (two threads on one document share it), archives the old thread with
 * `mergedInto`, deletes the `comments` links, leaves an orphan (deleted
 * document) untouched, and a second apply finds nothing. The legacy `{0,0}`
 * "Whole document" gets no offset; a heading at offset 0 (`{0,len}`) keeps it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { is, SQL } from "drizzle-orm";
import * as schema from "../schema/index.js";
import {
  backfillCommentThreads,
  legacyAnchor,
} from "./comment-threads-to-object-rooms.js";

const client = new PGlite();
const db = drizzle(client, { schema });
const dialect = new PgDialect();
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const basic = BASIC.test(t);
    let dflt = "";
    if (basic && c.hasDefault && c.default !== undefined) {
      const d = c.default as unknown;
      if (is(d, SQL)) dflt = ` default ${dialect.sqlToQuery(d).sql}`;
      else if (typeof d === "boolean" || typeof d === "number")
        dflt = ` default ${d}`;
      else if (typeof d === "string")
        dflt = ` default '${d.replace(/'/g, "''")}'`;
    }
    return `"${c.name}" ${basic ? t.replace(/\(.*\)/, "") : "text"}${c.primary ? " primary key" : ""}${dflt}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  client.query<T>(sql, params).then((r) => r.rows);

const OWNER = "owner";
const WS = randomUUID();
const DOC = randomUUID();
const GONE_DOC = randomUUID();
const T1 = randomUUID();
const T2 = randomUUID();
const T_GONE = randomUUID();
const M1 = randomUUID();
const M1R = randomUUID();
const M2 = randomUUID();
const MG = randomUUID();

async function thread(id: string, docId: string) {
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, context_object_type, context_object_id, status, metadata) values ($1,$2,$3,'thread','document',$4,'active','{"origin":"comment"}')`,
    [id, OWNER, WS, docId]
  );
}
async function message(
  id: string,
  channelId: string,
  content: string,
  at: string
) {
  await q(
    `insert into messages (id, channel_id, role, content, user_id, hash, timestamp, session_id) values ($1,$2,'user',$3,$4,$5,$6,$7)`,
    [id, channelId, content, OWNER, `h-${id}`, at, randomUUID()]
  );
}
async function link(messageId: string, docId: string, position: object) {
  await q(
    `insert into message_links (id, message_id, target_type, target_id, relationship_type, position, user_id) values ($1,$2,'document',$3,'comments',$4,$5)`,
    [randomUUID(), messageId, docId, JSON.stringify(position), OWNER]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  await q(
    `insert into documents (id, user_id, workspace_id, title, type) values ($1,$2,$3,'Plan','markdown')`,
    [DOC, OWNER, WS]
  );
  await thread(T1, DOC);
  await message(M1, T1, "Whole-doc remark", "2026-09-01T10:00:00Z");
  await message(M1R, T1, "A reply", "2026-09-01T11:00:00Z");
  await link(M1, DOC, { start: 0, end: 0 });
  await thread(T2, DOC);
  await message(M2, T2, "On the title", "2026-09-02T10:00:00Z");
  await link(M2, DOC, { start: 0, end: 7 });
  await thread(T_GONE, GONE_DOC); // its document no longer exists
  await message(MG, T_GONE, "Orphan", "2026-09-03T10:00:00Z");
}, 60_000);

describe("backfill: per-comment threads → the object's ONE room", () => {
  it("legacy anchors: {0,0} is the whole document; a heading at offset 0 keeps its offset", () => {
    const doc = { type: "document" as const, id: DOC };
    expect(legacyAnchor(doc, { start: 0, end: 0 })).toEqual({
      kind: "document",
      documentId: DOC,
    });
    expect(legacyAnchor(doc, { start: 0, end: 7 })).toEqual({
      kind: "document",
      documentId: DOC,
      offset: { start: 0, end: 7 },
    });
  });

  it("a dry run plans every thread and writes nothing", async () => {
    const before = await q(`select * from messages order by id`);
    const summary = await backfillCommentThreads(db as never, { dryRun: true });
    expect(summary.threads).toBe(3);
    expect(summary.orphaned).toBe(1);
    expect(summary.moved).toBe(0);
    expect(await q(`select * from messages order by id`)).toEqual(before);
    expect(
      await q(`select id from channels where channel_type='group'`)
    ).toEqual([]);
  });

  it("the apply moves roots (anchored) and replies into ONE room, archives the old threads, drops the links; a rerun finds nothing", async () => {
    const summary = await backfillCommentThreads(db as never, {
      dryRun: false,
    });
    expect(summary.moved).toBe(2);
    expect(summary.orphaned).toBe(1);
    expect(summary.messagesMoved).toBe(3);

    const rooms = await q<{ id: string }>(
      `select id from channels where channel_type='group' and context_object_type='document' and context_object_id=$1 and status='active'`,
      [DOC]
    );
    expect(rooms).toHaveLength(1);
    const room = rooms[0].id;

    const msgs = await q<{
      id: string;
      channel_id: string;
      parent_id: string | null;
      message_category: string;
      session_id: string | null;
      metadata: { anchor?: unknown } | null;
    }>(
      `select id, channel_id, parent_id, message_category, session_id, metadata from messages`
    );
    const byId = new Map(msgs.map((m) => [m.id, m]));
    for (const id of [M1, M1R, M2]) {
      expect(byId.get(id)?.channel_id).toBe(room);
      expect(byId.get(id)?.message_category).toBe("comment");
      expect(byId.get(id)?.session_id).toBeNull();
    }
    expect(byId.get(M1)?.parent_id).toBeNull();
    expect(byId.get(M1)?.metadata?.anchor).toEqual({
      kind: "document",
      documentId: DOC,
    });
    expect(byId.get(M1R)?.parent_id).toBe(M1);
    expect(byId.get(M2)?.metadata?.anchor).toEqual({
      kind: "document",
      documentId: DOC,
      offset: { start: 0, end: 7 },
    });
    // The orphan is untouched.
    expect(byId.get(MG)?.channel_id).toBe(T_GONE);

    const old = await q<{
      id: string;
      status: string;
      metadata: { mergedInto?: string };
    }>(`select id, status, metadata from channels where id = any($1)`, [
      [T1, T2, T_GONE],
    ]);
    const oldById = new Map(old.map((c) => [c.id, c]));
    expect(oldById.get(T1)?.status).toBe("archived");
    expect(oldById.get(T1)?.metadata.mergedInto).toBe(room);
    expect(oldById.get(T_GONE)?.status).toBe("active");
    expect(
      await q(
        `select id from message_links where relationship_type='comments' and message_id = any($1)`,
        [[M1, M2]]
      )
    ).toEqual([]);

    const rerun = await backfillCommentThreads(db as never, { dryRun: false });
    expect(rerun.moved).toBe(0);
    expect(rerun.threads).toBe(1); // only the orphan remains
  });
});
