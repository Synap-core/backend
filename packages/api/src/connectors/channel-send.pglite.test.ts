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
 * (`readableRecipient`, the access layer's own tests cover it) and lane C's
 * `openPersonChannel` (a faithful stand-in until lane C lands).
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
 *   - `external_message.sent` not reaching the automations fan-out.
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
      `insert into proposals (id, user_id, created_by, workspace_id, target_type, target_id, proposal_type, status, data, agent_user_id, governance_reason, created_at, updated_at)
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
vi.mock(
  "../services/capabilities/execute-capability.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    assertApprovalTargetResolves: async () => null,
  })
);
// Lane C's door (services/connectors/inbound-recorder.ts), its contract:
// the person's channel on (user, tool, account), else a PENDING one.
vi.mock(
  "../services/connectors/inbound-recorder.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    openPersonChannel: async (args: {
      userId: string;
      entityId: string;
      provider: string;
      accountId?: string | null;
    }) => {
      const found = await h.client!.query<{
        id: string;
        external_id: string | null;
      }>(
        `select id, external_id from channels where user_id=$1 and channel_type='external'
         and external_source=$2 and context_object_type='entity' and context_object_id=$3
         and status='active' and coalesce(metadata->>'accountId','')=$4
       order by (external_id is not null) desc limit 1`,
        [args.userId, args.provider, args.entityId, args.accountId ?? ""]
      );
      if (found.rows[0])
        return {
          channelId: found.rows[0].id,
          externalId: found.rows[0].external_id,
          created: false,
        };
      const id = randomUUID();
      await h.client!.query(
        `insert into channels (id, user_id, channel_type, scope, status, title, context_object_type, context_object_id, external_source, metadata, created_at, updated_at)
       values ($1,$2,'external','pod','active','Marie Dupont','entity',$3,$4,$5,now(),now())`,
        [
          id,
          args.userId,
          args.entityId,
          args.provider,
          JSON.stringify(args.accountId ? { accountId: args.accountId } : {}),
        ]
      );
      return { channelId: id, externalId: null, created: true };
    },
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
      `select id, user_id as "userId", workspace_id as "workspaceId", session_id as "sessionId",
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
  for (const t of Object.values(schema)) {
    try {
      getTableConfig(t as PgTable);
    } catch {
      continue;
    }
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await h.client!.exec(
    `create unique index channels_ext_uniq on channels (external_source, external_id) where external_id is not null;
     create unique index messages_channel_ext_msg_uniq on messages (channel_id, external_message_id) where external_message_id is not null;`
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
    `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, created_at, updated_at)
     values ($1,$2,'linkedin',$3,'Antoine on LinkedIn','connected',now(),now())`,
    [randomUUID(), OWNER, ACCOUNT]
  );
});

beforeEach(async () => {
  h.connector = fakeUnipile();
  h.events.length = 0;
  h.readable = new Set([PERSON]);
  send.mockReset();
  startChat.mockReset();
  getProfile.mockReset();
  getProfile.mockResolvedValue({
    providerId: "ACoMarie",
    publicIdentifier: "marie-dupont",
    name: "Marie Dupont",
    networkDistance: "FIRST_DEGREE",
  });
  // Every test starts from a person with no channel and no proposal.
  await h.client!.exec(
    `delete from messages; delete from proposals; delete from channels;`
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

async function appSendsTo(person: string, grant = crmApp) {
  return runWithGrant(grant, () =>
    handler()(
      { to: person, text: "Hello Marie" },
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
  it("files the proposed message through the real gate; the provider is never called", async () => {
    const out = (await handler()(
      { to: PERSON, content: "Hi from the agent" },
      { userId: OWNER, workspaceId: CRM, agentUserId: AGENT }
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

  it("not a 1st-degree connection: refused not_connected BEFORE any send; the claim is released", async () => {
    getProfile.mockResolvedValue({
      providerId: "ACoMarie",
      publicIdentifier: "marie-dupont",
      name: "Marie Dupont",
      networkDistance: "SECOND_DEGREE",
    });
    const out = await appSendsTo(PERSON);
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
