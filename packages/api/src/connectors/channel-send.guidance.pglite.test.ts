/**
 * A send drafted in a playbook run carries the RULES the run used, and a TRIAL
 * run never sends (design b199a3a4, slice 1b).
 *
 * The REAL `messaging.send` builtin, the REAL send door
 * (`sendExternalMessage` → `gateMessagingSend` → the real capability gate),
 * the REAL `messaging.external.send` approval executor and the REAL
 * `insertChannelMessage`, on PGlite. Stubbed as in `channel-send.pglite.test.ts`:
 * the provider (a fake Unipile), the side-effect fan-out, the proposal
 * insert's notification fan-out, the person-readable read.
 *
 * Rows rule out:
 *   - a send filed in a run's session with no `data.guidance`, or a stamp the
 *     caller (the AI) supplied instead of the one the POD read from the run;
 *   - the approved send losing it on the sent message (`metadata.guidance`);
 *   - a run that could not read its rules reading as "no rules";
 *   - a trial run's session filing or sending a message, through the verb or
 *     the capability gate; a read in it refused.
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
import { BUILTIN_VERBS } from "../services/capabilities/builtin-verbs.js";
import { proposalExecRegistry } from "../routers/proposals/execution-registry.js";
import { registerMessagingExecutors } from "../routers/proposals/executors/messaging.js";
import { gateCapabilityExecution } from "../services/capabilities/gate-capability-execution.js";
import { TRIAL_RUN_WRITE_REFUSED } from "@synap/capability-gate";

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
const PLAYBOOK = randomUUID();
const ACCOUNT = "acc-linkedin-1";

const send = vi.fn();
const startChat = vi.fn();
const getProfile = vi.fn();

const handler = () => BUILTIN_VERBS["messaging.send"]!;
const executor = () =>
  proposalExecRegistry.resolveExact("messaging.external.send")!;

/** What the run used, as the executor stamps it on `definition_snapshot`. */
const USED = [
  {
    ref: "kind:brand-voice-guide",
    label: "Voice",
    hash: "h-voice",
    rows: [{ id: randomUUID(), version: "3" }],
  },
  {
    ref: "kind:outreach-angle",
    label: "By kind of lead",
    hash: "h-angle",
    rows: [{ id: randomUUID(), version: "1" }],
  },
];

async function session(metadata: Record<string, unknown> = {}) {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, created_at, updated_at)
     values ($1,$2,'Draft the first message','active',$3::jsonb,now(),now())`,
    [id, OWNER, JSON.stringify(metadata)]
  );
  return id;
}

async function runIn(sessionId: string, guidance: Record<string, unknown>) {
  const id = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, definition_snapshot)
     values ($1,$2,$3,'is-agent','running','{}'::jsonb,$4,$5::jsonb)`,
    [id, PLAYBOOK, sessionId, OWNER, JSON.stringify({ version: 1, guidance })]
  );
  return id;
}

/** An agent with no capability grant: its send is filed, never sent. */
function agentSends(sessionId: string, extra: Record<string, unknown> = {}) {
  return handler()(
    { to: PERSON, content: "Hi Marie, saw your brief on Malt.", ...extra },
    {
      userId: OWNER,
      workspaceId: CRM,
      agentUserId: AGENT,
      sessionId,
      // What execute-capability hands a self-gated verb for an agent.
      mustPropose: true,
      governanceReason: "CAPABILITY_PROPOSE",
    }
  ) as Promise<Record<string, unknown>>;
}

async function proposal(id: string) {
  const [row] = (
    await q<Record<string, unknown>>(
      `select id, workspace_id as "workspaceId", session_id as "sessionId",
              target_type as "targetType", target_id as "targetId", proposal_type as "proposalType",
              agent_user_id as "agentUserId", data from proposals where id=$1`,
      [id]
    )
  ).rows;
  return row as { data: Record<string, unknown> } & Record<string, unknown>;
}

async function approve(proposalId: string) {
  const row = await proposal(proposalId);
  return executor().execute({
    proposal: row as never,
    payload: row.data as never,
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
    `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, created_at, updated_at)
     values ($1,$2,'linkedin',$3,'Antoine on LinkedIn','connected',now(),now())`,
    [randomUUID(), OWNER, ACCOUNT]
  );
});

beforeEach(async () => {
  h.connector = {
    requiresAccount: () => true,
    sendMessage: send,
    startChat,
    getProfile,
  };
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
  await h.client!.exec(
    `delete from messages; delete from proposals; delete from channels; delete from tools;`
  );
});

describe("a send drafted in a playbook run carries the rules the run used", () => {
  it("the POD stamps the run's rules on the proposed message, and the sent message keeps them", async () => {
    const sessionId = await session();
    const runId = await runIn(sessionId, {
      declared: [{ ref: "kind:brand-voice-guide" }],
      status: "ok",
      hash: "h-section",
      used: USED,
      demoted: [],
      missing: [],
    });
    const out = await agentSends(sessionId);
    expect(out).toMatchObject({ proposed: true });
    const filed = await proposal(out.proposalId as string);
    expect(filed.data.guidance).toEqual({
      status: "ok",
      runId,
      playbookId: PLAYBOOK,
      hash: "h-section",
      used: USED,
    });
    // Next to who drafted it.
    expect(filed.data.draftedBy).toEqual({
      agentUserId: AGENT,
      appClientId: null,
    });

    startChat.mockResolvedValue({ chatId: "chat-g1", messageId: "msg-g1" });
    await approve(out.proposalId as string);
    expect(startChat).toHaveBeenCalledTimes(1);
    const [sent] = (
      await q<{ metadata: Record<string, unknown> }>(
        `select metadata from messages where channel_id=$1`,
        [out.channelId]
      )
    ).rows;
    expect(sent!.metadata.guidance).toEqual(filed.data.guidance);
    expect(sent!.metadata).toMatchObject({
      proposalId: out.proposalId,
      draftedBy: { agentUserId: AGENT },
    });
  });

  it("a stamp the caller passes is ignored: only the run's record counts", async () => {
    const sessionId = await session();
    await runIn(sessionId, {
      status: "ok",
      hash: "h-section",
      used: USED,
      demoted: [],
      missing: [],
    });
    const out = await agentSends(sessionId, {
      guidance: { status: "ok", used: [{ ref: "kind:made-up" }] },
    });
    const filed = await proposal(out.proposalId as string);
    expect((filed.data.guidance as { used: unknown }).used).toEqual(USED);
  });

  it("a run that could not read its rules is stamped unavailable, never left blank", async () => {
    const sessionId = await session();
    const runId = await runIn(sessionId, {
      status: "unavailable",
      error: "relation does not exist",
    });
    const out = await agentSends(sessionId);
    const filed = await proposal(out.proposalId as string);
    expect(filed.data.guidance).toEqual({
      status: "unavailable",
      runId,
      error: "relation does not exist",
    });
  });

  it("a session that is no run, or a run with no rule, stamps nothing", async () => {
    const plain = await session();
    const a = await agentSends(plain);
    expect((await proposal(a.proposalId as string)).data).not.toHaveProperty(
      "guidance"
    );
    const noRules = await session();
    await runIn(noRules, {
      status: "ok",
      hash: null,
      used: [],
      demoted: [],
      missing: [],
    });
    const b = await agentSends(noRules);
    expect((await proposal(b.proposalId as string)).data).not.toHaveProperty(
      "guidance"
    );
  });
});

describe("a TRIAL run (the rule lab) never sends", () => {
  const trial = {
    trial: { guidanceOverride: { [randomUUID()]: randomUUID() } },
  };

  it("messaging.send in a trial session is refused: nothing filed, nothing sent", async () => {
    const sessionId = await session(trial);
    const out = await agentSends(sessionId);
    expect(out.success).toBe(false);
    expect(out.proposed).toBeUndefined();
    expect(String(out.error)).toContain("trial run");
    expect((await q(`select id from proposals`)).rows).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });

  it("refused even where a rule or a grant would let the send run", async () => {
    h.gateSaysRun = true;
    const sessionId = await session(trial);
    const out = await agentSends(sessionId);
    expect(out.success).toBe(false);
    expect((await q(`select id from proposals`)).rows).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
  });

  it("the capability gate refuses a write in a trial session and runs a read", async () => {
    const sessionId = await session(trial);
    const write = await gateCapabilityExecution({
      capabilityKind: "skill",
      capabilityId: randomUUID(),
      skill: { id: randomUUID(), approved: true, userId: OWNER, name: "x" },
      actorUserId: OWNER,
      agentUserId: AGENT,
      sessionId,
    } as never);
    expect(write).toMatchObject({
      decision: "deny",
      reasonCode: TRIAL_RUN_WRITE_REFUSED,
    });
    const read = await gateCapabilityExecution({
      capabilityKind: "skill",
      capabilityId: randomUUID(),
      skill: { id: randomUUID(), approved: true, userId: OWNER, name: "x" },
      actorUserId: OWNER,
      agentUserId: AGENT,
      sessionId,
      readOnly: true,
    } as never);
    expect(read).toEqual({ decision: "run" });
    // The same write outside a trial is not refused by this rung.
    const plain = await gateCapabilityExecution({
      capabilityKind: "skill",
      capabilityId: randomUUID(),
      skill: { id: randomUUID(), approved: true, userId: OWNER, name: "x" },
      actorUserId: OWNER,
      sessionId: await session(),
    } as never);
    expect(plain).toEqual({ decision: "run" });
  });
});
