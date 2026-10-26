/**
 * POST /messaging/conversations/{threadId}/send — a key's GRANT bounds a send
 * through the person's connected account (task d890410b).
 *
 * A pod app holds `hub-protocol.write` once it is granted ANY write, in one
 * space. The send door checked the account and the channel floor but never the
 * key's grant: an app granted `entity.deal.create` in one space could send
 * through the person's LinkedIn / mail account. An agent-acting key reached the
 * capability gate, which PROPOSED the send (a reviewer could then widen the
 * key); a person-acting narrowed key (an official app, a scoped personal key)
 * dispatched straight away.
 *
 * The send is now `messaging.send` in the space of the conversation's channel,
 * checked in the ONE send door (`sendExternalMessage`) before the agent gate:
 * refused, never proposed. Rows rule out: a check only on agent keys (the
 * person-acting row), a check that reads any write as enough (the bare
 * `messaging` row: a gate verb must be named), a check on the caller's space
 * instead of the channel's (the other-space row), and a check that refuses a
 * key that holds it or a signed-in person (the CONTROL rows).
 *
 * Through the REAL route and the REAL dispatcher on PGlite; the connector, the
 * capability gate and the proposal insert are spies, so a refused send
 * provably never reached the connector or the gate.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  sent: [] as unknown[][],
  gated: [] as Array<Record<string, unknown>>,
  proposals: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    // The `message.sent` fact after a mirrored send — not under test.
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("../../../connectors/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMessagingConnector: async () => ({
    requiresAccount: () => true,
    sendMessage: async (...args: unknown[]) => {
      h.sent.push(args);
    },
  }),
}));
vi.mock(
  "../../../services/capabilities/gate-capability-execution.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    // The ask-first app agent: every send it may make is proposed.
    gateCapabilityExecution: async (input: Record<string, unknown>) => {
      h.gated.push(input);
      return { decision: "propose" };
    },
  })
);
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: Record<string, unknown>) => {
    h.proposals.push(input);
    return { id: randomUUID() };
  },
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  runWithActingAgent,
  runWithGrant,
  type KeyGrant,
} from "@synap/database";
import * as schema from "@synap/database/schema";
import { registerMessagingRoutes } from "./messaging.js";
import type { HubHono, HubVariables } from "./_shared.js";

const ALICE = "alice-sg";
const APP_AGENT = "app-agent-sg";
const ACCOUNT = "unipile-acc-alice-sg";
const THREAD = "thread-alice-sg";
const ALICE_WS = randomUUID();
const OTHER_WS = randomUUID();

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

/**
 * A key's grant: one scope, pinned to `workspaceIds` (an app's always is). It
 * always reads conversations (`channel.read`): the channel floor hides a
 * conversation from a key that cannot, so the send check below it is reached
 * only by a key that sees the conversation (the last row pins that floor).
 */
const grant = (permissions: string[], workspaceIds = [ALICE_WS]): KeyGrant => ({
  scopes: [{ permissions: ["channel.read", ...permissions], workspaceIds }],
  clientId: "crm-site",
});

function send(opts: { grant?: KeyGrant; agentUserId?: string } = {}) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  // What the hub auth door does for a key: the linked human owns the request,
  // the agent acts in it, and the key's grant bounds it (auth.ts).
  app.use("*", async (c, next) => {
    c.set("userId", ALICE);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (opts.agentUserId) c.set("agentUserId", opts.agentUserId);
    await runWithActingAgent(opts.agentUserId, () =>
      opts.grant ? runWithGrant(opts.grant, () => next()) : next()
    );
  });
  registerMessagingRoutes(app);
  return app.request(`/messaging/conversations/${THREAD}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: ACCOUNT, body: "hello" }),
  });
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, user_type) values ($1, $2, 'human'), ($3, $4, 'agent')`,
    [ALICE, `${ALICE}@x`, APP_AGENT, `${APP_AGENT}@x`]
  );
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id) values ($1, $2, 'linkedin', $3)`,
    [randomUUID(), ALICE, ACCOUNT]
  );
  for (const ws of [ALICE_WS, OTHER_WS]) {
    await q(
      `insert into workspaces (id, owner_id, name, settings) values ($1, $2, $3, '{}'::jsonb)`,
      [ws, ALICE, ws]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), ws, ALICE]
    );
  }
  // The conversation is mirrored into Alice's CRM space.
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, status, external_id, external_source) values ($1, $2, $3, 'external', 'active', $4, 'linkedin')`,
    [randomUUID(), ALICE, ALICE_WS, THREAD]
  );
});

beforeEach(() => {
  h.sent.length = 0;
  h.gated.length = 0;
  h.proposals.length = 0;
});

describe("a key's grant bounds a send through the person's account", () => {
  it("an app agent granted only `entity.deal.create` is REFUSED: nothing sent, nothing proposed", async () => {
    const res = await send({
      grant: grant(["entity.deal.create"]),
      agentUserId: APP_AGENT,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/messaging\.send/);
    expect(h.sent).toEqual([]);
    expect(h.gated).toEqual([]); // refused before the agent gate
    expect(h.proposals).toEqual([]);
  });

  it("a person-acting narrowed key (no agent) is refused too — that branch has no gate", async () => {
    const res = await send({ grant: grant(["entity.deal.create"]) });
    expect(res.status).toBe(403);
    expect(h.sent).toEqual([]);
  });

  it("a bare `messaging` grant does not cover sending: the verb must be named", async () => {
    const res = await send({ grant: grant(["messaging"]) });
    expect(res.status).toBe(403);
    expect(h.sent).toEqual([]);
  });

  it("`messaging.send` in ANOTHER space does not cover this conversation's space", async () => {
    const res = await send({
      grant: grant(["messaging.send"], [OTHER_WS]),
      agentUserId: APP_AGENT,
    });
    expect(res.status).toBe(403);
    expect(h.sent).toEqual([]);
    expect(h.proposals).toEqual([]);
  });

  it("an app agent holding `messaging.send` here reaches the gate: proposed in the channel's space, not sent", async () => {
    const res = await send({
      grant: grant(["messaging.send"]),
      agentUserId: APP_AGENT,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "proposed" });
    expect(h.sent).toEqual([]);
    expect(h.gated).toHaveLength(1);
    expect(h.gated[0]).toMatchObject({
      agentUserId: APP_AGENT,
      workspaceId: ALICE_WS,
    });
    expect(h.proposals).toHaveLength(1);
    expect(h.proposals[0]).toMatchObject({
      userId: ALICE,
      workspaceId: ALICE_WS,
      proposalType: "messaging.external.send",
    });
  });

  it("CONTROL — a person-acting key holding `messaging.send` here sends", async () => {
    const res = await send({ grant: grant(["messaging.send"]) });
    expect(res.status).toBe(200);
    expect(h.sent).toEqual([[ACCOUNT, THREAD, "hello"]]);
  });

  it("a key that cannot read the conversation does not find it: 404, nothing sent", async () => {
    const res = await send({
      grant: {
        scopes: [{ permissions: ["messaging.send"], workspaceIds: [ALICE_WS] }],
        clientId: "crm-site",
      },
      agentUserId: APP_AGENT,
    });
    expect(res.status).toBe(404);
    expect(h.sent).toEqual([]);
    expect(h.proposals).toEqual([]);
  });

  it("CONTROL — the person signed in (no grant) sends, as before", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(h.sent).toEqual([[ACCOUNT, THREAD, "hello"]]);
    expect(h.gated).toEqual([]);
  });
});
