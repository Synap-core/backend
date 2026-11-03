/**
 * POST /messaging/accounts/{id}/import-history — an agent's ask becomes a
 * PROPOSAL the person approves, never a 403 (founder, 2026-11-03: "normally,
 * like we do all, it should still be possible, but it creates a proposal").
 *
 * Before: the route was an owner-wide door (the key fence refused every key
 * narrower than an unbounded `*` with GRANT_DOOR_UNSUPPORTED), and its handler
 * refused every agent outright, so an agent had to hand the person a curl line
 * to run with a full-access key.
 *
 * Driven through the REAL route (key auth simulated as the hub auth door does
 * it: `runWithGrant` + `runWithActingAgent`), the REAL
 * `checkPermissionOrPropose` and the REAL `messaging/import_history` approve
 * executor, on PGlite with every @synap/database table. Only the queue is a
 * spy: a call there IS the import running.
 *
 * Rows, each ruling out a wrong outcome:
 *  - an agent whose key's grant does not name the door → 202 proposed, ONE
 *    pending `messaging/import_history` proposal on the account, nothing
 *    queued (rules out the old 403 and "the agent ran it");
 *  - an agent on the AI preset → proposed too (a disruptive door asks first);
 *  - a signed-in person → queued directly, no proposal (the person path);
 *  - a narrowed key that is not an agent's → 403, nothing queued or filed
 *    (rules out a narrow key running an import no grant bounds);
 *  - approving as the account's owner queues it exactly once, a second
 *    approval queues nothing; approving as someone else queues nothing;
 *  - the fence classes the route a gated write, not an owner-wide door.
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
    queued: [] as Array<{ queue: string; data: unknown }>,
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
  getBoss: () => ({
    send: async (queue: string, data: unknown) => {
      h.queued.push({ queue, data });
      return randomUUID();
    },
  }),
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
import { MESSAGING_HISTORY_IMPORT_QUEUE } from "@synap/jobs/workers/messaging-sync.js";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import {
  proposalExecRegistry,
  type ProposalExecutorArgs,
} from "../../proposals/execution-registry.js";
import { registerMessagingExecutors } from "../../proposals/executors/messaging.js";
import {
  hubRouteClass,
  ownerWideDoorAllowed,
} from "../../../access/grant-door-fence.js";
import { registerMessagingRoutes } from "./messaging.js";
import type { HubHono, HubVariables } from "./_shared.js";

const OWNER = randomUUID();
const OTHER = randomUUID();
const AGENT = randomUUID();
const ACCOUNT_ROW = randomUUID();
const ACCOUNT_EXT = "unipile-acc-owner-ih";

/** A key whose grant does not name the import (nor `*`). */
const NARROW: KeyGrant = grantOfScope({ permissions: ["entity.note.read"] });
/** The AI preset every new agent starts with. */
const AI_PRESET: KeyGrant = grantOfScope({
  permissions: [
    ...GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!.grant
      .permissions,
  ],
});

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** The call, as the hub auth door runs it for a key (or a session). */
function importHistory(opts: { grant?: KeyGrant; agentUserId?: string } = {}) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (opts.agentUserId) c.set("agentUserId", opts.agentUserId);
    await runWithActingAgent(opts.agentUserId, () =>
      opts.grant ? runWithGrant(opts.grant, () => next()) : next()
    );
  });
  registerMessagingRoutes(app);
  return app.request(`/messaging/accounts/${ACCOUNT_ROW}/import-history`, {
    method: "POST",
  });
}

async function importProposals() {
  const { rows } = await q<Record<string, unknown>>(
    `select id, status, agent_user_id, target_type, target_id, proposal_type, workspace_id, data from proposals where target_type = 'messaging' and proposal_type = 'import_history' order by created_at`
  );
  return rows;
}

function approve(row: Record<string, unknown>, asUser: string) {
  const ex = proposalExecRegistry.resolveExact("messaging/import_history")!;
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

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await q(
    `insert into users (id, email, user_type) values ($1, $2, 'human'), ($3, $4, 'human')`,
    [OWNER, "owner-ih@x.test", OTHER, "other-ih@x.test"]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, 'agent', $3)`,
    [AGENT, "agent-ih@x.test", OWNER]
  );
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id, display_name) values ($1, $2, 'LINKEDIN', $3, 'Owner LinkedIn')`,
    [ACCOUNT_ROW, OWNER, ACCOUNT_EXT]
  );
  proposalExecRegistry._reset();
  registerMessagingExecutors();
}, 120_000);

beforeEach(() => {
  h.queued.length = 0;
});

describe("an agent's history import becomes a proposal, never a 403", () => {
  it("an agent whose grant does not name the door: 202 proposed, nothing queued", async () => {
    const res = await importHistory({ grant: NARROW, agentUserId: AGENT });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "proposed",
      proposalId: expect.any(String),
      reviewUrl: expect.stringContaining(String(body.proposalId)),
      accountId: ACCOUNT_ROW,
    });
    const rows = await importProposals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.proposalId,
      status: "pending",
      agent_user_id: AGENT,
      target_id: ACCOUNT_ROW,
    });
    expect(h.queued).toEqual([]);
  });

  it("an agent on the AI preset is proposed too: the door asks first", async () => {
    const res = await importHistory({ grant: AI_PRESET, agentUserId: AGENT });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; proposalId: string };
    expect(body).toMatchObject({ status: "proposed" });
    // The proposal it names is a pending row (the gate may hand back the one
    // the previous test filed for the same account, so no count is asserted).
    const pending = (await importProposals()).filter(
      (r) => r.status === "pending"
    );
    expect(pending.map((r) => r.id)).toContain(body.proposalId);
    expect(h.queued).toEqual([]);
  });

  it("a signed-in person imports directly: queued once, no proposal", async () => {
    const before = (await importProposals()).length;
    const res = await importHistory();
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      queued: true,
      accountId: ACCOUNT_ROW,
    });
    expect(h.queued).toEqual([
      {
        queue: MESSAGING_HISTORY_IMPORT_QUEUE,
        data: { accountExternalId: ACCOUNT_EXT, userId: OWNER },
      },
    ]);
    expect((await importProposals()).length).toBe(before);
  });

  it("a narrowed key that is not an agent's is refused: nothing queued or filed", async () => {
    const before = (await importProposals()).length;
    const res = await importHistory({ grant: NARROW });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("GRANT_DOOR_UNSUPPORTED");
    // The refusal names the way forward, never "make a full-access key".
    expect(body.error).toMatch(/proposal you approve/);
    expect(body.error).not.toMatch(/full access|'\*'/);
    expect(h.queued).toEqual([]);
    expect((await importProposals()).length).toBe(before);
  });
});

describe("approving the agent's ask runs the import", () => {
  it("as the account's owner: queued exactly once, approved; a second approval queues nothing", async () => {
    const [row] = await importProposals();
    await approve(row!, OWNER);
    expect(h.queued).toEqual([
      {
        queue: MESSAGING_HISTORY_IMPORT_QUEUE,
        data: { accountExternalId: ACCOUNT_EXT, userId: OWNER },
      },
    ]);
    const [after] = await importProposals();
    expect(after!.status).toBe("approved");

    const again = await approve(after!, OWNER);
    expect(again).toMatchObject({ alreadyApproved: true });
    expect(h.queued).toHaveLength(1);
  });

  it("as someone who does not own the account: refused, nothing queued", async () => {
    // A fresh ask (the first one is approved; a pending twin dedups into it).
    const res = await importHistory({ grant: NARROW, agentUserId: AGENT });
    const { proposalId } = (await res.json()) as { proposalId: string };
    const pending = (await importProposals()).find((r) => r.id === proposalId);
    expect(pending).toMatchObject({ status: "pending" });
    await expect(approve(pending!, OTHER)).rejects.toThrow(/not yours/);
    expect(h.queued).toEqual([]);
  });
});

describe("the fence passes the route to its gate", () => {
  const PATH = `/messaging/accounts/${ACCOUNT_ROW}/import-history`;
  it("is a gated write, not an owner-wide door", () => {
    expect(hubRouteClass("POST", PATH)).toBe("write");
    expect(ownerWideDoorAllowed(PATH, NARROW, "POST")).toBe(true);
  });
  it("disconnecting an account stays owner-wide (the fence still bites)", () => {
    expect(hubRouteClass("DELETE", `/messaging/accounts/${ACCOUNT_ROW}`)).toBe(
      "owner-wide"
    );
  });
});
