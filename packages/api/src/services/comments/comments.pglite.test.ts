/**
 * COMMENTS IN THE OBJECT'S ONE ROOM (Documents v2, founder model 2026-09-25/26)
 * — driven through the REAL comments door, the REAL object-room mint
 * (`ChannelRepository.ensureObjectChannel` + the 0279 unique index), the REAL
 * channel read rule (`channelVisibilityWhere` branch 5, fed by the registered
 * `documents` VisibilityRule) and the REAL message door, on PGlite.
 *
 * Pinned:
 *   - the write floor is READ access (V2): a viewer comments, a stranger gets
 *     NOT_FOUND and no room is minted for them;
 *   - another member OPENS the thread (the old owner-private THREAD answered
 *     NOT_FOUND): room visible, messages readable through the channel door;
 *   - the room follows the OBJECT, never "pod-wide by accident": a private
 *     pod-wide document's room is invisible to other pod users;
 *   - the channel SHOWS the comment (anchored root, `parent_id` replies);
 *   - resolve: counts move; author or editor only; idempotent;
 *   - ONE room under concurrent ensure (the race);
 *   - realtime: `comments:changed` on post and on resolve;
 *   - a reply tells the thread's author (`comment.reply`), not the replier;
 *   - the private "Ask AI" thread is a SUB_THREAD of the room, private.
 *
 * What this CANNOT see: production Postgres constraints beyond the 0279 index
 * (tables are generated from the Drizzle definitions, defaults included).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  emits: [] as Array<{ event: string; data: Record<string, unknown> }>,
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
    db: drizzle(client, { schema }),
    getDb: async () => drizzle(client, { schema }),
    // The event log is not what this file pins.
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: (o: { event: string; data: Record<string, unknown> }) =>
    h.emits.push({ event: o.event, data: o.data }),
}));

import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { is, SQL } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import { db, ChannelRepository } from "@synap/database";
import {
  listObjectComments,
  postComment,
  setCommentResolved,
} from "./comments.js";
import { ensurePrivateObjectThread } from "./object-channel.js";
import {
  canUserSeeChannel,
  listChannelAudienceUserIds,
} from "../../utils/channel-visibility.js";
import { queryChannelMessages } from "../../utils/query-channel-messages.js";

const OWNER = "owner-1";
const EDITOR = "ws-editor";
const VIEWER = "ws-viewer";
const STRANGER = "stranger";
const POD_MEMBER = "pod-member";

const WS = randomUUID();
const WS_DOC = randomUUID();
const POD_DOC = randomUUID();
const RACE_DOC = randomUUID();
const LEGACY_DOC = randomUUID();
const ENTITY = randomUUID();
const PROJECT = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
const dialect = new PgDialect();

function defaultFor(c: {
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
}): string {
  if (!c.hasDefault || c.default === undefined) return "";
  const d = c.default;
  if (is(d, SQL)) return ` default ${dialect.sqlToQuery(d).sql}`;
  if (typeof d === "boolean" || typeof d === "number") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (c.getSQLType().startsWith("json")) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const dflt = BASIC.test(t) ? defaultFor(c) : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${dflt}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

const docAnchor = (documentId: string, extra: Record<string, unknown> = {}) =>
  ({ kind: "document", documentId, ...extra }) as const;

async function roomOf(documentId: string): Promise<string[]> {
  const { rows } = await q<{ id: string }>(
    `select id from channels where context_object_type='document' and context_object_id=$1 and channel_type='group' and status='active'`,
    [documentId]
  );
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  // The 0279 arbiter, from the migration itself (never a restatement).
  const here = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(
    join(
      here,
      "../../../../database/migrations/0279_object_rooms_and_comment_resolve.sql"
    ),
    "utf8"
  );
  const index = migration.match(
    /CREATE UNIQUE INDEX IF NOT EXISTS "channels_object_room_uniq"[\s\S]*?;/
  );
  expect(index, "0279 declares the object-room index").not.toBeNull();
  await h.client!.exec(index![0]);

  for (const [id, name] of [
    [OWNER, "Olive Owner"],
    [EDITOR, "Eddie Editor"],
    [VIEWER, "Vera Viewer"],
    [STRANGER, "Sam Stranger"],
    [POD_MEMBER, "Pat Member"],
  ]) {
    await q(
      `insert into users (id, email, name, user_type) values ($1,$2,$3,'human')`,
      [id, `${id}@x.test`, name]
    );
  }
  await q(`insert into workspaces (id, name, owner_id) values ($1,'WS',$2)`, [
    WS,
    OWNER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$2,$5,'editor'),($6,$2,$7,'viewer')`,
    [randomUUID(), WS, OWNER, randomUUID(), EDITOR, randomUUID(), VIEWER]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member')`,
    [randomUUID(), OWNER, randomUUID(), POD_MEMBER]
  );
  for (const [id, ws] of [
    [WS_DOC, WS],
    [POD_DOC, null],
    [RACE_DOC, WS],
    [LEGACY_DOC, WS],
  ] as const) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,$3,'Plan','markdown',1,1)`,
      [id, OWNER, ws]
    );
  }
  // An entity filed into ONE project (rung 4 of the project ladder).
  await q(
    `insert into entities (id, user_id, workspace_id, title, type) values ($1,$2,$3,'Acme','company')`,
    [ENTITY, OWNER, WS]
  );
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,$5,'belongs_to_project')`,
    [randomUUID(), OWNER, WS, ENTITY, PROJECT]
  );
}, 60_000);

describe("a comment is an anchored message in the object's ONE room", () => {
  it("write floor = READ access: a viewer comments; a stranger gets NOT_FOUND and mints nothing", async () => {
    expect(
      await codeOf(
        postComment({
          userId: STRANGER,
          anchor: docAnchor(WS_DOC),
          content: "let me in",
        })
      )
    ).toBe("NOT_FOUND");
    expect(await roomOf(WS_DOC)).toEqual([]);

    const posted = await postComment({
      userId: VIEWER,
      anchor: docAnchor(WS_DOC, {
        blockRef: { kind: "heading", text: "Plan", occurrence: 0 },
        offset: { start: 0, end: 6 },
      }),
      content: "Is this the final plan?",
    });
    expect(posted.ackState).toBe("applied");
    expect(await roomOf(WS_DOC)).toEqual([posted.channelId]);
  });

  it("another member OPENS the thread (the old owner-private thread answered NOT_FOUND)", async () => {
    const [room] = await roomOf(WS_DOC);
    expect(await canUserSeeChannel(db, room, EDITOR)).toBe(true);
    const rows = await queryChannelMessages(db, {
      channelId: room,
      userId: EDITOR,
      order: "asc",
    });
    expect(rows.map((r) => r.content)).toContain("Is this the final plan?");
    const listing = await listObjectComments({
      userId: EDITOR,
      object: { type: "document", id: WS_DOC },
      state: "open",
    });
    expect(listing.threads.map((t) => t.content)).toEqual([
      "Is this the final plan?",
    ]);
    // …and the stranger still cannot, through any door.
    expect(await canUserSeeChannel(db, room, STRANGER)).toBe(false);
    expect(
      await codeOf(
        queryChannelMessages(db, {
          channelId: room,
          userId: STRANGER,
          order: "asc",
        })
      )
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        listObjectComments({
          userId: STRANGER,
          object: { type: "document", id: WS_DOC },
          state: "open",
        })
      )
    ).toBe("NOT_FOUND");
  });

  it("the room follows the OBJECT — a private pod-wide document's room is not pod-wide by accident", async () => {
    const posted = await postComment({
      userId: OWNER,
      anchor: docAnchor(POD_DOC),
      content: "note to self",
    });
    for (const other of [POD_MEMBER, EDITOR, VIEWER]) {
      expect(await canUserSeeChannel(db, posted.channelId, other)).toBe(false);
    }
    expect(await canUserSeeChannel(db, posted.channelId, OWNER)).toBe(true);
    expect(
      (await listChannelAudienceUserIds(db, posted.channelId)).sort()
    ).toEqual([OWNER]);
    // The workspace document's room: exactly its readers.
    const [wsRoom] = await roomOf(WS_DOC);
    expect((await listChannelAudienceUserIds(db, wsRoom)).sort()).toEqual(
      [EDITOR, OWNER, VIEWER].sort()
    );
  });

  it("the channel SHOWS the comment: an anchored root, and replies under it", async () => {
    const root = await postComment({
      userId: EDITOR,
      anchor: docAnchor(WS_DOC, { quote: "ship on Friday" }),
      content: "Friday is tight",
    });
    const reply = await postComment({
      userId: VIEWER,
      parentId: root.messageId,
      content: "Agreed",
    });
    // A reply to a REPLY joins the root.
    const nested = await postComment({
      userId: OWNER,
      parentId: reply.messageId,
      content: "Monday then",
    });
    expect(reply.rootId).toBe(root.messageId);
    expect(nested.rootId).toBe(root.messageId);

    const { rows } = await q<{
      id: string;
      parent_id: string | null;
      message_category: string;
      metadata: { anchor?: { quote?: string } } | null;
    }>(
      `select id, parent_id, message_category, metadata from messages where channel_id=$1`,
      [root.channelId]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(root.messageId)?.metadata?.anchor?.quote).toBe(
      "ship on Friday"
    );
    expect(byId.get(root.messageId)?.message_category).toBe("comment");
    expect(byId.get(reply.messageId)?.parent_id).toBe(root.messageId);
    expect(byId.get(nested.messageId)?.parent_id).toBe(root.messageId);

    const listing = await listObjectComments({
      userId: VIEWER,
      object: { type: "document", id: WS_DOC },
      state: "open",
    });
    const thread = listing.threads.find((t) => t.id === root.messageId)!;
    expect(thread.replyCount).toBe(2);
    expect(thread.replies.map((r) => r.content)).toEqual([
      "Agreed",
      "Monday then",
    ]);
    // Realtime: every post told the room's readers.
    expect(
      h.emits.filter(
        (e) =>
          e.event === "comments:changed" && e.data.rootId === root.messageId
      ).length
    ).toBe(3);
  });

  it("a reply tells the thread's author, never the replier", async () => {
    const { rows } = await q<{ user_id: string; type: string }>(
      `select user_id, type from notifications where type='comment.reply'`
    );
    // EDITOR's thread got two replies (VIEWER, OWNER) → EDITOR told twice.
    expect(rows.map((r) => r.user_id)).toEqual([EDITOR, EDITOR]);
  });

  it("an @mention reaches a READER of the document, never someone it excludes", async () => {
    await postComment({
      userId: OWNER,
      anchor: docAnchor(WS_DOC),
      content: "@vera and @sam please look",
    });
    const { rows } = await q<{ user_id: string }>(
      `select user_id from notifications where type='chat.mention'`
    );
    expect(rows.map((r) => r.user_id)).toEqual([VIEWER]);
  });

  it("resolve: counts move; author or editor only; idempotent", async () => {
    const object = { type: "document" as const, id: WS_DOC };
    const before = await listObjectComments({
      userId: VIEWER,
      object,
      state: "open",
    });
    const viewersThread = before.threads.find(
      (t) => t.content === "Is this the final plan?"
    )!;
    const editorsThread = before.threads.find(
      (t) => t.content === "Friday is tight"
    )!;

    // The listing reports the SAME rule the door enforces.
    expect(viewersThread.canResolve).toBe(true);
    expect(editorsThread.canResolve).toBe(false);
    const asEditor = await listObjectComments({
      userId: EDITOR,
      object,
      state: "open",
    });
    expect(asEditor.threads.every((t) => t.canResolve)).toBe(true);
    // A viewer may not resolve someone else's thread.
    expect(
      await codeOf(
        setCommentResolved({
          userId: VIEWER,
          messageId: editorsThread.id,
          resolved: true,
        })
      )
    ).toBe("FORBIDDEN");
    // …but may resolve their own (by a REPLY id too — it resolves the root).
    const own = await setCommentResolved({
      userId: VIEWER,
      messageId: viewersThread.id,
      resolved: true,
    });
    expect(own.changed).toBe(true);
    // An editor resolves anyone's.
    await setCommentResolved({
      userId: EDITOR,
      messageId: editorsThread.replies[0].id,
      resolved: true,
    });
    const again = await setCommentResolved({
      userId: EDITOR,
      messageId: editorsThread.id,
      resolved: true,
    });
    expect(again.changed).toBe(false);

    const after = await listObjectComments({
      userId: VIEWER,
      object,
      state: "resolved",
    });
    expect(after.counts).toEqual({
      open: before.counts.open - 2,
      resolved: before.counts.resolved + 2,
    });
    expect(after.threads.map((t) => t.id).sort()).toEqual(
      [viewersThread.id, editorsThread.id].sort()
    );
    expect(after.threads[0].resolvedBy).toBeTruthy();

    // Re-open.
    await setCommentResolved({
      userId: VIEWER,
      messageId: viewersThread.id,
      resolved: false,
    });
    const reopened = await listObjectComments({
      userId: VIEWER,
      object,
      state: "open",
    });
    expect(reopened.counts.open).toBe(before.counts.open - 1);
    expect(h.emits.some((e) => e.data.rootId === viewersThread.id)).toBe(true);
  });

  it("ONE room under concurrent ensure (the race)", async () => {
    const repo = new ChannelRepository(db);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.ensureObjectChannel({ type: "document", id: RACE_DOC })
      )
    );
    const ids = new Set(results.map((r) => r!.channel.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r!.created).length).toBe(1);
    expect(await roomOf(RACE_DOC)).toEqual([...ids]);
  });

  it("PROJECT LENS (rung 4): a private thread about an ENTITY takes its sole project; one about a DOCUMENT never feeds the entity rung", async () => {
    const aboutEntity = await ensurePrivateObjectThread({
      userId: EDITOR,
      ref: { type: "entity", id: ENTITY },
    });
    expect(aboutEntity.projectId).toBe(PROJECT);
    expect(aboutEntity.channelType).toBe("sub_thread");
    const aboutDoc = await ensurePrivateObjectThread({
      userId: EDITOR,
      ref: { type: "document", id: WS_DOC },
    });
    expect(aboutDoc.projectId).toBeNull();
  });

  it("the private 'Ask AI' thread is a SUB_THREAD of the room, private to its owner; a legacy thread is adopted", async () => {
    const legacyId = randomUUID();
    await q(
      `insert into channels (id, user_id, workspace_id, channel_type, context_object_type, context_object_id, status) values ($1,$2,$3,'thread','document',$4,'active')`,
      [legacyId, VIEWER, WS, LEGACY_DOC]
    );
    const adopted = await ensurePrivateObjectThread({
      userId: VIEWER,
      ref: { type: "document", id: LEGACY_DOC },
    });
    expect(adopted.id).toBe(legacyId);
    expect(adopted.channelType).toBe("sub_thread");
    const [room] = await roomOf(LEGACY_DOC);
    expect(adopted.parentChannelId).toBe(room);

    const mine = await ensurePrivateObjectThread({
      userId: EDITOR,
      ref: { type: "document", id: LEGACY_DOC },
    });
    expect(mine.id).not.toBe(legacyId);
    expect(mine.parentChannelId).toBe(room);
    expect(await canUserSeeChannel(db, mine.id, EDITOR)).toBe(true);
    expect(await canUserSeeChannel(db, mine.id, VIEWER)).toBe(false);
    // Idempotent.
    const again = await ensurePrivateObjectThread({
      userId: EDITOR,
      ref: { type: "document", id: LEGACY_DOC },
    });
    expect(again.id).toBe(mine.id);
    // A stranger gets no thread about a document they cannot read.
    expect(
      await codeOf(
        ensurePrivateObjectThread({
          userId: STRANGER,
          ref: { type: "document", id: LEGACY_DOC },
        })
      )
    ).toBe("NOT_FOUND");
  });
});
