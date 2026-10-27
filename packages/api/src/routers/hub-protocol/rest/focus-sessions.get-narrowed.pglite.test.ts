/**
 * GET /focus-sessions/:id for a key pinned to spaces (a pod app): the row, read
 * through the key's grant, never the packet it cannot read.
 *
 * The door used to be an aggregate read (`READS` of twelve subjects), which no
 * pinned grant ever passes: every pod app was refused GRANT_DOOR_UNSUPPORTED on
 * a session the list door already gave it. The fence now admits a key that
 * reads `session`; the ROUTE floors the row with `sessionReadableWhere` (the
 * list door's grant clause) and adds the packet only when
 * `sessionPacketReadable`.
 *
 * Through the REAL route on PGlite, the grant set as the auth middleware sets
 * it. Rows rule out: a floor that ignores the grant (the other-space row), a
 * packet served to a key that cannot read it (the withheld row), and a
 * narrowing that also strips the packet from a person (the control row).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

// The packet's own readers are not under test here: a sentinel says whether
// the route asked for them at all.
vi.mock("../../../services/focus-sessions/continuation-packet.js", () => ({
  projectContinuationPacket: async () => ({
    rerun: null,
    evaluation: { status: "unavailable" },
    sentinel: "packet",
  }),
}));
vi.mock(
  "../../../services/focus-sessions/session-outputs.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    readSessionOutcomesSection: async () => ({ status: "unavailable" }),
  })
);

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { runWithGrant } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

const OWNER = randomUUID();
const WS_CRM = randomUUID();
const WS_OTHER = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

async function seedSession(workspaceId: string): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into focus_sessions (id, user_id, workspace_id, title, status, started_at, metadata) values ($1, $2, $3, 'Build a prospect list', 'active', now(), '{"stage":{"index":1,"of":4}}'::jsonb)`,
    [id, OWNER, workspaceId]
  );
  return id;
}

const APP_GRANT = {
  scopes: [
    {
      permissions: ["session.read", "entity.person.read"],
      workspaceIds: [WS_CRM],
    },
  ],
  clientId: null,
};

function get(id: string, grant?: unknown) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerFocusSessionsRoutes(app);
  const send = () => app.request(`/focus-sessions/${id}`);
  return grant ? runWithGrant(grant as never, () => send()) : send();
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
});

describe("GET /focus-sessions/:id — a pinned key reads the row, not the packet", () => {
  it("an app pinned to the CRM space reads a CRM session: the row, packet withheld", async () => {
    const id = await seedSession(WS_CRM);
    const res = await get(id, APP_GRANT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(id);
    expect(body.title).toBe("Build a prospect list");
    expect(body.metadata).toEqual({ stage: { index: 1, of: 4 } });
    expect(body.packet).toMatchObject({ status: "withheld" });
    expect(body.continuation).toBeUndefined();
    expect(body.outcomes).toBeUndefined();
  });

  it("the same app cannot read a session in a space it was not given (404)", async () => {
    const id = await seedSession(WS_OTHER);
    const res = await get(id, APP_GRANT);
    expect(res.status).toBe(404);
  });

  it("CONTROL: the person (no key grant) still gets the whole packet", async () => {
    const id = await seedSession(WS_OTHER);
    const res = await get(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.packet).toBeUndefined();
    expect(body.continuation).toMatchObject({ sentinel: "packet" });
  });
});
