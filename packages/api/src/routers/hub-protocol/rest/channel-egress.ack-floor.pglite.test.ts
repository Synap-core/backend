/**
 * POST /channel-egress/:id/ack — a consumer may ack only a row it could PULL.
 *
 * The outbox has no owner column: its consumer is whoever drains
 * `GET /channel-egress/pending` (the Discord / Proton bridges). The ack used to
 * update ANY row by id — delivered, dead-lettered or outside the caller's
 * workspace — so any write key could silently drop (mark delivered) or burn the
 * retries of another workspace's outbound message. The ack now applies the
 * SAME predicate as the pending list (servable status + service-key
 * confinement) and refuses a key the fence would not let list at all.
 *
 * Through the REAL routes on PGlite. Rows rule out: an ack that still matches
 * by id alone (the bound-key and delivered-row rows), a predicate that refuses
 * the real consumer (the CONTROL rows), and a 200 for an ack that changed
 * nothing (the 404 rows).
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

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { runWithGrant } from "@synap/database";
import { registerChannelEgressRoutes } from "./channel-egress.js";
import type { HubHono, HubVariables } from "./_shared.js";

const WS_A = randomUUID();
const WS_B = randomUUID();

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

async function seed(opts: {
  workspaceId: string | null;
  status?: string;
  attempts?: number;
}) {
  const id = randomUUID();
  await q(
    `insert into channel_egress (id, external_source, external_id, kind, payload, status, attempts, workspace_id, created_at) values ($1, 'discord', 'x', 'send_message', '{}'::jsonb, $2, $3, $4, now())`,
    [id, opts.status ?? "pending", opts.attempts ?? 0, opts.workspaceId]
  );
  return id;
}
async function row(id: string) {
  const { rows } = await q(
    `select status, attempts from channel_egress where id = $1`,
    [id]
  );
  return rows[0] as { status: string; attempts: number };
}

type Key = {
  keyType?: string;
  keyWorkspaceId?: string | null;
  grant?: unknown;
};

function ack(
  id: string,
  key: Key = {},
  body: unknown = { status: "delivered" }
) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", "bridge-owner");
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (key.keyType) c.set("keyType", key.keyType as never);
    if (key.keyWorkspaceId !== undefined)
      c.set("keyWorkspaceId", key.keyWorkspaceId as never);
    await next();
  });
  registerChannelEgressRoutes(app);
  const send = () =>
    app.request(`/channel-egress/${id}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return key.grant ? runWithGrant(key.grant as never, () => send()) : send();
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
});

describe("POST /channel-egress/:id/ack — only a row the caller could pull", () => {
  it("a key bound to workspace A cannot ack workspace B's row (404, untouched)", async () => {
    const b = await seed({ workspaceId: WS_B });
    const res = await ack(b, { keyType: "service", keyWorkspaceId: WS_A });
    expect(res.status).toBe(404);
    expect(await row(b)).toEqual({ status: "pending", attempts: 0 });
  });

  it("a delivered row cannot be re-acked failed (404, retries not burned)", async () => {
    const done = await seed({ workspaceId: null, status: "delivered" });
    const res = await ack(done, {}, { status: "failed", error: "x" });
    expect(res.status).toBe(404);
    expect(await row(done)).toEqual({ status: "delivered", attempts: 0 });
  });

  it("a dead-lettered row is not served, so it cannot be acked (404)", async () => {
    const dead = await seed({
      workspaceId: null,
      status: "failed",
      attempts: 5,
    });
    const res = await ack(dead);
    expect(res.status).toBe(404);
    expect(await row(dead)).toEqual({ status: "failed", attempts: 5 });
  });

  it("an unknown id is 404, not a silent ok", async () => {
    const res = await ack(randomUUID());
    expect(res.status).toBe(404);
  });

  it("a fenced (scoped) key — refused by the pending list — cannot ack", async () => {
    const p = await seed({ workspaceId: null });
    const res = await ack(p, {
      grant: { scopes: [{ permissions: ["entity.read"] }], clientId: null },
    });
    expect(res.status).toBe(403);
    expect(await row(p)).toEqual({ status: "pending", attempts: 0 });
  });

  it("CONTROL — the bound key acks its own workspace's row and a pod-wide row", async () => {
    const a = await seed({ workspaceId: WS_A });
    const pod = await seed({ workspaceId: null });
    const key = { keyType: "service", keyWorkspaceId: WS_A };
    expect((await ack(a, key)).status).toBe(200);
    expect((await ack(pod, key)).status).toBe(200);
    expect((await row(a)).status).toBe("delivered");
    expect((await row(pod)).status).toBe("delivered");
  });

  it("CONTROL — an unbound bridge key acks a retriable failure (attempts +1)", async () => {
    const f = await seed({ workspaceId: WS_B, status: "failed", attempts: 2 });
    const res = await ack(f, {}, { status: "failed", error: "5xx" });
    expect(res.status).toBe(200);
    expect(await row(f)).toEqual({ status: "failed", attempts: 3 });
  });
});
