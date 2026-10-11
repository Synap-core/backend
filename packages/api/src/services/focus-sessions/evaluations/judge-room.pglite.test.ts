/**
 * The judge's room read on PGlite: `loadRoomMaterial` through the REAL history
 * door (`queryChannelMessages`) and the REAL channel read floor
 * (`channelVisibilityWhere`). Nothing between the door and the tables is faked.
 *
 * A session's `channelId` is a pointer, not a grant: pointed at a room the
 * session owner cannot read, the judge must be told "not readable" and must
 * never see one word of it. The owner's own room is read with the door's
 * filters — newest N, human + agent only, never deleted or ephemeral rows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  channels,
  channelMembers,
  messages,
  users,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import { loadRoomMaterial, buildJudgeMaterial } from "./judge-material.js";

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

let client: PGlite;

async function room(owner: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into channels (user_id, channel_type, scope, status, title)
     values ($1, 'thread', 'personal', 'active', 'Room') returning id`,
    [owner]
  );
  const id = rows[0]!.id;
  await client.query(
    `insert into channel_members (channel_id, member_id, member_kind, role) values ($1, $2, 'human', 'owner')`,
    [id, owner]
  );
  return id;
}

async function post(
  channelId: string,
  authorType: string,
  content: string,
  minutesAgo: number,
  extra: { ephemeral?: boolean; deleted?: boolean } = {}
): Promise<void> {
  await client.query(
    `insert into messages (channel_id, role, author_type, content, user_id, timestamp, ephemeral, deleted_at)
     values ($1, 'user', $2, $3, 'owner', now() - ($4 || ' minutes')::interval, $5, $6)`,
    [
      channelId,
      authorType,
      content,
      String(minutesAgo),
      extra.ephemeral ?? false,
      extra.deleted ? new Date() : null,
    ]
  );
}

beforeEach(async () => {
  client = new PGlite();
  // EVERY table: the channel read rule's object-room branch evaluates the
  // documents / views / entities floors, whatever the room.
  // (by name: the schema barrel exports some tables under two names).
  const allTables = new Map(
    (Object.values(schema) as unknown[])
      .filter(
        (v): v is PgTable =>
          !!v &&
          typeof v === "object" &&
          Symbol.for("drizzle:IsDrizzleTable") in v
      )
      .map((t) => [getTableConfig(t).name, t])
  );
  for (const t of allTables.values()) await client.exec(ddlFor(t));
  holder.db = drizzle(client, {
    schema: {
      channels,
      channelMembers,
      messages,
      users,
      workspaceMembers,
      workspaces,
    },
  });
  await client.exec(`
    insert into users (id, email, name, user_type) values
      ('owner', 'o@x', 'Olive Owner', 'human'),
      ('stranger', 's@x', 'Sam Stranger', 'human');
  `);
});

describe("loadRoomMaterial — read as the session owner, through the one door", () => {
  it("a room the owner cannot read is REFUSED, and the material says so without its words", async () => {
    const theirs = await room("stranger");
    await post(theirs, "human", "STRANGER-PRIVATE-WORDS", 1);

    const out = await loadRoomMaterial({ channelId: theirs, userId: "owner" });
    expect(out).toEqual({ status: "refused" });

    const material = buildJudgeMaterial(
      { goal: "g", expectedOutputs: [], verificationReport: null },
      [],
      undefined,
      [],
      out
    );
    expect(material).toContain("SESSION ROOM: not readable");
    expect(material).not.toContain("STRANGER-PRIVATE-WORDS");
  });

  it("the owner's own room: human + agent only, never deleted or ephemeral, oldest first", async () => {
    const mine = await room("owner");
    await post(mine, "human", "PERSON-ASK", 5);
    await post(mine, "ai_agent", "AGENT-EVIDENCE", 4);
    await post(mine, "bot", "BOT-NOTICE", 3);
    await post(mine, "human", "DELETED-WORDS", 2, { deleted: true });
    await post(mine, "ai_agent", "EPHEMERAL-RECAP", 1, { ephemeral: true });

    const out = await loadRoomMaterial({ channelId: mine, userId: "owner" });
    expect(out).toEqual({
      status: "ok",
      messages: [
        { author: "person", text: "PERSON-ASK" },
        { author: "agent", text: "AGENT-EVIDENCE" },
      ],
    });
  });

  it("no room is a true empty, not a refusal", async () => {
    expect(
      await loadRoomMaterial({ channelId: null, userId: "owner" })
    ).toEqual({ status: "ok", messages: [] });
  });
});
