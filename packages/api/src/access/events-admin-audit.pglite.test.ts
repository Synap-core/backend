/**
 * `events.adminSubjectActivity` — a pod admin's read of what was done to apps,
 * sign-in apps, MCP clients and computers, by anyone.
 *
 * Those events carry no space, so the `events` floor shows each only to its
 * actor: an admin opening Bob's app or computer saw nothing Bob did. The admin
 * door replaces the workspace floor with a subject-type allowlist
 * (`adminAuditEventWhere`) and keeps the session floor. Driven through the
 * REAL `EventRepository` SQL on PGlite; only the pod-admin predicate is stubbed.
 *
 * Cast: ADMIN is a pod admin; BOB a member; BOB_MAC Bob's computer (an agent
 * user with `agent_type = 'machine'`). Every row below is Bob's, with no space.
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
      workspaceMembers: actual.workspaceMembers as never,
      workspaces: actual.workspaces as never,
      events: actual.events as never,
    },
  });
  const Repo = actual.EventRepository as new (sql: unknown) => unknown;
  const repo = new Repo({
    unsafe: async (sql: string, params: unknown[]) =>
      (await client.query(sql, params)).rows,
  });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: repo,
    getEventRepository: () => repo,
  };
});

// The pod-admin predicate is pinned in its own tests; here one admin passes it.
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: vi.fn(async (userId: string) => userId === ADMIN),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { eventsRouter } from "../routers/events.js";

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

const ADMIN = "admin-audit";
const BOB = "bob-audit";
const BOB_MAC = "bob-mac-audit";
const APP = randomUUID();
const APP_KEY = randomUUID();
const CONNECTION = randomUUID();
const MCP_CLIENT = "mcp-client-audit";
const ENTITY = randomUUID();
const S_PRIVATE = randomUUID();

const E = {
  APP_RENAME: randomUUID(),
  APP_KEY_CREATE: randomUUID(),
  APP_KEY_ROTATE_BY_APP: randomUUID(),
  CONNECTION_APPROVE: randomUUID(),
  MCP_CONSENT: randomUUID(),
  MCP_REVOKE: randomUUID(),
  MAC_RENAME: randomUUID(),
  BOB_PROFILE: randomUUID(),
  ENTITY_EDIT: randomUUID(),
  APP_IN_PRIVATE_SESSION: randomUUID(),
};
const nameOf = new Map<string, string>(
  Object.entries(E).map(([k, v]) => [v, k])
);
const names = (rows: Array<{ id: string }>) =>
  rows.map((r) => nameOf.get(r.id) ?? r.id).sort();

const person = (userId: string) =>
  ({ authenticated: true, userId, session: { id: `s-${userId}` } }) as never;
const ALL_SUBJECTS = [
  APP,
  APP_KEY,
  CONNECTION,
  MCP_CLIENT,
  BOB_MAC,
  BOB,
  ENTITY,
];

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, user_type, agent_type) values
       ($1, 'human', null), ($2, 'human', null), ($3, 'agent', 'machine')`,
    [ADMIN, BOB, BOB_MAC]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, metadata, expected_outputs, channel_id, created_at, updated_at, started_at)
     values ($1, $2, null, 'Private', 'active', '{}'::jsonb, '[]'::jsonb, null, now(), now(), now())`,
    [S_PRIVATE, BOB]
  );

  const ev = (
    id: string,
    type: string,
    subjectType: string,
    subjectId: string,
    extra: { appId?: string; sessionId?: string } = {}
  ) =>
    q(
      `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id, workspace_id, session_id, app_id)
       values ($1, now(), $2, $3, $4, '{}'::jsonb, $5, null, $6, $7)`,
      [
        id,
        type,
        subjectId,
        subjectType,
        BOB,
        extra.sessionId ?? null,
        extra.appId ?? null,
      ]
    );
  await ev(E.APP_RENAME, "app.rename.completed", "app", APP);
  await ev(E.APP_KEY_CREATE, "apiKey.create.completed", "apiKey", APP_KEY);
  await ev(
    E.APP_KEY_ROTATE_BY_APP,
    "apiKey.rotate.completed",
    "apiKey",
    APP_KEY,
    {
      appId: "app_invoicer",
    }
  );
  await ev(
    E.CONNECTION_APPROVE,
    "application_connection.approve.completed",
    "application_connection",
    CONNECTION
  );
  await ev(E.MCP_CONSENT, "apiKey.create.completed", "apiKey", MCP_CLIENT);
  await ev(E.MCP_REVOKE, "api_keys.revoke.completed", "api_keys", MCP_CLIENT);
  await ev(E.MAC_RENAME, "user.update.completed", "user", BOB_MAC);
  // A `user` event about a PERSON is not a computer's: never admitted.
  await ev(E.BOB_PROFILE, "user.update.completed", "user", BOB);
  // Content is outside the allowlist, whatever id the caller names.
  await ev(E.ENTITY_EDIT, "entity.update.completed", "entity", ENTITY);
  // The session floor still holds: Bob's private session stays his.
  await ev(E.APP_IN_PRIVATE_SESSION, "app.rename.completed", "app", APP, {
    sessionId: S_PRIVATE,
  });
});

const read = (ctx: never, input: Record<string, unknown>) =>
  eventsRouter.createCaller(ctx).adminSubjectActivity({
    subjectIds: ALL_SUBJECTS,
    ...input,
  }) as Promise<Array<{ id: string }>>;

describe("events.adminSubjectActivity — a pod admin audits apps and computers", () => {
  it("returns anyone's app, sign-in app, MCP client and computer events — nothing else", async () => {
    expect(names(await read(person(ADMIN), {}))).toEqual(
      [
        "APP_KEY_CREATE",
        "APP_KEY_ROTATE_BY_APP",
        "APP_RENAME",
        "CONNECTION_APPROVE",
        "MAC_RENAME",
        "MCP_CONSENT",
        "MCP_REVOKE",
      ].sort()
    );
  });

  it("the member's own door still hides them from the admin", async () => {
    const rows = (await eventsRouter
      .createCaller(person(ADMIN))
      .search({ subjectIds: ALL_SUBJECTS, limit: 100, offset: 0 })) as Array<{
      id: string;
    }>;
    expect(rows).toEqual([]);
  });

  it("appId narrows to writes made with that app's key", async () => {
    expect(names(await read(person(ADMIN), { appId: "app_invoicer" }))).toEqual(
      ["APP_KEY_ROTATE_BY_APP"]
    );
  });

  it("pages with limit and offset", async () => {
    const first = await read(person(ADMIN), { limit: 4, offset: 0 });
    const rest = await read(person(ADMIN), { limit: 4, offset: 4 });
    expect(first).toHaveLength(4);
    expect(rest).toHaveLength(3);
    expect(new Set([...first, ...rest].map((r) => r.id)).size).toBe(7);
  });

  it("refuses a member who is not a pod admin", async () => {
    await expect(read(person(BOB), {})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("refuses an agent key acting for a pod admin", async () => {
    await expect(
      read(
        {
          authenticated: true,
          userId: ADMIN,
          agentUserId: "agent-of-admin",
          keyType: "agent",
          isHubProtocol: true,
        } as never,
        {}
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses the pod admin's own API key — a person signs in", async () => {
    await expect(
      read(
        { authenticated: true, userId: ADMIN, keyType: "user_pat" } as never,
        {}
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
