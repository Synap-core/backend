/**
 * The messaging writes that wrote without the governance gate (finding
 * 6a6bcb5f): account sync, account disconnect, channel unlink, mark-read.
 *
 * Driven through the REAL routes (key auth simulated as the hub auth door does
 * it: `runWithGrant` + `runWithActingAgent`), the REAL
 * `checkPermissionOrPropose`, the REAL channel read floor and the REAL approve
 * executors, on PGlite with every @synap/database table. Only the messaging
 * provider is a fake (its `deleteAccount` call IS the provider disconnect).
 *
 * Rows, each ruling out a wrong outcome:
 *  - sync claims no account another member holds (the provider lists every
 *    account of the pod's key), and still claims an unheld one;
 *  - mark-read on a channel the caller cannot see → 404, flag untouched
 *    (rules out "any key flips any channel by id"); on its own → cleared;
 *  - unlinking a channel the caller cannot see → 404, channel kept;
 *  - an agent's unlink → 202 proposed, channel kept; approving as someone who
 *    cannot see it deletes nothing; as the owner deletes it once;
 *  - a person's unlink → deleted directly, no proposal;
 *  - an agent's disconnect → 202 proposed, account still connected, provider
 *    untouched; approving as a non-owner disconnects nothing; as the owner
 *    disconnects it once; a person disconnects directly.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    live: [] as Array<{
      id: string;
      externalId: string;
      provider: string;
      displayName: string;
      status: "connected";
    }>,
    providerDeletes: [] as string[],
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        // PGlite is ONE connection: run a transaction body on the same handle.
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  const db = await h.init();
  return { ...actual, db, getDb: async () => db, eventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => randomUUID() }),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
// The provider: lists `h.live` (every account of the pod's key, whoever
// connected it, as Unipile does) and records each provider-side delete.
vi.mock("../../../connectors/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMessagingConnector: async () => ({
    requiresAccount: () => true,
    getAccounts: async () => h.live,
    deleteAccount: async (externalId: string) => {
      h.providerDeletes.push(externalId);
    },
    ensureWebhooksRegistered: async () => undefined,
  }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import {
  grantOfScope,
  runWithActingAgent,
  runWithGrant,
  type KeyGrant,
} from "@synap/database";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import {
  proposalExecRegistry,
  type ProposalExecutorArgs,
} from "../../proposals/execution-registry.js";
import { registerMessagingExecutors } from "../../proposals/executors/messaging.js";
import { registerMessagingRoutes } from "./messaging.js";
import type { HubHono, HubVariables } from "./_shared.js";

const OWNER = randomUUID();
const OTHER = randomUUID();
const AGENT = randomUUID();
const ACC_OWNER = randomUUID();
const ACC_OWNER_2 = randomUUID();
const ACC_OTHER = randomUUID();
const CH_OWNER = randomUUID();
const CH_OWNER_2 = randomUUID();
const CH_OTHER = randomUUID();

/** The AI preset every new agent starts with. */
const AI_PRESET: KeyGrant = grantOfScope({
  permissions: [
    ...GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!.grant
      .permissions,
  ],
});

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** One call, as the hub auth door runs it for a key (or a session). */
function call(
  method: string,
  path: string,
  opts: { asUser?: string; grant?: KeyGrant; agentUserId?: string } = {}
) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", opts.asUser ?? OWNER);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (opts.agentUserId) c.set("agentUserId", opts.agentUserId);
    await runWithActingAgent(opts.agentUserId, () =>
      opts.grant ? runWithGrant(opts.grant, () => next()) : next()
    );
  });
  registerMessagingRoutes(app);
  return app.request(path, { method });
}

async function proposalsFor(targetType: string, proposalType: string) {
  const { rows } = await q<Record<string, unknown>>(
    `select id, status, agent_user_id, target_type, target_id, proposal_type, workspace_id, data from proposals where target_type = $1 and proposal_type = $2 order by created_at`,
    [targetType, proposalType]
  );
  return rows;
}

function approve(key: string, row: Record<string, unknown>, asUser: string) {
  const ex = proposalExecRegistry.resolveExact(key)!;
  return ex.execute({
    proposal: {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      proposalType: row.proposal_type,
      workspaceId: row.workspace_id ?? null,
      agentUserId: row.agent_user_id,
      sessionId: null,
      projectId: null,
      sourceMessageId: null,
      data: row.data,
    },
    payload: row.data,
    userId: asUser,
    input: { proposalId: row.id },
    ctx: {},
    deps: {
      reportProposalOutcome: () => {},
      emitProposalReviewed: () => {},
    },
  } as unknown as ProposalExecutorArgs);
}

const channelExists = async (id: string) =>
  (await q(`select id from channels where id = $1`, [id])).rows.length === 1;
const unreadOf = async (id: string) =>
  (
    await q<{ unread: string | null }>(
      `select metadata ->> 'unread' as unread from channels where id = $1`,
      [id]
    )
  ).rows[0]?.unread;
const accountStatus = async (id: string) =>
  (
    await q<{ status: string }>(
      `select status from messaging_accounts where id = $1`,
      [id]
    )
  ).rows[0]?.status;

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  // The DDL helper creates no indexes: the account upsert needs its unique
  // (user, provider, external id) index to resolve ON CONFLICT.
  await h.client!.exec(
    `create unique index idx_messaging_accounts_user_provider_external on messaging_accounts (user_id, provider, external_id)`
  );
  await q(
    `insert into users (id, email, user_type) values ($1, $2, 'human'), ($3, $4, 'human')`,
    [OWNER, "owner-wg@x.test", OTHER, "other-wg@x.test"]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, 'agent', $3)`,
    [AGENT, "agent-wg@x.test", OWNER]
  );
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id, display_name) values
       ($1, $2, 'linkedin', 'acc-owner', 'Owner LinkedIn'),
       ($3, $2, 'whatsapp', 'acc-owner-2', 'Owner WhatsApp'),
       ($4, $5, 'linkedin', 'acc-other', 'Other LinkedIn')`,
    [ACC_OWNER, OWNER, ACC_OWNER_2, ACC_OTHER, OTHER]
  );
  // Three conversations linked to a record: two of the owner's, one of the
  // other member's (its person is not one the owner can read).
  for (const [id, userId, ext] of [
    [CH_OWNER, OWNER, "chat-owner"],
    [CH_OWNER_2, OWNER, "chat-owner-2"],
    [CH_OTHER, OTHER, "chat-other"],
  ] as const) {
    await q(
      `insert into channels (id, user_id, channel_type, external_source, external_id, context_object_type, context_object_id, metadata)
       values ($1, $2, 'external', 'linkedin', $3, 'entity', $4, '{"unread": true}'::jsonb)`,
      [id, userId, ext, randomUUID()]
    );
  }
  proposalExecRegistry._reset();
  registerMessagingExecutors();
}, 120_000);

beforeEach(() => {
  h.providerDeletes.length = 0;
});

describe("POST /messaging/accounts/sync claims no other member's account", () => {
  it("keeps an account another member holds theirs, and claims an unheld one", async () => {
    h.live = [
      ["acc-other", "Other LinkedIn"],
      ["acc-owner", "Owner LinkedIn"],
      ["acc-new", "New account"],
    ].map(([externalId, displayName]) => ({
      id: externalId!,
      externalId: externalId!,
      provider: "linkedin",
      displayName: displayName!,
      status: "connected" as const,
    }));
    const res = await call("POST", "/messaging/accounts/sync");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ synced: 2 });
    const { rows } = await q<{ user_id: string; external_id: string }>(
      `select user_id, external_id from messaging_accounts where external_id in ('acc-other', 'acc-new') order by external_id`
    );
    expect(rows).toEqual([
      { user_id: OWNER, external_id: "acc-new" },
      { user_id: OTHER, external_id: "acc-other" },
    ]);
  });
});

describe("POST /messaging/channels/{id}/mark-read reads the channel floor", () => {
  it("another member's channel: 404, its unread flag untouched", async () => {
    const res = await call("POST", `/messaging/channels/${CH_OTHER}/mark-read`);
    expect(res.status).toBe(404);
    expect(await unreadOf(CH_OTHER)).toBe("true");
  });
  it("the caller's own channel: cleared", async () => {
    const res = await call("POST", `/messaging/channels/${CH_OWNER}/mark-read`);
    expect(res.status).toBe(200);
    expect(await unreadOf(CH_OWNER)).toBe("false");
  });
});

describe("DELETE /messaging/channels/{id} — floored, and an agent's unlink is a proposal", () => {
  it("another member's channel: 404, kept", async () => {
    const res = await call("DELETE", `/messaging/channels/${CH_OTHER}`);
    expect(res.status).toBe(404);
    expect(await channelExists(CH_OTHER)).toBe(true);
  });

  it("an agent on the AI preset: 202 proposed, the channel kept", async () => {
    const res = await call("DELETE", `/messaging/channels/${CH_OWNER}`, {
      grant: AI_PRESET,
      agentUserId: AGENT,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "proposed",
      proposalId: expect.any(String),
      reviewUrl: expect.stringContaining(String(body.proposalId)),
    });
    const rows = await proposalsFor("channel", "delete_external");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.proposalId,
      status: "pending",
      agent_user_id: AGENT,
      target_id: CH_OWNER,
    });
    expect(await channelExists(CH_OWNER)).toBe(true);
  });

  it("approving as someone who cannot see it: refused, kept", async () => {
    const [row] = await proposalsFor("channel", "delete_external");
    await expect(
      approve("channel/delete_external", row!, OTHER)
    ).rejects.toThrow(/not one you can see/);
    expect(await channelExists(CH_OWNER)).toBe(true);
  });

  it("approving as the owner: deleted once; a second approval does nothing", async () => {
    const [row] = await proposalsFor("channel", "delete_external");
    await approve("channel/delete_external", row!, OWNER);
    expect(await channelExists(CH_OWNER)).toBe(false);
    const [after] = await proposalsFor("channel", "delete_external");
    expect(after!.status).toBe("approved");
    expect(
      await approve("channel/delete_external", after!, OWNER)
    ).toMatchObject({ alreadyApproved: true });
  });

  it("a signed-in person: deleted directly, no proposal", async () => {
    const before = (await proposalsFor("channel", "delete_external")).length;
    const res = await call("DELETE", `/messaging/channels/${CH_OWNER_2}`);
    expect(res.status).toBe(200);
    expect(await channelExists(CH_OWNER_2)).toBe(false);
    expect((await proposalsFor("channel", "delete_external")).length).toBe(
      before
    );
  });
});

describe("DELETE /messaging/accounts/{id} — an agent's disconnect is a proposal", () => {
  it("an agent: 202 proposed, still connected, the provider untouched", async () => {
    const res = await call("DELETE", `/messaging/accounts/${ACC_OWNER}`, {
      agentUserId: AGENT,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "proposed" });
    const rows = await proposalsFor("messaging", "delete_account");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.proposalId,
      status: "pending",
      agent_user_id: AGENT,
      target_id: ACC_OWNER,
    });
    expect(await accountStatus(ACC_OWNER)).toBe("connected");
    expect(h.providerDeletes).toEqual([]);
  });

  it("approving as someone who does not own it: refused, nothing disconnected", async () => {
    const [row] = await proposalsFor("messaging", "delete_account");
    await expect(
      approve("messaging/delete_account", row!, OTHER)
    ).rejects.toThrow(/not yours/);
    expect(await accountStatus(ACC_OWNER)).toBe("connected");
    expect(h.providerDeletes).toEqual([]);
  });

  it("approving as the owner: disconnected at the provider once", async () => {
    const [row] = await proposalsFor("messaging", "delete_account");
    await approve("messaging/delete_account", row!, OWNER);
    expect(await accountStatus(ACC_OWNER)).toBe("disconnected");
    expect(h.providerDeletes).toEqual(["acc-owner"]);
    const [after] = await proposalsFor("messaging", "delete_account");
    expect(after!.status).toBe("approved");
    expect(
      await approve("messaging/delete_account", after!, OWNER)
    ).toMatchObject({ alreadyApproved: true });
    expect(h.providerDeletes).toEqual(["acc-owner"]);
  });

  it("a signed-in person: disconnected directly, no proposal", async () => {
    const before = (await proposalsFor("messaging", "delete_account")).length;
    const res = await call("DELETE", `/messaging/accounts/${ACC_OWNER_2}`);
    expect(res.status).toBe(200);
    expect(await accountStatus(ACC_OWNER_2)).toBe("disconnected");
    expect(h.providerDeletes).toEqual(["acc-owner-2"]);
    expect((await proposalsFor("messaging", "delete_account")).length).toBe(
      before
    );
  });
});
