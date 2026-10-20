/**
 * POST /messaging/conversations/{threadId}/send — the sender must own the
 * account it sends AS, and an agent's send is the agent's.
 *
 *  - `accountId` (the provider account, `messaging_accounts.external_id`) went
 *    straight to the connector: any write key could send as ANOTHER user's
 *    LinkedIn / WhatsApp / mail account by naming its id. The sibling read
 *    `GET .../messages` already floors on `(userId, externalId)`; the send now
 *    does too, for every connector that sends as an account
 *    (`requiresAccount()`). Discord / Proton ignore `accountId` (they enqueue
 *    to their bridge), so no account row is demanded there.
 *  - the linked EXTERNAL channel must be visible to the caller (the same
 *    channel floor as every channel write door) — otherwise an
 *    account-less connector would still send into any thread by id. NB a
 *    NULL-workspace external channel is pod-wide-shared BY DESIGN (branch 4
 *    of the floor), so this bounds workspace-mirrored threads only.
 *  - the door dropped `agentUserId`, so an agent key's send skipped the
 *    dispatcher's messaging gate (`gateMessagingSend` runs only for an agent)
 *    and went out as an owner send. It is now attributed, and a `proposed`
 *    outcome answers 202, not a misleading 503.
 *
 * Through the REAL route on PGlite; the connector and the dispatcher are
 * spies, so a refused send provably never reached either.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  requiresAccount: true,
  dispatched: [] as Array<Record<string, unknown>>,
  outcome: { success: true } as Record<string, unknown>,
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
vi.mock("../../../connectors/index.js", () => ({
  getMessagingConnector: async () => ({
    requiresAccount: () => h.requiresAccount,
  }),
}));
vi.mock("../../../connectors/external-dispatch.js", () => ({
  sendExternalMessage: async (input: Record<string, unknown>) => {
    h.dispatched.push(input);
    return h.outcome;
  },
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { registerMessagingRoutes } from "./messaging.js";
import type { HubHono, HubVariables } from "./_shared.js";

const ALICE = "alice-ms";
const MALLORY = "mallory-ms";
const ALICE_ACCOUNT = "unipile-acc-alice";
const ALICE_THREAD = "thread-alice";
const UNLINKED_THREAD = "thread-unlinked";
const ALICE_WS = randomUUID();

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

function send(
  userId: string,
  body: { accountId: string; body: string },
  opts: { thread?: string; agentUserId?: string } = {}
) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (opts.agentUserId) c.set("agentUserId", opts.agentUserId);
    await next();
  });
  registerMessagingRoutes(app);
  return app.request(
    `/messaging/conversations/${opts.thread ?? ALICE_THREAD}/send`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const u of [ALICE, MALLORY])
    await q(
      `insert into users (id, email, user_type) values ($1, $2, 'human')`,
      [u, `${u}@x`]
    );
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id) values ($1, $2, 'linkedin', $3)`,
    [randomUUID(), ALICE, ALICE_ACCOUNT]
  );
  // Mirrored into Alice's workspace: a SHARED-type channel is visible to that
  // workspace's members (and a NULL-workspace one to the whole pod, by design
  // — channel-visibility branch 4), never to a non-member.
  await q(
    `insert into workspaces (id, owner_id, name, settings) values ($1, $2, 'A', '{}'::jsonb)`,
    [ALICE_WS, ALICE]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), ALICE_WS, ALICE]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, status, external_id, external_source) values ($1, $2, $3, 'external', 'active', $4, 'linkedin')`,
    [randomUUID(), ALICE, ALICE_WS, ALICE_THREAD]
  );
});

beforeEach(() => {
  h.requiresAccount = true;
  h.dispatched.length = 0;
  h.outcome = { success: true };
});

describe("messaging send — the account and the channel are the caller's", () => {
  it("another user cannot send AS Alice's account (404, nothing sent)", async () => {
    const res = await send(
      MALLORY,
      { accountId: ALICE_ACCOUNT, body: "hi" },
      { thread: UNLINKED_THREAD }
    );
    expect(res.status).toBe(404);
    expect(h.dispatched).toEqual([]);
  });

  it("an account-less connector still cannot send into Alice's thread (404)", async () => {
    h.requiresAccount = false;
    const res = await send(MALLORY, { accountId: "", body: "hi" });
    expect(res.status).toBe(404);
    expect(h.dispatched).toEqual([]);
  });

  it("an agent key's send is attributed to the agent; `proposed` → 202", async () => {
    h.outcome = { success: false, proposed: true, proposalId: randomUUID() };
    const res = await send(
      ALICE,
      { accountId: ALICE_ACCOUNT, body: "hi" },
      { agentUserId: "agent-ms" }
    );
    expect(res.status).toBe(202);
    expect(h.dispatched[0]).toMatchObject({
      userId: ALICE,
      agentUserId: "agent-ms",
    });
  });

  it("CONTROL — Alice sends as her own account in her thread", async () => {
    const res = await send(ALICE, { accountId: ALICE_ACCOUNT, body: "hi" });
    expect(res.status).toBe(200);
    expect(h.dispatched[0]).toMatchObject({
      userId: ALICE,
      accountId: ALICE_ACCOUNT,
    });
  });

  it("CONTROL — an account-less connector needs no account row", async () => {
    h.requiresAccount = false;
    const res = await send(ALICE, { accountId: "", body: "hi" });
    expect(res.status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
  });
});
