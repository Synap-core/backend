/**
 * `messageLinks.create` / `listLinkedMessages` follow the MESSAGE's read floor
 * (audit F6), through the REAL procedures on PGlite.
 *
 * Before the fix, the only floor was "the link row's workspace", and the caller
 * chose it (their own `X-Workspace-Id`). Bob, a member of his own space only,
 * linked a message id from Alice's private AI thread to any target and then
 * read its `content` back through `listLinkedMessages`.
 *
 *   WA: Alice's space. Her private thread (channel type `thread`, owned by her)
 *       holds message M.
 *   WB: Bob's space. Bob is not a member of WA and does not own the thread.
 *
 * Real: workspaceProcedure (membership), the canonical grant-aware
 * `channelVisibilityWhere`, `MessageLinksRepository`.
 * Stubbed: `db`/`getDb` → a PGlite drizzle over every schema table; the
 * read-only guard; the audit log.
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
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { pgliteAllTablesDdl } from "../__tests__/pglite-ddl.js";
import { messageLinksRouter } from "./message-links.js";

const ALICE = randomUUID();
const BOB = randomUUID();
const WA = randomUUID();
const WB = randomUUID();
const ALICE_THREAD = randomUUID();
const M = randomUUID();
const SECRET = "alice private: the acquisition closes friday";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string, workspaceId: string) =>
  messageLinksRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId,
  } as never);

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  for (const [ws, owner] of [
    [WA, ALICE],
    [WB, BOB],
  ]) {
    await q(`insert into workspaces (id, name, owner_id) values ($1,$2,$3)`, [
      ws,
      `space ${ws.slice(0, 4)}`,
      owner,
    ]);
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')`,
      [ws, owner]
    );
  }
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, title) values ($1,$2,$3,'thread','Alice private')`,
    [ALICE_THREAD, ALICE, WA]
  );
  await q(
    `insert into messages (id, channel_id, user_id, role, content, hash) values ($1,$2,$3,'user',$4,'h')`,
    [M, ALICE_THREAD, ALICE, SECRET]
  );
});

describe("messageLinks — a link never hands out a message the caller cannot read (F6)", () => {
  it("refuses Bob linking a message from Alice's private thread", async () => {
    await expect(
      caller(BOB, WB).create({
        messageId: M,
        targetType: "entity" as never,
        targetId: randomUUID(),
        relationshipType: "references" as never,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from message_links where message_id = $1`,
      [M]
    );
    expect(rows[0].n).toBe(0);
  });

  it("does not return the content through a link that already exists in Bob's space", async () => {
    // A link row written before the fix (or by any other door): its workspace
    // is Bob's, but the message it joins in is still Alice's.
    const target = randomUUID();
    await q(
      `insert into message_links (message_id, target_type, target_id, relationship_type, user_id, workspace_id) values ($1,'entity',$2,'references',$3,$4)`,
      [M, target, BOB, WB]
    );
    const page = await caller(BOB, WB).listLinkedMessages({
      targetType: "entity" as never,
      targetId: target,
    });
    expect(page.items).toEqual([]);
    expect(JSON.stringify(page)).not.toContain(SECRET);
  });

  it("still lets Alice link and list her own message (the floor is not a wall)", async () => {
    const target = randomUUID();
    await caller(ALICE, WA).create({
      messageId: M,
      targetType: "entity" as never,
      targetId: target,
      relationshipType: "references" as never,
    });
    const page = await caller(ALICE, WA).listLinkedMessages({
      targetType: "entity" as never,
      targetId: target,
    });
    expect(page.items.map((i) => i.message.content)).toEqual([SECRET]);
  });
});
