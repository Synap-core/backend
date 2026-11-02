/**
 * `/api/external/chat` resolves a channel through the ONE chat-target resolver
 * (`utils/resolve-chat-target.ts`, shared with `/api/chat/stream`): an
 * explicit `channelId` must be an ACTIVE channel the caller can read, and the
 * channel list only offers channels the stream accepts. Driven through the
 * REAL Hono routes on PGlite.
 *
 *   WS: a space Alice and Bob both belong to.
 *   Alice owns a personal agent thread (no workspace) and a sub-thread in WS.
 *   Bob owns an active personal thread and an archived one.
 *
 * Real: the routes, `resolveChatTarget`, the grant-aware
 * `channelVisibilityWhere`, workspace membership.
 * Stubbed: the API-key middleware (sets the caller from a header);
 * `beginExternalDurableTurn` (fails, so an ACCEPTED channel stops at a known
 * 500 "Failed to start chat turn" instead of calling the Intelligence Service).
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

vi.mock("./middleware.js", () => ({
  externalApiKeyAuth:
    () =>
    async (
      c: {
        req: { header: (n: string) => string | undefined };
        set: (k: string, v: unknown) => void;
      },
      next: () => Promise<void>
    ) => {
      c.set("userId", c.req.header("x-test-user"));
      c.set("agentUserId", undefined);
      c.set("scopes", ["chat.stream"]);
      await next();
    },
}));

vi.mock(
  "../../services/chat-turns/external-durable-turn.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      beginExternalDurableTurn: vi
        .fn()
        .mockRejectedValue(new Error("stop after the channel resolved")),
    };
  }
);

import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import { externalChatApp } from "./chat.js";

const ALICE = randomUUID();
const BOB = randomUUID();
const WS = randomUUID();
const ALICE_PERSONAL = randomUUID();
const ALICE_SUB_THREAD = randomUUID();
const BOB_PERSONAL = randomUUID();
const BOB_ARCHIVED = randomUUID();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

function stream(userId: string, body: Record<string, unknown>) {
  return externalChatApp.request("/stream", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": userId },
    body: JSON.stringify({ query: "hello", workspaceId: WS, ...body }),
  });
}

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Shared',$2)`,
    [WS, ALICE]
  );
  for (const [user, role] of [
    [ALICE, "owner"],
    [BOB, "editor"],
  ]) {
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,$3)`,
      [WS, user, role]
    );
  }
  const channel = (
    id: string,
    owner: string,
    workspaceId: string | null,
    type: string,
    status = "active"
  ) =>
    q(
      `insert into channels (id, user_id, workspace_id, channel_type, status, title) values ($1,$2,$3,$4,$5,$6)`,
      [id, owner, workspaceId, type, status, `${type} of ${owner.slice(0, 4)}`]
    );
  await channel(ALICE_PERSONAL, ALICE, null, "personal");
  await channel(ALICE_SUB_THREAD, ALICE, WS, "sub_thread");
  await channel(BOB_PERSONAL, BOB, null, "personal");
  await channel(BOB_ARCHIVED, BOB, null, "personal", "archived");
});

describe("external chat: an explicit channelId is resolved through the read floor", () => {
  it("refuses another user's personal thread (no workspace) with a 404", async () => {
    const res = await stream(BOB, { channelId: ALICE_PERSONAL });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Channel not found" });
  });

  it("refuses another member's sub-thread in a shared workspace with a 404", async () => {
    const res = await stream(BOB, { channelId: ALICE_SUB_THREAD });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Channel not found" });
  });

  it("refuses the caller's own archived channel with a 404", async () => {
    const res = await stream(BOB, { channelId: BOB_ARCHIVED });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Channel not found" });
  });

  it("accepts the caller's own active channel (the floor is not a wall)", async () => {
    const res = await stream(BOB, { channelId: BOB_PERSONAL });
    // Past channel resolution: the stubbed durable-turn step answers.
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "Failed to start chat turn",
    });
  });
});

describe("external chat: GET /channels lists only what the stream accepts", () => {
  it("does not list another member's sub-thread to Bob, and lists it to Alice", async () => {
    const list = async (userId: string) => {
      const res = await externalChatApp.request("/channels", {
        headers: { "x-test-user": userId },
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as Array<{ id: string }>).map((r) => r.id);
    };
    expect(await list(BOB)).not.toContain(ALICE_SUB_THREAD);
    expect(await list(ALICE)).toContain(ALICE_SUB_THREAD);
  });
});
