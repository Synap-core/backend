/**
 * Per-LinkedIn-account daily limits and the LinkedIn pause, through the REAL
 * doors on PGlite (wave plan dbc8803a §2 "Limits", lane B): the channel send
 * door (`sendExternalMessage` at filing and at approval, through the real
 * `messaging.external.send` executor), the thread send door, and a verb's
 * provider call (`triggerProviderAction` with a vault:// Unipile tool, the
 * door every code skill such as `linkedin_send_invite` reaches). The limits
 * are the real caps fold (`resolveCeiling` over `governance_ceilings`).
 *
 * Rows rule out:
 *   - a LinkedIn send past today's limit reaching the provider, or being
 *     refused / failed instead of kept pending and HELD until the next day;
 *   - a held send staying held the next day;
 *   - a connection request counted only as an action (or not at all), and a
 *     message counted against the 20 connection requests;
 *   - a per-account ceiling row being ignored;
 *   - a LinkedIn 429 / cannot_resend_yet not pausing the account, or the send
 *     that met it being retried or failed instead of held;
 *   - another provider's 429 pausing anything (its classification unchanged).
 *
 * Harness copied from `channel-send.pglite.test.ts` (same stubs, same reasons),
 * plus the vault secret resolver and the HTTP transport of a verb's call.
 * Cannot see: a live Unipile account, the capability executor's skill sandbox
 * (`linkedinRunHold` is driven directly; the executor's hold wiring is pinned
 * in `proposals.linkedin-held-run.pglite.test.ts`).
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
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
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
    events: [] as Array<Record<string, unknown>>,
    readable: new Set<string>(),
    connector: null as unknown,
    /** The capability gate answers `run` (a rule or a grant would let it). */
    gateSaysRun: false,
    /** What the Unipile API answers a verb's provider call, and what it was asked. */
    providerStatus: 201,
    providerBody: {} as Record<string, unknown>,
    providerCalls: [] as Array<{ url: string; method: string }>,
  };
  return state;
});

vi.mock("../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    workerAutomationOfSession: async () => null,
  };
});
vi.mock("./index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMessagingConnector: async () => h.connector,
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async (payload: Record<string, unknown>) => {
    h.events.push(payload);
  },
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../utils/domain-mutation.js", () => ({
  recordDomainMutation: async () => ({ id: "evt" }),
}));
// The proposal ROW is real; only the notification / dedup / session plumbing
// of the one insert door is left out.
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: Record<string, unknown>) => {
    const id = randomUUID();
    await h.client!.query(
      `insert into proposals (id, proposed_by_user_id, created_by, workspace_id, target_type, target_id, proposal_type, status, data, agent_user_id, governance_reason, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,now(),now())`,
      [
        id,
        input.userId,
        input.createdBy ?? input.userId,
        input.workspaceId ?? null,
        input.targetType,
        input.targetId,
        input.proposalType,
        JSON.stringify(input.data ?? {}),
        input.agentUserId ?? null,
        input.governanceReason ?? null,
      ]
    );
    return { id };
  },
}));
vi.mock(
  "../services/capabilities/intent-recipient.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    readableRecipient: async (_ctx: unknown, entityId: string) =>
      h.readable.has(entityId)
        ? { id: entityId, title: "Marie Dupont", properties: {} }
        : null,
  })
);
// The REAL capability gate, unless a row makes it answer `run` (what a
// governance rule or an agent's capability grant would say).
vi.mock(
  "../services/capabilities/gate-capability-execution.js",
  async (importOriginal) => {
    const actual = await importOriginal<{
      gateCapabilityExecution: (...a: unknown[]) => Promise<unknown>;
    }>();
    return {
      ...actual,
      gateCapabilityExecution: async (...a: unknown[]) =>
        h.gateSaysRun
          ? { decision: "run" }
          : actual.gateCapabilityExecution(...a),
    };
  }
);
vi.mock(
  "../services/capabilities/execute-capability.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    assertApprovalTargetResolves: async () => null,
  })
);
// The vault:// transport of a verb's provider call (the Unipile tool): the
// secret resolves, and the request is answered by `h.provider`.
vi.mock("../utils/vault-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveVaultSecret: async () => "unipile-key",
}));
vi.mock("@synap/shared-utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safePublicFetch: async (url: string, init: RequestInit = {}) => {
    h.providerCalls.push({ url, method: String(init.method ?? "GET") });
    return new Response(JSON.stringify(h.providerBody), {
      status: h.providerStatus,
      headers: { "content-type": "application/json" },
    });
  },
}));
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithGrant } from "@synap/database";
import { BUILTIN_VERBS } from "../services/capabilities/builtin-verbs.js";
import { proposalExecRegistry } from "../routers/proposals/execution-registry.js";
import { registerMessagingExecutors } from "../routers/proposals/executors/messaging.js";
import {
  sendExternalMessage,
  triggerProviderAction,
} from "./external-dispatch.js";
import {
  linkedinRunHold,
  takeLinkedinAction,
} from "../services/channels/linkedin-account-limits.js";

registerMessagingExecutors();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const d = (c as unknown as { default?: unknown }).default;
    const def = ["created_at", "updated_at", "timestamp"].includes(c.name)
      ? " default now()"
      : typeof d === "boolean" || typeof d === "number"
        ? ` default ${d}`
        : typeof d === "string" && !d.includes("(")
          ? ` default '${d.replace(/'/g, "''")}'`
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const NOTE = randomUUID(); // a readable record that is not a person
const CRM = randomUUID();
const PERSON = randomUUID();
const ACCOUNT = "acc-linkedin-1";
const ACCOUNT_ROW = randomUUID();

const send = vi.fn();
const startChat = vi.fn();
const getProfile = vi.fn();

function fakeUnipile() {
  return {
    requiresAccount: () => true,
    sendMessage: send,
    startChat,
    getProfile,
  };
}

const handler = () => BUILTIN_VERBS["messaging.send"]!;
const executor = () =>
  proposalExecRegistry.resolveExact("messaging.external.send")!;

async function approve(proposalId: string) {
  const [row] = (
    await q<Record<string, unknown>>(
      `select id, workspace_id as "workspaceId", session_id as "sessionId",
              target_type as "targetType", target_id as "targetId", proposal_type as "proposalType",
              agent_user_id as "agentUserId", data from proposals where id=$1`,
      [proposalId]
    )
  ).rows;
  return executor().execute({
    proposal: row as never,
    payload: (row as { data: unknown }).data as never,
    userId: OWNER,
    input: { proposalId },
    ctx: {} as never,
    deps: {
      emitProposalReviewed: () => undefined,
      reportProposalOutcome: () => undefined,
    } as never,
  });
}

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await h.client!.exec(
    `create unique index channels_ext_uniq on channels (external_source, external_id) where external_id is not null;
     create unique index messages_channel_ext_msg_uniq on messages (channel_id, external_message_id) where external_message_id is not null;
     create unique index channels_external_pending_uniq on channels (user_id, external_source, context_object_id, coalesce(metadata->>'accountId', ''))
       where channel_type = 'external' and external_id is null and status = 'active';`
  );
  await q(
    `insert into entities (id, user_id, type, title, properties, created_at, updated_at) values ($1,$2,'person','Marie Dupont',$3,now(),now())`,
    [
      PERSON,
      OWNER,
      JSON.stringify({
        linkedinUrl: "https://www.linkedin.com/in/marie-dupont",
      }),
    ]
  );
  await q(
    `insert into entities (id, user_id, type, title, properties, created_at, updated_at) values ($1,$2,'note','A note','{}',now(),now())`,
    [NOTE, OWNER]
  );
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, created_at, updated_at)
     values ($1,$2,'linkedin',$3,'Antoine on LinkedIn','connected',now(),now())`,
    [ACCOUNT_ROW, OWNER, ACCOUNT]
  );
});

beforeEach(async () => {
  h.connector = fakeUnipile();
  h.events.length = 0;
  h.readable = new Set([PERSON]);
  h.gateSaysRun = false;
  send.mockReset();
  startChat.mockReset();
  getProfile.mockReset();
  getProfile.mockResolvedValue({
    providerId: "ACoMarie",
    publicIdentifier: "marie-dupont",
    name: "Marie Dupont",
    networkDistance: "FIRST_DEGREE",
    connection: "connected",
    relationRequest: null,
  });
  // Every test starts from a person with no channel and no proposal.
  await h.client!.exec(
    `delete from messages; delete from proposals; delete from channels; delete from tools;
     delete from messaging_accounts where external_id <> '${ACCOUNT}';`
  );
});

/** The CRM app's key: send_message in CRM, reads people there. */
const crmApp = {
  scopes: [
    {
      permissions: [
        "capability.send_message.run",
        "entity.*.read",
        "channel.read",
      ],
      workspaceIds: [CRM],
    },
  ],
  clientId: "crm-app",
};

async function appSendsTo(
  person: string,
  grant = crmApp,
  extra: Record<string, unknown> = {}
) {
  return runWithGrant(grant, () =>
    handler()(
      { to: person, text: "Hello Marie", ...extra },
      {
        userId: OWNER,
        workspaceId: CRM,
        // What the outer capability gate hands a self-gated verb when an app
        // asks (the app outward floor proposes).
        mustPropose: true,
        governanceReason: "APP_OUTWARD_INTENT",
        intentRequest: {
          intent: "send_message",
          input: { to: person, text: "Hello Marie" },
        },
      }
    )
  ) as Promise<Record<string, unknown>>;
}

const DAY = () => new Date().toISOString().slice(0, 10);
const YESTERDAY = () =>
  new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const NEXT_UTC_MIDNIGHT = () => {
  const n = new Date();
  return new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1)
  ).toISOString();
};

async function accountMeta(id = ACCOUNT_ROW) {
  const [row] = (
    await q<{ metadata: Record<string, unknown> | null }>(
      `select metadata from messaging_accounts where id=$1`,
      [id]
    )
  ).rows;
  return row?.metadata ?? {};
}
async function setAccountMeta(meta: Record<string, unknown>) {
  await q(`update messaging_accounts set metadata=$2 where id=$1`, [
    ACCOUNT_ROW,
    JSON.stringify(meta),
  ]);
}
async function proposalRow(id: string) {
  return (
    await q<{ status: string; data: Record<string, unknown> }>(
      `select status, data from proposals where id=$1`,
      [id]
    )
  ).rows[0]!;
}
const usedUp = (actions: number, invitations = 0) => ({
  linkedinDaily: { day: DAY(), actions, invitations },
});

beforeEach(async () => {
  await setAccountMeta({});
  await h.client!.exec(`delete from governance_ceilings;`);
  h.providerStatus = 201;
  h.providerBody = {};
  h.providerCalls.length = 0;
});

describe("the channel send door counts each LinkedIn message against the account's day", () => {
  it("an approved message under the limits is sent once and counted as one action", async () => {
    const out = await appSendsTo(PERSON);
    expect(out).toMatchObject({ proposed: true });
    expect((await proposalRow(out.proposalId as string)).data.held).toBe(
      undefined
    );
    startChat.mockResolvedValue({ chatId: "chat-1", messageId: "m-1" });
    await approve(out.proposalId as string);
    expect(startChat).toHaveBeenCalledTimes(1);
    expect((await accountMeta()).linkedinDaily).toEqual({
      day: DAY(),
      actions: 1,
      invitations: 0,
    });
  });

  it("past today's 50 actions: filed HELD, and its approval sends nothing and keeps it pending, held until the next UTC midnight", async () => {
    await setAccountMeta(usedUp(50));
    const out = await appSendsTo(PERSON);
    expect(out).toMatchObject({ proposed: true });
    const filed = await proposalRow(out.proposalId as string);
    expect(filed.data.held).toMatchObject({
      errorClass: "linkedin_limit",
      until: NEXT_UTC_MIDNIGHT(),
    });

    await expect(approve(out.proposalId as string)).rejects.toThrow();
    expect(startChat).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const after = await proposalRow(out.proposalId as string);
    expect(after.status).toBe("pending");
    expect(after.data.held).toMatchObject({
      errorClass: "linkedin_limit",
      until: NEXT_UTC_MIDNIGHT(),
    });
    expect((await accountMeta()).linkedinDaily).toMatchObject({ actions: 50 });
  });

  it("the next day the held message goes out on its approval", async () => {
    await setAccountMeta(usedUp(50));
    const out = await appSendsTo(PERSON);
    // A new day: yesterday's count, and the hold's end has passed.
    await setAccountMeta({
      linkedinDaily: { day: YESTERDAY(), actions: 50, invitations: 20 },
    });
    await q(
      `update proposals set data = jsonb_set(data, '{held,until}', to_jsonb($2::text)) where id=$1`,
      [out.proposalId, new Date(Date.now() - 1000).toISOString()]
    );
    startChat.mockResolvedValue({ chatId: "chat-2", messageId: "m-2" });
    await approve(out.proposalId as string);
    expect(startChat).toHaveBeenCalledTimes(1);
    expect((await proposalRow(out.proposalId as string)).status).toBe(
      "approved"
    );
    expect((await accountMeta()).linkedinDaily).toEqual({
      day: DAY(),
      actions: 1,
      invitations: 0,
    });
  });

  it("a ceiling row for this account sets its limit (here 1 action a day)", async () => {
    await q(
      `insert into governance_ceilings (id, axis, principal_kind, scope_kind, subject_type, subject_id, limit_value, created_by, created_at)
       values ($1,'linkedin_actions_daily','any','pod','messaging_account',$2,1,$3,now())`,
      [randomUUID(), ACCOUNT_ROW, OWNER]
    );
    startChat.mockResolvedValue({ chatId: "chat-3", messageId: "m-3" });
    const first = await appSendsTo(PERSON);
    await approve(first.proposalId as string);
    expect(startChat).toHaveBeenCalledTimes(1);
    const second = await appSendsTo(PERSON);
    expect(
      (await proposalRow(second.proposalId as string)).data.held
    ).toMatchObject({ errorClass: "linkedin_limit" });
  });
});

describe("LinkedIn says slow down: the account pauses until the next day, nothing retries", () => {
  it("a 429 on the send: the account is paused (rate_limited), the message held, the provider called once", async () => {
    startChat.mockRejectedValue(
      new Error(
        'Unipile startChat failed: 429 — {"status":429,"type":"errors/too_many_requests"}'
      )
    );
    const out = await appSendsTo(PERSON);
    await expect(approve(out.proposalId as string)).rejects.toThrow();
    expect(startChat).toHaveBeenCalledTimes(1);
    expect((await accountMeta()).linkedinPause).toMatchObject({
      reason: "rate_limited",
      until: NEXT_UTC_MIDNIGHT(),
    });
    const row = await proposalRow(out.proposalId as string);
    expect(row.status).toBe("pending");
    expect(row.data.held).toMatchObject({ errorClass: "linkedin_limit" });

    // Approving again the same day sends nothing: the account is paused.
    await expect(approve(out.proposalId as string)).rejects.toThrow();
    expect(startChat).toHaveBeenCalledTimes(1);
  });

  it("another provider's 429 pauses nothing and is answered as before", async () => {
    const WA_ROW = randomUUID();
    await q(
      `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, created_at, updated_at)
       values ($1,$2,'whatsapp','acc-wa-1','Antoine on WhatsApp','connected',now(),now())`,
      [WA_ROW, OWNER]
    );
    send.mockRejectedValue(new Error("Unipile sendMessage failed: 429"));
    await expect(
      sendExternalMessage({
        threadId: "wa-thread",
        accountId: "acc-wa-1",
        body: "Hi",
        userId: OWNER,
      })
    ).rejects.toThrow(/429/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await accountMeta(WA_ROW)).not.toHaveProperty("linkedinPause");
    expect(await accountMeta(WA_ROW)).not.toHaveProperty("linkedinDaily");
  });

  it("the thread send door: a LinkedIn 429 pauses the account and answers held; past the limit the provider is never called", async () => {
    send.mockRejectedValue(new Error("Unipile sendMessage failed: 429"));
    const out = await sendExternalMessage({
      threadId: "li-thread",
      accountId: ACCOUNT,
      body: "Hi",
      userId: OWNER,
    });
    expect(out).toMatchObject({
      success: false,
      held: { errorClass: "linkedin_limit" },
    });
    expect((await accountMeta()).linkedinPause).toMatchObject({
      reason: "rate_limited",
    });
    send.mockReset();
    await setAccountMeta(usedUp(50));
    const again = await sendExternalMessage({
      threadId: "li-thread",
      accountId: ACCOUNT,
      body: "Hi",
      userId: OWNER,
    });
    expect(again).toMatchObject({ success: false, held: {} });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("a verb's provider call (a code skill's connection request) is counted and paused too", () => {
  const TOOL = randomUUID();
  const SECRET = randomUUID();
  beforeAll(async () => {
    await q(
      `insert into secrets (id, user_id, name, is_pod_wide, created_at, updated_at) values ($1,$2,'unipile',false,now(),now())`,
      [SECRET, OWNER]
    );
  });
  beforeEach(async () => {
    await q(
      `insert into tools (id, name, kind, credential_ref, config, approved, created_by, created_at, updated_at)
       values ($1,'unipile_linkedin','api',$2,$3,true,$4,now(),now())`,
      [
        TOOL,
        `vault://${SECRET}`,
        JSON.stringify({
          baseUrl: "https://api.unipile.example/api/v1",
          auth: { in: "header", name: "X-API-KEY" },
        }),
        OWNER,
      ]
    );
  });
  const invite = () =>
    triggerProviderAction({
      userId: OWNER,
      provider: "unipile_linkedin",
      method: "POST",
      path: `/${ACCOUNT}/users/me/relation-requests`,
      body: { user_id: "ACoMarie", message: "Hello" },
      alreadyApproved: true,
    });

  it("an invitation is sent and counted in BOTH counts; a read is not counted", async () => {
    const read = await triggerProviderAction({
      userId: OWNER,
      provider: "unipile_linkedin",
      method: "GET",
      path: `/${ACCOUNT}/users/marie`,
      alreadyApproved: true,
    });
    expect(read.success).toBe(true);
    const out = await invite();
    expect(out.success).toBe(true);
    expect(h.providerCalls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect((await accountMeta()).linkedinDaily).toEqual({
      day: DAY(),
      actions: 1,
      invitations: 1,
    });
  });

  it("past today's 20 connection requests: not sent (429, transient) while a message still goes", async () => {
    await setAccountMeta(usedUp(20, 20));
    const out = await invite();
    expect(out).toMatchObject({
      success: false,
      status: 429,
      errorClass: "transient",
    });
    expect(h.providerCalls).toHaveLength(0);
    const msg = await triggerProviderAction({
      userId: OWNER,
      provider: "unipile_linkedin",
      method: "POST",
      path: `/${ACCOUNT}/chats/chat-1/messages/send`,
      body: { text: "Hi" },
      alreadyApproved: true,
    });
    expect(msg.success).toBe(true);
    expect((await accountMeta()).linkedinDaily).toEqual({
      day: DAY(),
      actions: 21,
      invitations: 20,
    });
  });

  it("LinkedIn answers 422 cannot_resend_yet: the account is paused for the day and the next request is not sent", async () => {
    h.providerStatus = 422;
    h.providerBody = {
      status: 422,
      type: "errors/cannot_resend_yet",
      detail: "You cannot resend this invitation yet.",
    };
    const out = await invite();
    expect(out.success).toBe(false);
    expect((await accountMeta()).linkedinPause).toMatchObject({
      reason: "cannot_resend_yet",
      until: NEXT_UTC_MIDNIGHT(),
    });
    h.providerStatus = 201;
    const next = await invite();
    expect(next).toMatchObject({ success: false, status: 429 });
    expect(h.providerCalls).toHaveLength(1);
  });

  it("another 4xx (a bad request) pauses nothing", async () => {
    h.providerStatus = 400;
    h.providerBody = { status: 400, type: "errors/invalid_parameters" };
    await invite();
    expect(await accountMeta()).not.toHaveProperty("linkedinPause");
  });
});

describe("the counts themselves", () => {
  it("connection requests stop at 20 while messages go on to 50", async () => {
    for (let i = 0; i < 20; i++) {
      expect(await takeLinkedinAction(ACCOUNT_ROW, "invitation")).toBeNull();
    }
    expect(await takeLinkedinAction(ACCOUNT_ROW, "invitation")).toMatchObject({
      errorClass: "linkedin_limit",
    });
    for (let i = 0; i < 30; i++) {
      expect(await takeLinkedinAction(ACCOUNT_ROW, "message")).toBeNull();
    }
    expect(await takeLinkedinAction(ACCOUNT_ROW, "message")).toMatchObject({
      errorClass: "linkedin_limit",
    });
    expect((await accountMeta()).linkedinDaily).toEqual({
      day: DAY(),
      actions: 50,
      invitations: 20,
    });
  });

  it("a connection-request run (linkedinRunHold) is held only for a LinkedIn account that may not act", async () => {
    const run = (intent: string | null, accountId: unknown) =>
      linkedinRunHold({ userId: OWNER, intent, params: { accountId } });
    expect(await run("request_connection", ACCOUNT)).toBeNull();
    await setAccountMeta(usedUp(5, 20));
    expect(await run("request_connection", ACCOUNT)).toMatchObject({
      errorClass: "linkedin_limit",
    });
    // A message is still allowed; an unknown account or a verb with no send
    // intent is not this door's.
    expect(await run("send_message", ACCOUNT)).toBeNull();
    expect(await run("request_connection", "someone-else")).toBeNull();
    expect(await run("find_people", ACCOUNT)).toBeNull();
    expect(await run(null, ACCOUNT)).toBeNull();
  });
});
