/**
 * ONE send door, on the person's channel (channels wave, lane D, design
 * d00cd2ac §4). The REAL `messaging.send` builtin, the REAL send door
 * (`sendExternalMessage` → `gateMessagingSend` → the real capability gate),
 * the REAL `messaging.external.send` approval executor with its at-most-once
 * claim, and the REAL `insertChannelMessage`, all on PGlite (every table
 * generated from the Drizzle definitions, plus the two unique indexes the
 * send relies on). Stubbed: the provider connector (a fake Unipile), the
 * side-effect fan-out (captured), the proposal insert's notification fan-out
 * (the row itself is real), the audit append, the person-readable read
 * (`readableRecipient`, the access layer's own tests cover it). Lane C's
 * `openPersonChannel` is the real one (its history-import enqueue is the
 * stubbed queue).
 *
 * Rows rule out:
 *   - an app's send filing a generic capability run instead of the proposed
 *     message ON THE PERSON'S CHANNEL (`data.channelId`, targetId = channel);
 *   - an app key with `capability.send_message.run` refused on a pod-wide
 *     person channel (the grant check failed closed on pod scope);
 *   - a key with no send permission opening a channel or filing anything;
 *   - an agent with no grant sending (it files, never sends);
 *   - an approval that sends twice, or sends without filling the chat id, or
 *     records the message as anything but outbound / sent / its provider id;
 *   - a send to someone who is not a 1st-degree connection reaching the
 *     provider (refused `not_connected` BEFORE startChat);
 *   - a chat already held by another channel (the provider's echo) leaving
 *     two channels for one conversation;
 *   - `external_message.sent` not reaching the automations fan-out;
 *   - an agent's send beyond its key's grant refused instead of filed, sent,
 *     or filed for a person the key cannot read; an app's or a person's
 *     narrowed key filed instead of refused (founder, 2026-11-03).
 *
 * Cannot see: a live Unipile account, the intent actions door's HTTP layer.
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
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  runWithGrant,
  insertChannelMessage,
  isClientCommsFirewallTarget,
  mirrorMessageToBoundExternal,
} from "@synap/database";
import { BUILTIN_VERBS } from "../services/capabilities/builtin-verbs.js";
import { proposalExecRegistry } from "../routers/proposals/execution-registry.js";
import { registerMessagingExecutors } from "../routers/proposals/executors/messaging.js";
import { readAttachedFailureMeta } from "../routers/proposals/failure-classification.js";
import { sendExternalMessage } from "./external-dispatch.js";

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
const STRANGER = randomUUID(); // another person of the pod
const NOTE = randomUUID(); // a readable record that is not a person
const AGENT = randomUUID();
const CRM = randomUUID();
const PERSON = randomUUID();
const ACCOUNT = "acc-linkedin-1";

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

async function proposalsOn(channelId: string) {
  return (
    await q<{
      id: string;
      proposal_type: string;
      target_id: string;
      data: Record<string, unknown>;
    }>(
      `select id, proposal_type, target_id, data from proposals where data->>'channelId' = $1`,
      [channelId]
    )
  ).rows;
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
    [randomUUID(), OWNER, ACCOUNT]
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

describe("an app's send is a proposed message on the person's channel", () => {
  it("opens the person's channel at the first draft and files messaging.external.send on it", async () => {
    const out = await appSendsTo(PERSON);
    expect(out).toMatchObject({ proposed: true });
    const channelId = out.channelId as string;
    const [channel] = (
      await q<{
        external_id: string | null;
        context_object_id: string;
        metadata: Record<string, unknown>;
      }>(
        `select external_id, context_object_id, metadata from channels where id=$1`,
        [channelId]
      )
    ).rows;
    expect(channel).toMatchObject({
      external_id: null,
      context_object_id: PERSON,
    });
    expect(channel!.metadata).toMatchObject({ accountId: ACCOUNT });

    const filed = await proposalsOn(channelId);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      id: out.proposalId,
      proposal_type: "messaging.external.send",
      target_id: channelId,
    });
    expect(filed[0]!.data).toMatchObject({
      channelId,
      entityId: PERSON,
      provider: "linkedin",
      accountId: ACCOUNT,
      body: "Hello Marie",
      draftedBy: { agentUserId: null, appClientId: "crm-app" },
      intentRequest: { intent: "send_message" },
    });
    // Never a generic capability run, and nothing went out.
    expect(
      (
        await q(
          `select 1 from proposals where proposal_type <> 'messaging.external.send'`
        )
      ).rows
    ).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });

  it("a second draft lands on the SAME channel", async () => {
    const a = await appSendsTo(PERSON);
    const b = await appSendsTo(PERSON);
    expect(b.channelId).toBe(a.channelId);
  });

  it("a key with no send permission is refused before a channel is opened", async () => {
    const out = await appSendsTo(PERSON, {
      scopes: [
        { permissions: ["entity.*.read", "channel.read"], workspaceIds: [CRM] },
      ],
      clientId: "crm-app",
    });
    expect(out.success).toBe(false);
    expect(String(out.error)).toMatch(/grant does not allow/);
    expect((await q(`select 1 from channels`)).rows).toHaveLength(0);
    expect((await q(`select 1 from proposals`)).rows).toHaveLength(0);
  });

  it("a person the app cannot read is not found", async () => {
    h.readable = new Set();
    await expect(appSendsTo(PERSON)).rejects.toThrow(/not found/i);
    expect((await q(`select 1 from channels`)).rows).toHaveLength(0);
  });
});

describe("an agent with no grant never sends", () => {
  it("through the outer gate (mustPropose) it files the proposed message; the provider is never called", async () => {
    const out = (await handler()(
      { to: PERSON, content: "Hi from the agent" },
      {
        userId: OWNER,
        workspaceId: CRM,
        agentUserId: AGENT,
        // What execute-capability hands a self-gated verb when the agent's
        // run has no grant (the outer gate proposes).
        mustPropose: true,
        governanceReason: "CAPABILITY_PROPOSE",
      }
    )) as Record<string, unknown>;
    expect(out).toMatchObject({ proposed: true, success: false });
    const filed = await proposalsOn(out.channelId as string);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.data).toMatchObject({
      draftedBy: { agentUserId: AGENT, appClientId: null },
    });
    expect(send).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });

  it("straight into the send door (no outer gate), the real gate never lets it send", async () => {
    const out = (await handler()(
      { to: PERSON, content: "Hi from the agent" },
      { userId: OWNER, workspaceId: CRM, agentUserId: AGENT }
    )) as Record<string, unknown>;
    expect(out.success).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });

  it("an automation's send proposes even with no agent (never sent as the owner)", async () => {
    const out = (await handler()(
      { to: PERSON, content: "Cadence follow-up" },
      {
        userId: OWNER,
        workspaceId: CRM,
        automationRun: { sessionId: randomUUID(), agentUserId: null },
      }
    )) as Record<string, unknown>;
    expect(out).toMatchObject({ proposed: true });
    expect(startChat).not.toHaveBeenCalled();
  });
});

describe("approval sends once and records the outbound message", () => {
  it("starts the chat once, fills the chat id, writes ONE outbound/sent row with the provider id", async () => {
    startChat.mockResolvedValue({ chatId: "chat-1", messageId: "msg-1" });
    const out = await appSendsTo(PERSON);
    const channelId = out.channelId as string;
    const proposalId = out.proposalId as string;

    await approve(proposalId);

    expect(startChat).toHaveBeenCalledTimes(1);
    expect(startChat).toHaveBeenCalledWith(ACCOUNT, "ACoMarie", "Hello Marie");
    expect(send).not.toHaveBeenCalled();
    const [channel] = (
      await q<{
        external_id: string;
        external_channel_id: string;
        metadata: Record<string, unknown>;
      }>(
        `select external_id, external_channel_id, metadata from channels where id=$1`,
        [channelId]
      )
    ).rows;
    expect(channel).toMatchObject({
      external_id: "chat-1",
      external_channel_id: "chat-1",
    });
    expect(channel!.metadata).toMatchObject({
      participantExternalId: "ACoMarie",
    });

    const rows = (
      await q<Record<string, unknown>>(
        `select direction, delivery_status, external_message_id, external_source, author_type, role, content, metadata
           from messages where channel_id=$1`,
        [channelId]
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "outbound",
      delivery_status: "sent",
      external_message_id: "msg-1",
      external_source: "linkedin",
      author_type: "human",
      role: "assistant",
      content: "Hello Marie",
    });
    expect(rows[0]!.metadata).toMatchObject({
      proposalId,
      accountId: ACCOUNT,
      draftedBy: { appClientId: "crm-app" },
    });
    const [p] = (
      await q<{ status: string }>(`select status from proposals where id=$1`, [
        proposalId,
      ])
    ).rows;
    expect(p!.status).toBe("approved");

    // For automations: the person, the channel, the message, the proposal, first.
    const sent = h.events.filter(
      (e) => e.subjectType === "external_message" && e.action === "sent"
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toMatchObject({
      entityId: PERSON,
      channelId,
      provider: "linkedin",
      externalMessageId: "msg-1",
      proposalId,
      first: true,
    });
  });

  it("a double approval sends once", async () => {
    startChat.mockResolvedValue({ chatId: "chat-2", messageId: "msg-2" });
    const out = await appSendsTo(PERSON);
    await approve(out.proposalId as string);
    const again = await approve(out.proposalId as string);
    expect(again).toMatchObject({ alreadyApproved: true });
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(
      (await q(`select 1 from messages where channel_id=$1`, [out.channelId]))
        .rows
    ).toHaveLength(1);
  });

  it("a second message on a channel with a chat continues it (sendMessage, no new chat)", async () => {
    startChat.mockResolvedValue({ chatId: "chat-3", messageId: "msg-3" });
    send.mockResolvedValue({ messageId: "msg-4" });
    const first = await appSendsTo(PERSON);
    await approve(first.proposalId as string);
    const second = await appSendsTo(PERSON);
    expect(second.channelId).toBe(first.channelId);
    await approve(second.proposalId as string);
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(ACCOUNT, "chat-3", "Hello Marie");
    const ids = (
      await q<{ external_message_id: string }>(
        `select external_message_id from messages where channel_id=$1 order by external_message_id`,
        [first.channelId]
      )
    ).rows.map((r) => r.external_message_id);
    expect(ids).toEqual(["msg-3", "msg-4"]);
  });

  it("not a 1st-degree connection at approval: refused not_connected BEFORE any send; the claim is released", async () => {
    // Connected when filed, no longer when approved: the dispatch check holds.
    const out = await appSendsTo(PERSON);
    expect(out).toMatchObject({ proposed: true });
    getProfile.mockResolvedValue({
      providerId: "ACoMarie",
      publicIdentifier: "marie-dupont",
      name: "Marie Dupont",
      networkDistance: "SECOND_DEGREE",
      connection: "not_connected",
      relationRequest: null,
    });
    let caught: unknown;
    try {
      await approve(out.proposalId as string);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(readAttachedFailureMeta(caught)?.errorClass).toBe("not_connected");
    expect(startChat).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const [p] = (
      await q<{ status: string; external_dispatched_at: string | null }>(
        `select status, external_dispatched_at from proposals where id=$1`,
        [out.proposalId]
      )
    ).rows;
    expect(p).toMatchObject({
      status: "pending",
      external_dispatched_at: null,
    });
  });

  it("the chat already held by another channel: the message lands there, the pending channel is archived", async () => {
    const holder = randomUUID();
    await q(
      `insert into channels (id, user_id, channel_type, scope, status, title, external_source, external_id, external_channel_id, metadata, created_at, updated_at)
       values ($1,$2,'external','pod','active','Marie (echo)','linkedin','chat-held','chat-held','{}',now(),now())`,
      [holder, OWNER]
    );
    startChat.mockResolvedValue({ chatId: "chat-held", messageId: "msg-held" });
    const out = await appSendsTo(PERSON);
    await approve(out.proposalId as string);
    const [pending] = (
      await q<{ status: string }>(`select status from channels where id=$1`, [
        out.channelId,
      ])
    ).rows;
    expect(pending!.status).toBe("archived");
    expect(
      (
        await q(
          `select 1 from messages where channel_id=$1 and external_message_id='msg-held'`,
          [holder]
        )
      ).rows
    ).toHaveLength(1);
    const [p] = (
      await q<{ data: Record<string, unknown>; target_id: string }>(
        `select data, target_id from proposals where id=$1`,
        [out.proposalId]
      )
    ).rows;
    expect(p!.data.channelId).toBe(holder);
    expect(p!.target_id).toBe(holder);
    // The holder now follows the person.
    const [held] = (
      await q<{ context_object_id: string | null }>(
        `select context_object_id from channels where id=$1`,
        [holder]
      )
    ).rows;
    expect(held!.context_object_id).toBe(PERSON);
  });

  it("the provider's echo landed first: one row, carrying this send's metadata", async () => {
    const out = await appSendsTo(PERSON);
    // The echo arrives before the send door records: fill + row by hand.
    await q(
      `update channels set external_id='chat-echo', external_channel_id='chat-echo' where id=$1`,
      [out.channelId]
    );
    await q(
      `insert into messages (id, channel_id, user_id, role, author_type, content, hash, previous_hash, direction, delivery_status, external_message_id, metadata)
       values ($1,$2,$3,'assistant','human','Hello Marie','h','', 'outbound','sent','msg-echo','{"source":"provider"}')`,
      [randomUUID(), out.channelId, OWNER]
    );
    send.mockResolvedValue({ messageId: "msg-echo" });
    await approve(out.proposalId as string);
    const rows = (
      await q<{ metadata: Record<string, unknown> }>(
        `select metadata from messages where channel_id=$1`,
        [out.channelId]
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      source: "provider",
      proposalId: out.proposalId,
    });
    // The echo already announced it: no second external_message.sent.
    expect(h.events.filter((e) => e.action === "sent")).toHaveLength(0);
  });
});

describe("the send door without a channel id stays as it was", () => {
  it("a thread send with no channel row sends and records nothing in a channel", async () => {
    send.mockResolvedValue({ messageId: "m" });
    const out = await sendExternalMessage({
      threadId: "legacy-thread",
      accountId: ACCOUNT,
      body: "hi",
      userId: OWNER,
    });
    expect(out.success).toBe(true);
    expect(send).toHaveBeenCalledWith(ACCOUNT, "legacy-thread", "hi");
  });
});

describe("the client-comms firewall still holds on a person's channel", () => {
  it("a person's channel is a firewall target: autonomous output is never pushed to it", async () => {
    expect(
      isClientCommsFirewallTarget({
        branchPurpose: null,
        contextObjectId: PERSON,
      })
    ).toBe(true);
    const r = await mirrorMessageToBoundExternal({
      channel: {
        channelType: "external",
        externalSource: "discord",
        externalId: "discord-dm-1",
        branchPurpose: null,
        contextObjectId: PERSON,
      },
      content: "an agent's reply",
      authorType: "ai_agent",
    });
    expect(r).toMatchObject({
      mirrored: false,
      reason: "blocked_client_comms_mirror",
    });
  });

  it("a message the send door already delivered is never mirrored out a second time", async () => {
    const id = randomUUID();
    await q(
      `insert into channels (id, user_id, channel_type, scope, status, title, context_object_type, context_object_id, external_source, external_id, metadata, created_at, updated_at)
       values ($1,$2,'external','pod','active','Marie on Discord','entity',$3,'discord','discord-dm-2','{}',now(),now())`,
      [id, OWNER, PERSON]
    );
    const r = await insertChannelMessage({
      channelId: id,
      content: "sent by the person",
      userId: OWNER,
      authorType: "human",
      direction: "outbound",
      deliveryStatus: "sent",
      externalMessageId: "discord-msg-1",
      alreadyDelivered: true,
    });
    expect(r).toMatchObject({
      inserted: true,
      mirrored: false,
      mirrorReason: "already-delivered",
    });
    expect((await q(`select 1 from channel_egress`)).rows).toHaveLength(0);
  });
});

describe("security review (lane D)", () => {
  const statusOf = async (id: string) =>
    (
      await q<{ status: string; external_dispatched_at: string | null }>(
        `select status, external_dispatched_at from proposals where id=$1`,
        [id]
      )
    ).rows[0]!;

  it("a recipient swap after filing is refused: nothing is sent", async () => {
    startChat.mockResolvedValue({ chatId: "chat-swap", messageId: "m-swap" });
    const marie = await appSendsTo(PERSON);
    // Another conversation of the pod (Bob's).
    const bob = randomUUID();
    await q(
      `insert into channels (id, user_id, channel_type, scope, status, title, external_source, external_id, metadata, created_at, updated_at)
       values ($1,$2,'external','pod','active','Bob','linkedin','chat-bob',$3,now(),now())`,
      [bob, OWNER, JSON.stringify({ accountId: ACCOUNT })]
    );
    // The data is rewritten under the card the person reads (Marie).
    await q(
      `update proposals set data = jsonb_set(data, '{channelId}', to_jsonb($2::text)) where id=$1`,
      [marie.proposalId, bob]
    );
    let caught: unknown;
    try {
      await approve(marie.proposalId as string);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
    expect((await statusOf(marie.proposalId as string)).status).toBe("pending");
  });

  it("a provider error before the send releases the claim; the retry sends once", async () => {
    startChat.mockResolvedValue({ chatId: "chat-retry", messageId: "m-retry" });
    const out = await appSendsTo(PERSON);
    getProfile.mockRejectedValueOnce(
      new Error("Unipile profile lookup failed: 503 — upstream down")
    );
    let caught: unknown;
    try {
      await approve(out.proposalId as string);
    } catch (err) {
      caught = err;
    }
    expect(readAttachedFailureMeta(caught)?.errorClass).toBe("transient");
    expect(startChat).not.toHaveBeenCalled();
    expect(await statusOf(out.proposalId as string)).toMatchObject({
      status: "pending",
      external_dispatched_at: null,
    });
    await approve(out.proposalId as string);
    expect(startChat).toHaveBeenCalledTimes(1);
    expect((await statusOf(out.proposalId as string)).status).toBe("approved");
  });

  it("the provider refusing the send (a 429) releases the claim; the retry sends once", async () => {
    startChat
      .mockRejectedValueOnce(
        new Error("Unipile startChat failed: 429 — too many requests")
      )
      .mockResolvedValue({ chatId: "chat-429", messageId: "m-429" });
    const out = await appSendsTo(PERSON);
    let caught: unknown;
    try {
      await approve(out.proposalId as string);
    } catch (err) {
      caught = err;
    }
    expect(readAttachedFailureMeta(caught)?.errorClass).toBe("transient");
    expect(await statusOf(out.proposalId as string)).toMatchObject({
      status: "pending",
      external_dispatched_at: null,
    });
    await approve(out.proposalId as string);
    expect(startChat).toHaveBeenCalledTimes(2);
    expect((await statusOf(out.proposalId as string)).status).toBe("approved");
  });

  it("a send that may have gone out (a timeout, a 502) keeps the claim: never sent twice", async () => {
    for (const failure of [
      new Error("The operation was aborted due to timeout"),
      new Error("Unipile startChat failed: 502 — bad gateway"),
    ]) {
      startChat.mockReset();
      startChat
        .mockRejectedValueOnce(failure)
        .mockResolvedValue({ chatId: "chat-amb", messageId: "m-amb" });
      const out = await appSendsTo(PERSON);
      await expect(approve(out.proposalId as string)).rejects.toThrow(
        failure.message
      );
      const row = await statusOf(out.proposalId as string);
      expect(row.status).toBe("pending");
      expect(row.external_dispatched_at).not.toBeNull();
      await expect(approve(out.proposalId as string)).rejects.toThrow(
        /Nothing was sent again/
      );
      expect(startChat).toHaveBeenCalledTimes(1);
      await q(`delete from proposals where id=$1`, [out.proposalId]);
    }
  });

  it("a send that went out but could not be recorded is reported sent, never failed", async () => {
    startChat.mockResolvedValue({ chatId: "chat-norec", messageId: "m-norec" });
    const out = await appSendsTo(PERSON);
    await h.client!.exec(`alter table messages rename to messages_away;`);
    try {
      await approve(out.proposalId as string);
    } finally {
      await h.client!.exec(`alter table messages_away rename to messages;`);
    }
    expect(startChat).toHaveBeenCalledTimes(1);
    expect((await statusOf(out.proposalId as string)).status).toBe("approved");
  });

  it("mustPropose is tighten-only: a messaging tool the person turned off refuses and files nothing", async () => {
    await q(
      `insert into tools (id, name, credential_ref, approved, created_by, workspace_id, created_at, updated_at)
       values ($1,'linkedin messaging','messaging://linkedin',false,$2,null,now(),now())`,
      [randomUUID(), OWNER]
    );
    const out = await appSendsTo(PERSON);
    expect(out.success).toBe(false);
    expect(out.proposed).toBeUndefined();
    expect((await q(`select 1 from proposals`)).rows).toHaveLength(0);
  });

  it("only the owner of a conversation can file a send in it (refused before anything is filed)", async () => {
    const theirs = randomUUID();
    await q(
      `insert into channels (id, user_id, channel_type, scope, status, title, external_source, external_id, metadata, created_at, updated_at)
       values ($1,$2,'external','pod','active','Theirs','linkedin','chat-theirs','{}',now(),now())`,
      [theirs, STRANGER]
    );
    const out = await sendExternalMessage({
      channelId: theirs,
      accountId: ACCOUNT,
      body: "hi",
      userId: OWNER,
      mustPropose: true,
    });
    expect(out).toMatchObject({ success: false, errorClass: "permission" });
    expect((await q(`select 1 from proposals`)).rows).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("a named channel the caller cannot read is not found", async () => {
    // In the stranger's own space, which the caller is not a member of. (An
    // EXTERNAL channel with NO space is visible to every pod member today:
    // channelVisibilityWhere's shared-type branch. That floor is a separate
    // decision, so this case pins the channel where the floor does hide it.)
    const theirs = randomUUID();
    const theirSpace = randomUUID();
    await q(
      `insert into workspaces (id, owner_id, name, settings) values ($1, $2, 'Theirs', '{}'::jsonb)`,
      [theirSpace, STRANGER]
    );
    await q(
      `insert into channels (id, user_id, workspace_id, channel_type, scope, status, title, external_source, external_id, metadata, created_at, updated_at)
       values ($1,$2,$3,'external','workspace','active','Theirs','linkedin','chat-hidden','{}',now(),now())`,
      [theirs, STRANGER, theirSpace]
    );
    await expect(
      handler()(
        { channelId: theirs, content: "hi" },
        { userId: OWNER, workspaceId: null }
      )
    ).rejects.toThrow(/not found/i);
    expect((await q(`select 1 from proposals`)).rows).toHaveLength(0);
  });

  it("an approved send whose pending channel was retired goes to the person's live channel", async () => {
    const out = await appSendsTo(PERSON);
    const live = randomUUID();
    await q(
      `insert into channels (id, user_id, channel_type, scope, status, title, context_object_type, context_object_id, external_source, external_id, external_channel_id, metadata, created_at, updated_at)
       values ($1,$2,'external','pod','active','Marie','entity',$3,'linkedin','chat-live','chat-live',$4,now(),now())`,
      [live, OWNER, PERSON, JSON.stringify({ accountId: ACCOUNT })]
    );
    await q(`update channels set status='archived' where id=$1`, [
      out.channelId,
    ]);
    send.mockResolvedValue({ messageId: "m-live" });
    await approve(out.proposalId as string);
    expect(send).toHaveBeenCalledWith(ACCOUNT, "chat-live", "Hello Marie");
    expect(
      (await q(`select 1 from messages where channel_id=$1`, [live])).rows
    ).toHaveLength(1);
  });

  it("`to` must be a person or a company: another record is not found", async () => {
    h.readable = new Set([PERSON, NOTE]);
    await expect(appSendsTo(NOTE)).rejects.toThrow(/not found/i);
    expect((await q(`select 1 from channels`)).rows).toHaveLength(0);
  });

  it("a key with no send permission learns nothing about the accounts", async () => {
    const out = await appSendsTo(
      PERSON,
      {
        scopes: [{ permissions: ["entity.*.read"], workspaceIds: [CRM] }],
        clientId: "crm-app",
      },
      { accountId: "acc-someone-else" }
    );
    expect(out.success).toBe(false);
    expect(String(out.error)).toMatch(/grant does not allow/);
  });

  it("two connected accounts on the tool and none named: refused at the draft", async () => {
    await q(
      `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, created_at, updated_at)
       values ($1,$2,'linkedin','acc-linkedin-2','Second','connected',now(),now())`,
      [randomUUID(), OWNER]
    );
    await expect(
      appSendsTo(PERSON, crmApp, { provider: "linkedin" })
    ).rejects.toThrow(/several connected accounts/);
    expect((await q(`select 1 from proposals`)).rows).toHaveLength(0);
  });

  it("LinkedIn: an unknown network distance is not a connection (refused at filing, and at dispatch)", async () => {
    const unknownDistance = {
      providerId: "ACoMarie",
      publicIdentifier: "marie-dupont",
      name: "Marie Dupont",
      networkDistance: null,
      connection: null,
      relationRequest: null,
    };
    getProfile.mockResolvedValue(unknownDistance);
    const refused = await appSendsTo(PERSON);
    expect(refused).toMatchObject({
      success: false,
      errorClass: "not_connected",
    });
    expect((await q(`select 1 from proposals`)).rows).toHaveLength(0);
    // Filed while LinkedIn could not be read, the dispatch check still holds.
    getProfile.mockRejectedValueOnce(
      new Error("Unipile getProfile failed: 503")
    );
    const out = await appSendsTo(PERSON);
    expect(out).toMatchObject({ proposed: true });
    let caught: unknown;
    try {
      await approve(out.proposalId as string);
    } catch (err) {
      caught = err;
    }
    expect(readAttachedFailureMeta(caught)?.errorClass).toBe("not_connected");
    expect(startChat).not.toHaveBeenCalled();
  });

  it("a subject is shown on the proposed message and kept on the sent one", async () => {
    startChat.mockResolvedValue({ chatId: "chat-subj", messageId: "m-subj" });
    const out = await appSendsTo(PERSON, crmApp, { subject: "Next steps" });
    const [p] = await proposalsOn(out.channelId as string);
    expect(p!.data).toMatchObject({ subject: "Next steps" });
    await approve(out.proposalId as string);
    const [row] = (
      await q<{ metadata: Record<string, unknown> }>(
        `select metadata from messages where channel_id=$1`,
        [out.channelId]
      )
    ).rows;
    expect(row!.metadata).toMatchObject({ subject: "Next steps" });
  });
});

// Founder, 2026-11-03: "normally, like we do all, it should still be possible,
// but it creates a proposal". An AGENT's key whose grant does not reach the
// send asks: its message is filed on the person's channel, never sent, and
// only the person's approval sends it. Every other narrowed key is refused.
describe("an agent's send beyond its key's grant is a proposed message", () => {
  /** An agent's key (no app): reads people in CRM, may not send. */
  const agentKey = {
    scopes: [
      { permissions: ["entity.*.read", "channel.read"], workspaceIds: [CRM] },
    ],
  };

  /** A person's channel with a chat, owned by OWNER. */
  async function personChannel(chat: string) {
    const id = randomUUID();
    await q(
      `insert into channels (id, user_id, channel_type, scope, status, title, context_object_type, context_object_id, external_source, external_id, external_channel_id, metadata, created_at, updated_at)
       values ($1,$2,'external','pod','active','Marie','entity',$3,'linkedin',$4,$4,$5,now(),now())`,
      [id, OWNER, PERSON, chat, JSON.stringify({ accountId: ACCOUNT })]
    );
    return id;
  }

  function agentSendsTo(
    person: string,
    grant: Record<string, unknown> = agentKey
  ) {
    return runWithGrant(grant as never, () =>
      handler()(
        { to: person, content: "Hi from the agent" },
        {
          userId: OWNER,
          workspaceId: CRM,
          agentUserId: AGENT,
          // What execute-capability hands a self-gated verb for an agent.
          mustPropose: true,
          governanceReason: "CAPABILITY_PROPOSE",
        }
      )
    ) as Promise<Record<string, unknown>>;
  }

  it("files the proposed message on the person's channel, drafted by the agent; nothing is sent", async () => {
    const out = await agentSendsTo(PERSON);
    expect(out).toMatchObject({ proposed: true, success: false });
    expect(out.error).toBeUndefined();
    const filed = await proposalsOn(out.channelId as string);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      proposal_type: "messaging.external.send",
      target_id: out.channelId,
    });
    expect(filed[0]!.data).toMatchObject({
      body: "Hi from the agent",
      draftedBy: { agentUserId: AGENT, appClientId: null },
    });
    expect(send).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });

  it("is filed even when the gate would let it run: no rule sends a message beyond the grant", async () => {
    const channelId = await personChannel("chat-beyond-run");
    h.gateSaysRun = true;
    const out = await runWithGrant(agentKey as never, () =>
      sendExternalMessage({
        channelId,
        accountId: ACCOUNT,
        body: "Hi from the agent",
        userId: OWNER,
        agentUserId: AGENT,
        workspaceId: CRM,
      })
    );
    expect(out).toMatchObject({ success: false, proposed: true });
    expect(await proposalsOn(channelId)).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("a person the key cannot read is refused, never filed", async () => {
    const channelId = await personChannel("chat-unreadable");
    h.readable = new Set();
    const out = await runWithGrant(agentKey as never, () =>
      sendExternalMessage({
        channelId,
        accountId: ACCOUNT,
        body: "Hi from the agent",
        userId: OWNER,
        agentUserId: AGENT,
        workspaceId: CRM,
        mustPropose: true,
      })
    );
    expect(out.success).toBe(false);
    expect(out.proposed).toBeUndefined();
    expect(String(out.error)).toMatch(/grant does not allow/);
    expect((await q(`select 1 from proposals`)).rows).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("an app's key acting as an agent is still refused: nothing opened or filed", async () => {
    const out = await agentSendsTo(PERSON, {
      ...agentKey,
      clientId: "crm-app",
    });
    expect(out.success).toBe(false);
    expect(out.proposed).toBeUndefined();
    expect(String(out.error)).toMatch(/grant does not allow/);
    expect((await q(`select 1 from channels`)).rows).toHaveLength(0);
    expect((await q(`select 1 from proposals`)).rows).toHaveLength(0);
  });

  it("a person's narrowed key (no agent) is still refused: nothing opened or filed", async () => {
    const out = (await runWithGrant(agentKey as never, () =>
      handler()(
        { to: PERSON, content: "Hi" },
        { userId: OWNER, workspaceId: CRM }
      )
    )) as Record<string, unknown>;
    expect(out.success).toBe(false);
    expect(out.proposed).toBeUndefined();
    expect(String(out.error)).toMatch(/grant does not allow/);
    expect((await q(`select 1 from channels`)).rows).toHaveLength(0);
    expect((await q(`select 1 from proposals`)).rows).toHaveLength(0);
  });

  it("the person's approval sends it exactly once", async () => {
    startChat.mockResolvedValue({ chatId: "chat-beyond", messageId: "m-b" });
    const out = await agentSendsTo(PERSON);
    await approve(out.proposalId as string);
    const again = await approve(out.proposalId as string);
    expect(again).toMatchObject({ alreadyApproved: true });
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(startChat).toHaveBeenCalledWith(
      ACCOUNT,
      "ACoMarie",
      "Hi from the agent"
    );
    expect(send).not.toHaveBeenCalled();
    expect(
      (await q(`select 1 from messages where channel_id=$1`, [out.channelId]))
        .rows
    ).toHaveLength(1);
  });
});

describe("LinkedIn reach: refused when filed, and recorded on the person (CRM wave 2, S4a)", () => {
  // Rows rule out: a first LinkedIn message to someone not connected (or
  // whose request still waits) filed as a draft that fails after approval;
  // a FAILED read refusing the draft or written as "not connected"; the reach
  // not landing on the person; relation.new not marking them connected; the
  // daily sweep writing for an account it could not read, or missing the
  // 21-day rule.
  const NOW = new Date("2026-11-04T12:00:00.000Z");
  const daysAgo = (d: number) =>
    new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
  const propsOf = async (id: string) =>
    (
      await q<{ properties: Record<string, unknown> }>(
        `select properties from entities where id=$1`,
        [id]
      )
    ).rows[0]!.properties;
  const profileSays = (extra: Record<string, unknown>) =>
    getProfile.mockResolvedValue({
      providerId: "ACoMarie",
      publicIdentifier: "marie-dupont",
      name: "Marie Dupont",
      ...extra,
    });
  /** A person the pod knows by their LinkedIn member id. */
  async function personWithMemberId(
    memberId: string,
    properties: Record<string, unknown> = {}
  ) {
    const id = randomUUID();
    await q(
      `insert into entities (id, user_id, type, title, properties, created_at, updated_at) values ($1,$2,'person',$3,$4,now(),now())`,
      [id, OWNER, `Person ${memberId}`, JSON.stringify(properties)]
    );
    await q(
      `insert into entity_identity_signals (id, entity_id, signal_type, signal_value, source, created_at) values ($1,$2,'external_id',$3,'test',now())`,
      [randomUUID(), id, `linkedin:${memberId}`]
    );
    return id;
  }

  beforeEach(async () => {
    await q(`update entities set properties = $2 where id = $1`, [
      PERSON,
      JSON.stringify({
        linkedinUrl: "https://www.linkedin.com/in/marie-dupont",
      }),
    ]);
  });

  it("not connected: refused when filed with the next step named; nothing filed, nothing sent; the person is 'none'", async () => {
    profileSays({
      networkDistance: "SECOND_DEGREE",
      connection: "not_connected",
      relationRequest: null,
    });
    const out = await appSendsTo(PERSON);
    expect(out).toMatchObject({ success: false, errorClass: "not_connected" });
    expect(out.error).toMatch(/not one of your Linkedin connections yet/i);
    expect(out.error).toMatch(/Ask to connect first/);
    expect(out).not.toHaveProperty("proposalId");
    expect((await q(`select 1 from proposals`)).rows).toHaveLength(0);
    expect(startChat).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect((await propsOf(PERSON)).linkedinConnection).toBe("none");
  });

  it("a request still waiting: refused when filed, saying so; the person is pending since the request's date", async () => {
    profileSays({
      networkDistance: "SECOND_DEGREE",
      connection: "pending",
      relationRequest: {
        direction: "sent",
        status: "pending",
        sentAt: daysAgo(3),
      },
    });
    const out = await appSendsTo(PERSON);
    expect(out).toMatchObject({ success: false, errorClass: "not_connected" });
    expect(out.error).toMatch(
      /has not accepted your Linkedin connection request yet/i
    );
    expect((await q(`select 1 from proposals`)).rows).toHaveLength(0);
    expect(await propsOf(PERSON)).toMatchObject({
      linkedinConnection: "pending",
      linkedinInvitedAt: daysAgo(3),
    });
  });

  it("LinkedIn could not be read: filed as before (never refused, never 'not connected'); approval reads again and sends", async () => {
    getProfile.mockRejectedValueOnce(
      new Error("Unipile getProfile failed: 503 — upstream down")
    );
    startChat.mockResolvedValue({ chatId: "chat-s4a", messageId: "m-s4a" });
    const out = await appSendsTo(PERSON);
    expect(out).toMatchObject({ proposed: true });
    expect(await propsOf(PERSON)).not.toHaveProperty("linkedinConnection");
    expect(startChat).not.toHaveBeenCalled();
    await approve(out.proposalId as string);
    expect(startChat).toHaveBeenCalledTimes(1);
    expect((await propsOf(PERSON)).linkedinConnection).toBe("connected");
  });

  it("connected: filed, and the person is recorded connected", async () => {
    const out = await appSendsTo(PERSON);
    expect(out).toMatchObject({ proposed: true });
    expect((await propsOf(PERSON)).linkedinConnection).toBe("connected");
  });

  it("an approved send is not checked again at filing: one profile read, at dispatch", async () => {
    startChat.mockResolvedValue({ chatId: "chat-once", messageId: "m-once" });
    const out = await appSendsTo(PERSON);
    getProfile.mockClear();
    await approve(out.proposalId as string);
    expect(getProfile).toHaveBeenCalledTimes(1);
  });

  it("relation.new marks the person connected, found by their member id; an unknown member or account writes nothing", async () => {
    const { recordAcceptedRelation } =
      await import("../services/connectors/linkedin-reach-sync.js");
    const ada = await personWithMemberId("ACoAdaS4a", {
      linkedinConnection: "pending",
      linkedinInvitedAt: daysAgo(5),
    });
    expect(
      await recordAcceptedRelation({
        accountExternalId: ACCOUNT,
        provider: "linkedin",
        providerId: "ACoAdaS4a",
        publicIdentifier: null,
        connector: { getProfile },
        now: NOW,
      })
    ).toBe(ada);
    expect(await propsOf(ada)).toMatchObject({
      linkedinConnection: "connected",
      linkedinInvitedAt: daysAgo(5),
    });
    expect(
      await recordAcceptedRelation({
        accountExternalId: ACCOUNT,
        provider: "linkedin",
        providerId: "ACoNobody",
        publicIdentifier: null,
        connector: { getProfile },
      })
    ).toBeNull();
    expect(
      await recordAcceptedRelation({
        accountExternalId: "acc-unknown",
        provider: "linkedin",
        providerId: "ACoAdaS4a",
        publicIdentifier: null,
        connector: { getProfile },
      })
    ).toBeNull();
    // Never a paid lookup to find someone.
    expect(getProfile).not.toHaveBeenCalled();
  });

  it("the daily sweep: sent requests mark pending with their date; 21 days pending is ignored; an unreadable account writes nothing", async () => {
    const { runLinkedinReachSweep } =
      await import("../services/connectors/linkedin-reach-sync.js");
    const OTHER = "acc-linkedin-broken";
    await q(
      `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, created_at, updated_at)
       values ($1,$2,'linkedin',$3,'Second LinkedIn','connected',now(),now())`,
      [randomUUID(), OWNER, OTHER]
    );
    const fresh = await personWithMemberId("ACoFresh");
    const stale = await personWithMemberId("ACoStale");
    const storedOld = await personWithMemberId("ACoStoredOld", {
      linkedinConnection: "pending",
      linkedinInvitedAt: daysAgo(25),
    });
    const storedRecent = await personWithMemberId("ACoStoredRecent", {
      linkedinConnection: "pending",
      linkedinInvitedAt: daysAgo(2),
    });
    const onBroken = await personWithMemberId("ACoOnBroken");
    const pages: Record<string, Array<Record<string, unknown>>> = {
      "": [
        {
          id: "inv-1",
          providerId: "ACoFresh",
          publicIdentifier: null,
          name: "Fresh",
          sentAt: daysAgo(3),
        },
      ],
      "page-2": [
        {
          id: "inv-2",
          providerId: "ACoStale",
          publicIdentifier: null,
          name: "Stale",
          sentAt: daysAgo(30),
        },
        {
          id: "inv-3",
          providerId: "ACoNotInPod",
          publicIdentifier: null,
          name: "Stranger",
          sentAt: daysAgo(1),
        },
      ],
    };
    const listSentInvitations = vi.fn(
      async (accountId: string, cursor?: string) => {
        if (accountId === OTHER)
          throw new Error("Unipile listSentInvitations failed: 503");
        const key = cursor ?? "";
        return {
          invitations: pages[key] ?? [],
          ...(key === "" ? { nextCursor: "page-2" } : {}),
        };
      }
    );
    const result = await runLinkedinReachSweep({
      connector: { ...fakeUnipile(), listSentInvitations } as never,
      now: NOW,
    });
    expect(result).toMatchObject({
      configured: true,
      accountsRead: 1,
      accountsFailed: 1,
      invitations: 3,
    });
    expect(await propsOf(fresh)).toMatchObject({
      linkedinConnection: "pending",
      linkedinInvitedAt: daysAgo(3),
    });
    expect(await propsOf(stale)).toMatchObject({
      linkedinConnection: "ignored",
      linkedinInvitedAt: daysAgo(30),
    });
    expect((await propsOf(storedOld)).linkedinConnection).toBe("ignored");
    expect((await propsOf(storedRecent)).linkedinConnection).toBe("pending");
    expect(await propsOf(onBroken)).not.toHaveProperty("linkedinConnection");
    expect(result.peopleIgnored).toBeGreaterThanOrEqual(1);
  });
});
