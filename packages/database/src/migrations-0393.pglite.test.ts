/**
 * REAL-POSTGRES (PGlite) test for migration 0393 — a channel is the
 * conversation with a person (channels wave, lane A):
 *   - on a pod at the pre-0393 shape, the migration (twice: idempotent) adds
 *     `direction`, `delivery_status`, `external_message_id` with their CHECKs,
 *     and the baseline declares the same columns and indexes;
 *   - the backfill: the provider id moves out of metadata (the OLDEST row of
 *     a channel keeps a duplicated id), external-channel rows get a
 *     direction (external author → inbound, else outbound + sent), in-pod
 *     chat stays NULL;
 *   - a second pending channel for the same person, tool and account is
 *     archived (never deleted) so the one-pending unique index can exist;
 *   - the unique indexes hold: one row per provider message per channel, one
 *     pending external channel per person, tool and account.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { messages } from "./schema/messages.js";
import { channels } from "./schema/channels.js";
import { proposals } from "./schema/proposals.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0393 = read("0393_channel_messages_direction_status.sql");
const BASELINE = read("0000_baseline_schema.sql");

/** The three tables as a pod had them before 0393 (the columns 0393 reads). */
const PRE_0393 = `
  CREATE TABLE channels (
    id uuid PRIMARY KEY,
    user_id text NOT NULL,
    channel_type text NOT NULL DEFAULT 'thread',
    status text NOT NULL DEFAULT 'active',
    context_object_type text,
    context_object_id uuid,
    external_source text,
    external_id text,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE messages (
    id uuid PRIMARY KEY,
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_type text NOT NULL DEFAULT 'human',
    content text NOT NULL DEFAULT '',
    metadata jsonb,
    timestamp timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE proposals (
    id uuid PRIMARY KEY,
    proposal_type text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    data jsonb NOT NULL
  );
`;

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PERSON = id(100);
const EXT = id(1); // an external channel with history
const CHAT = id(2); // an in-pod chat
const PENDING_A = id(3); // two pending channels, same person/tool/account
const PENDING_B = id(4);
const PENDING_OTHER_ACCOUNT = id(5);

let pg: PGlite;
const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await pg.query<T>(sql, params)).rows;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(PRE_0393);
  await pg.exec(`
    INSERT INTO channels (id, user_id, channel_type, external_source, external_id, context_object_type, context_object_id, metadata, created_at) VALUES
      ('${EXT}', 'u1', 'external', 'linkedin', 'chat-1', 'entity', '${PERSON}', '{"accountId":"acc"}', '2026-01-01'),
      ('${CHAT}', 'u1', 'thread', NULL, NULL, NULL, NULL, NULL, '2026-01-01'),
      ('${PENDING_A}', 'u1', 'external', 'linkedin', NULL, 'entity', '${PERSON}', '{"accountId":"acc2"}', '2026-01-02'),
      ('${PENDING_B}', 'u1', 'external', 'linkedin', NULL, 'entity', '${PERSON}', '{"accountId":"acc2"}', '2026-01-03'),
      ('${PENDING_OTHER_ACCOUNT}', 'u1', 'external', 'linkedin', NULL, 'entity', '${PERSON}', '{"accountId":"acc3"}', '2026-01-04');
    INSERT INTO messages (id, channel_id, author_type, metadata, timestamp) VALUES
      ('${id(11)}', '${EXT}', 'external', '{"externalMessageId":"m-1"}', '2026-01-01T10:00:00Z'),
      ('${id(12)}', '${EXT}', 'human', '{"externalMessageId":"m-2"}', '2026-01-01T11:00:00Z'),
      ('${id(13)}', '${EXT}', 'human', '{"externalMessageId":"m-2"}', '2026-01-01T11:00:01Z'),
      ('${id(14)}', '${EXT}', 'ai_agent', NULL, '2026-01-01T12:00:00Z'),
      ('${id(21)}', '${CHAT}', 'human', '{"externalMessageId":"m-1"}', '2026-01-01T10:00:00Z');
  `);
  await pg.exec(M0393);
  await pg.exec(M0393);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("migration 0393 — direction, delivery, provider message id", () => {
  it("adds the three columns, as the schema and the baseline declare them", async () => {
    const declared = getTableConfig(messages).columns.map((c) => c.name);
    const added = ["direction", "delivery_status", "external_message_id"];
    for (const c of added) expect(declared).toContain(c);
    const live = (
      await rows<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'messages'`
      )
    ).map((r) => r.column_name);
    for (const c of added) {
      expect(live).toContain(c);
      expect(BASELINE).toContain(
        `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "${c}"`
      );
      expect(
        REQUIRED_COLUMNS.some((r) => r.table === "messages" && r.column === c)
      ).toBe(true);
    }
  });

  it("the CHECKs refuse a direction or status outside the contract", async () => {
    await expect(
      pg.query(
        `UPDATE messages SET direction = 'sideways' WHERE id = '${id(11)}'`
      )
    ).rejects.toThrow(/messages_direction_check/);
    await expect(
      pg.query(
        `UPDATE messages SET delivery_status = 'proposed' WHERE id = '${id(12)}'`
      )
    ).rejects.toThrow(/messages_delivery_status_check/);
  });

  it("backfills the provider id; the OLDEST row keeps a duplicated one", async () => {
    const r = await rows<{ id: string; external_message_id: string | null }>(
      `SELECT id, external_message_id FROM messages ORDER BY id`
    );
    const by = Object.fromEntries(r.map((x) => [x.id, x.external_message_id]));
    expect(by[id(11)]).toBe("m-1");
    expect(by[id(12)]).toBe("m-2");
    expect(by[id(13)]).toBeNull();
    expect(by[id(14)]).toBeNull();
    // Another channel may carry the same provider id.
    expect(by[id(21)]).toBe("m-1");
  });

  it("gives external-channel rows a direction; in-pod chat stays NULL", async () => {
    const r = await rows<{
      id: string;
      direction: string | null;
      delivery_status: string | null;
    }>(`SELECT id, direction, delivery_status FROM messages ORDER BY id`);
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(by[id(11)]).toMatchObject({
      direction: "inbound",
      delivery_status: null,
    });
    expect(by[id(12)]).toMatchObject({
      direction: "outbound",
      delivery_status: "sent",
    });
    expect(by[id(14)]).toMatchObject({
      direction: "outbound",
      delivery_status: "sent",
    });
    expect(by[id(21)]).toMatchObject({
      direction: null,
      delivery_status: null,
    });
  });

  it("archives a second pending channel (oldest kept, nothing deleted)", async () => {
    const r = await rows<{
      id: string;
      status: string;
      metadata: Record<string, unknown>;
    }>(`SELECT id, status, metadata FROM channels ORDER BY id`);
    expect(r).toHaveLength(5);
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(by[PENDING_A]!.status).toBe("active");
    expect(by[PENDING_B]!.status).toBe("archived");
    expect(by[PENDING_B]!.metadata.archivedBy).toBe("0393");
    expect(by[PENDING_OTHER_ACCOUNT]!.status).toBe("active");
    expect(by[EXT]!.status).toBe("active");
  });

  it("one row per provider message per channel", async () => {
    await expect(
      pg.query(
        `INSERT INTO messages (id, channel_id, external_message_id) VALUES ('${id(15)}', '${EXT}', 'm-1')`
      )
    ).rejects.toThrow(/messages_channel_ext_msg_uniq/);
  });

  it("one pending external channel per person, tool and account", async () => {
    await expect(
      pg.query(
        `INSERT INTO channels (id, user_id, channel_type, external_source, context_object_type, context_object_id, metadata)
         VALUES ('${id(6)}', 'u1', 'external', 'linkedin', 'entity', '${PERSON}', '{"accountId":"acc3"}')`
      )
    ).rejects.toThrow(/channels_external_pending_uniq/);
    // Once the chat id is known, it is no longer pending.
    await pg.query(
      `INSERT INTO channels (id, user_id, channel_type, external_source, external_id, context_object_type, context_object_id, metadata)
       VALUES ('${id(7)}', 'u1', 'external', 'linkedin', 'chat-7', 'entity', '${PERSON}', '{"accountId":"acc3"}')`
    );
  });

  it("the schema and the baseline declare the indexes the migration creates", async () => {
    const declared = [
      ...getTableConfig(messages).indexes,
      ...getTableConfig(channels).indexes,
      ...getTableConfig(proposals).indexes,
    ].map((i) => i.config.name);
    const live = (
      await rows<{ indexname: string }>(`SELECT indexname FROM pg_indexes`)
    ).map((r) => r.indexname);
    for (const name of [
      "messages_channel_ext_msg_uniq",
      "channels_external_pending_uniq",
      "proposals_msg_channel_idx",
    ]) {
      expect(declared).toContain(name);
      expect(live).toContain(name);
      expect(BASELINE).toContain(`"${name}"`);
    }
  });
});
