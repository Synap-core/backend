/**
 * Only a session's OWNER may stamp a channel with that session's context
 * (`session-context-stamp.ts`), on every door that writes a caller-supplied
 * `contextObjectType`:
 *   - `channel.ensure` (builtin capability) — the REAL handler;
 *   - Hub `POST /threads` and `POST /channels` — the REAL Hono routes.
 *
 * Real on PGlite: the stamp check, workspace membership, the thread insert.
 * Mocked: `resolveOrCreateChannel` for `channel.ensure` (observed — it pulls in
 * agent + project placement), and `resolveOrCreateExternalChannel` for
 * `POST /channels` (observed). Both directions are asserted: a stranger is
 * refused and NOTHING is written; the owner reaches the write unchanged.
 *
 * Does NOT cover: `resolveOrCreateChannel`'s own find-or-create (tested with it).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  ensured: [] as Array<Record<string, unknown>>,
  external: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("../../utils/resolve-or-create-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveOrCreateChannel: async (p: Record<string, unknown>) => {
      holder.ensured.push(p);
      return { id: "99999999-9999-4999-8999-999999999999" };
    },
  };
});
vi.mock("../connectors/inbound-recorder.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveOrCreateExternalChannel: async (p: Record<string, unknown>) => {
      holder.external.push(p);
      return {
        channelId: "88888888-8888-4888-8888-888888888888",
        contextObjectId: null,
      };
    },
  };
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  channels,
  focusSessions,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import { BUILTIN_VERBS } from "../capabilities/builtin-verbs.js";
import { registerThreadsRoutes } from "../../routers/hub-protocol/rest/threads.js";
import { registerChannelsRoutes } from "../../routers/hub-protocol/rest/channels.js";
import { sessionContextStampRefusal } from "./session-context-stamp.js";

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

const WS = "11111111-1111-4111-8111-111111111111";
const SESSION = "33333333-3333-4333-8333-333333333333";
const OWNER = "0aaaaaaa-0000-4000-8000-000000000001";
const COLLEAGUE = "0bbbbbbb-0000-4000-8000-000000000002";

let client: PGlite;

beforeEach(async () => {
  client = new PGlite();
  for (const t of [channels, focusSessions, workspaceMembers, workspaces]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  holder.db = drizzle(client, {
    schema: { channels, focusSessions, workspaceMembers, workspaces },
  });
  holder.ensured.length = 0;
  holder.external.length = 0;
  await client.exec(`
    insert into workspace_members (workspace_id, user_id, role) values
      ('${WS}', '${OWNER}', 'owner'),
      ('${WS}', '${COLLEAGUE}', 'editor');
    insert into focus_sessions (id, user_id, workspace_id, title, status) values
      ('${SESSION}', '${OWNER}', '${WS}', 'Budget review', 'active');
  `);
});

async function channelCount(): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from channels`
  );
  return rows[0]!.n;
}

describe("sessionContextStampRefusal", () => {
  it("allows the owner, refuses anyone else, and ignores other types", async () => {
    const stamp = (userId: string, type = "focus_session", id = SESSION) =>
      sessionContextStampRefusal({
        userId,
        contextObjectType: type,
        contextObjectId: id,
      });
    expect(await stamp(OWNER)).toBeNull();
    expect(await stamp(COLLEAGUE)).toBe("Session not found.");
    expect(await stamp(OWNER, "focus_session", "not-a-uuid")).not.toBeNull();
    expect(await stamp(COLLEAGUE, "entity")).toBeNull();
  });
});

describe("channel.ensure", () => {
  const ensure = (userId: string) =>
    BUILTIN_VERBS["channel.ensure"]!(
      { contextObjectType: "focus_session", contextObjectId: SESSION },
      { userId, workspaceId: WS }
    );

  it("refuses a colleague forging a thread stamped with a session they do not own", async () => {
    await expect(ensure(COLLEAGUE)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(holder.ensured).toHaveLength(0);
  });

  it("the owner path is unchanged: reaches the find-or-create with the stamp", async () => {
    await expect(ensure(OWNER)).resolves.toMatchObject({ created: true });
    expect(holder.ensured).toEqual([
      expect.objectContaining({
        userId: OWNER,
        contextObjectType: "focus_session",
        contextObjectId: SESSION,
      }),
    ]);
  });
});

function hubApp(userId: string) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("userId" as never, userId as never);
    c.set("scopes" as never, ["hub-protocol.write"] as never);
    c.set("keyType" as never, "user_pat" as never);
    await next();
  });
  registerThreadsRoutes(app as never);
  registerChannelsRoutes(app as never);
  return app;
}

const post = (userId: string, path: string, body: Record<string, unknown>) =>
  hubApp(userId).request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Hub POST /threads", () => {
  const body = (userId: string) => ({
    userId,
    workspaceId: WS,
    contextObjectType: "focus_session",
    contextObjectId: SESSION,
  });

  it("refuses a colleague's forged session stamp and inserts nothing", async () => {
    const res = await post(COLLEAGUE, "/threads", body(COLLEAGUE));
    expect(res.status).toBe(403);
    expect(await channelCount()).toBe(0);
  });

  it("the owner's stamped thread is created", async () => {
    const res = await post(OWNER, "/threads", body(OWNER));
    expect(res.status).toBe(200);
    expect(await channelCount()).toBe(1);
  });
});

describe("Hub POST /channels", () => {
  const body = {
    workspaceId: WS,
    externalSource: "discord",
    externalChannelId: "ext-1",
    contextObjectType: "focus_session",
    contextObjectId: SESSION,
  };

  it("refuses a colleague's forged session stamp before any upsert", async () => {
    const res = await post(COLLEAGUE, "/channels", body);
    expect(res.status).toBe(403);
    expect(holder.external).toHaveLength(0);
  });

  it("the owner passes the stamp check and reaches the upsert", async () => {
    await post(OWNER, "/channels", body);
    expect(holder.external).toHaveLength(1);
  });
});
