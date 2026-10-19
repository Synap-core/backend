/**
 * Ungated owner doors (lane/sec-webhooks sweep, hole family 6):
 *
 *  - POST /projects/:id/purge — its "ownership" check was the READ-visibility
 *    predicate, so any member of a project's workspace (a viewer included)
 *    hard-purged it with the pod-wide entities filed into it. It now needs
 *    the project's creator or a workspace owner/admin — the same rule as
 *    POST /workspaces/:id/purge and its own "you do not own" message.
 *  - POST /workspaces/enroll-agent — enrolled ANY agent of the pod, at a role
 *    above the caller's own (a viewer enrolled an agent as admin), and let an
 *    agent key enroll ITSELF. Now: the agent must be the caller's
 *    (`agentBelongsTo`), never the acting agent itself, and the role may not
 *    exceed the caller's role in that workspace (a workspace above it is
 *    skipped, as a non-member one already was).
 *  - POST /workspaces/provision-agent — idempotent on the agent, so naming
 *    SOMEONE ELSE's agent made the caller admin of that agent's existing
 *    space. Now the agent must be the caller's.
 *
 * Every legitimate caller found is `synap` CLI connect / purge: the human's
 * own freshly provisioned agent, the human's own project/space — the CONTROL
 * rows. Through the REAL routes on PGlite.
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
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: () => Promise.resolve(),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { registerProjectsRoutes } from "./projects.js";
import { registerWorkspacesRoutes } from "./workspaces.js";
import type { HubHono, HubVariables } from "./_shared.js";

const OWNER = "owner-td";
const VIEWER = "viewer-td";
const EDITOR = "editor-td";
const OWNER_AGENT = randomUUID();
const VIEWER_AGENT = randomUUID();
const WS = randomUUID();

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

function call(
  path: string,
  body: unknown,
  who: { userId: string; agentUserId?: string }
) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", who.userId);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (who.agentUserId) c.set("agentUserId", who.agentUserId);
    await next();
  });
  registerProjectsRoutes(app);
  registerWorkspacesRoutes(app);
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedProject(owner: string) {
  const id = randomUUID();
  const name = `p-${id.slice(0, 6)}`;
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, $3, $4, 'active')`,
    [id, owner, WS, name]
  );
  return { id, name };
}
const projectExists = async (id: string) =>
  (
    (await q(`select count(*)::int n from projects where id = $1`, [id]))
      .rows[0] as { n: number }
  ).n === 1;
const roleOf = async (userId: string) =>
  (
    (
      await q(
        `select role from workspace_members where workspace_id = $1 and user_id = $2`,
        [WS, userId]
      )
    ).rows[0] as { role: string } | undefined
  )?.role;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const u of [OWNER, VIEWER, EDITOR])
    await q(
      `insert into users (id, email, user_type) values ($1, $2, 'human')`,
      [u, `${u}@x`]
    );
  for (const [agent, creator] of [
    [OWNER_AGENT, OWNER],
    [VIEWER_AGENT, VIEWER],
  ])
    await q(
      `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, 'agent', $3)`,
      [agent, `${agent}@agent`, creator]
    );
  await q(
    `insert into workspaces (id, owner_id, name, settings) values ($1, $2, 'W', '{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $4, $5, 'owner'), ($2, $4, $6, 'viewer'), ($3, $4, $7, 'editor')`,
    [randomUUID(), randomUUID(), randomUUID(), WS, OWNER, VIEWER, EDITOR]
  );
});

describe("POST /projects/:id/purge — creator or workspace owner/admin", () => {
  it("a workspace VIEWER cannot purge another member's project (403, kept)", async () => {
    const p = await seedProject(OWNER);
    const res = await call(
      `/projects/${p.id}/purge`,
      { confirm: p.name },
      {
        userId: VIEWER,
      }
    );
    expect(res.status).toBe(403);
    expect(await projectExists(p.id)).toBe(true);
  });

  it("an EDITOR who did not create it cannot purge it either (403, kept)", async () => {
    const p = await seedProject(OWNER);
    const res = await call(
      `/projects/${p.id}/purge`,
      { confirm: p.name },
      {
        userId: EDITOR,
      }
    );
    expect(res.status).toBe(403);
    expect(await projectExists(p.id)).toBe(true);
  });

  it("CONTROL — the creator purges their own project", async () => {
    const p = await seedProject(EDITOR);
    const res = await call(
      `/projects/${p.id}/purge`,
      { confirm: p.name },
      {
        userId: EDITOR,
      }
    );
    expect(res.status).toBe(200);
    expect(await projectExists(p.id)).toBe(false);
  });

  it("CONTROL — the workspace owner purges a member's project", async () => {
    const p = await seedProject(EDITOR);
    const res = await call(
      `/projects/${p.id}/purge`,
      { confirm: p.name },
      {
        userId: OWNER,
      }
    );
    expect(res.status).toBe(200);
    expect(await projectExists(p.id)).toBe(false);
  });
});

describe("POST /workspaces/enroll-agent — your own agent, at most your role", () => {
  it("a member cannot enroll SOMEONE ELSE's agent (403, not a member)", async () => {
    const res = await call(
      "/workspaces/enroll-agent",
      { agentUserId: OWNER_AGENT, workspaceId: WS, role: "admin" },
      { userId: EDITOR }
    );
    expect(res.status).toBe(403);
    expect(await roleOf(OWNER_AGENT)).toBeUndefined();
  });

  it("a VIEWER cannot enroll their own agent above viewer (skipped)", async () => {
    const res = await call(
      "/workspaces/enroll-agent",
      { agentUserId: VIEWER_AGENT, workspaceId: WS, role: "admin" },
      { userId: VIEWER }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enrolled: [], skipped: [WS] });
    expect(await roleOf(VIEWER_AGENT)).toBeUndefined();
  });

  it("an agent key cannot enroll ITSELF (403)", async () => {
    const res = await call(
      "/workspaces/enroll-agent",
      { agentUserId: OWNER_AGENT, workspaceId: WS, role: "admin" },
      { userId: OWNER, agentUserId: OWNER_AGENT }
    );
    expect(res.status).toBe(403);
    expect(await roleOf(OWNER_AGENT)).toBeUndefined();
  });

  it("CONTROL — the owner enrolls their own agent (the CLI connect flow)", async () => {
    const res = await call(
      "/workspaces/enroll-agent",
      { agentUserId: OWNER_AGENT },
      { userId: OWNER }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enrolled: [WS] });
    expect(await roleOf(OWNER_AGENT)).toBe("editor");
  });
});

describe("POST /workspaces/provision-agent — your own agent only", () => {
  it("naming someone else's agent is refused before anything is written (403)", async () => {
    const res = await call(
      "/workspaces/provision-agent",
      { agentUserId: OWNER_AGENT },
      { userId: EDITOR }
    );
    expect(res.status).toBe(403);
    const { rows } = await q(
      `select count(*)::int n from workspace_members where user_id = $1 and role = 'admin'`,
      [EDITOR]
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("CONTROL — the owner naming their own agent gets past the door", async () => {
    const res = await call(
      "/workspaces/provision-agent",
      { agentUserId: OWNER_AGENT },
      { userId: OWNER }
    );
    // The template apply behind it may not run on PGlite; what is asserted is
    // that the ownership door did not refuse the agent's own human.
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    expect(body.error ?? "").not.toMatch(/not yours|belong/i);
  });
});
