/**
 * A space-limited key sends only to people of its space (channels wave,
 * lane D, security review): the REAL `messaging.send` builtin, the REAL send
 * door and its grant check (`messagingSendGrantVerdict`), and the REAL
 * person-readable read (`readableRecipient`: the entity floor plus the key's
 * grant clause, `access/grant-read.ts`), all on PGlite. Nothing about who may
 * read whom is stubbed. Stubbed: the provider connector (never reached), the
 * side-effect fan-out, the proposal insert's notification plumbing (the row is
 * real).
 *
 * Fixture (lane A's): LEA is a pod-wide person, a lead in CRM; ELI a pod-wide
 * person, a lead in OTHER. Each has a LinkedIn channel. The CRM app's key may
 * read people and run send_message in CRM only.
 *
 * Rows rule out:
 *   - the CRM key writing to someone it cannot read (a person of OTHER);
 *   - the CRM key sending on another space's person channel by its id;
 *   - the CRM key refused for its own space's person (pod-wide channel);
 *   - the CRM key refused, by channel id, on its own person's channel stamped
 *     with another space ("Channel is not in the acting workspace": a
 *     person's channel follows the person, decisions d3/d7);
 *   - a channel bound to no person losing that acting-space check.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
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
    sent: 0,
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
  getMessagingConnector: async () => ({
    requiresAccount: () => true,
    sendMessage: async () => {
      h.sent++;
      return { messageId: "never" };
    },
  }),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../utils/domain-mutation.js", () => ({
  recordDomainMutation: async () => ({ id: "evt" }),
}));
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: Record<string, unknown>) => {
    const id = randomUUID();
    await h.client!.query(
      `insert into proposals (id, proposed_by_user_id, created_by, workspace_id, target_type, target_id, proposal_type, status, data, agent_user_id, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,now(),now())`,
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
      ]
    );
    return { id };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithGrant } from "@synap/database";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../access/grant-read.js";
import { BUILTIN_VERBS } from "../services/capabilities/builtin-verbs.js";
import { sendExternalMessage } from "./external-dispatch.js";

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
    const def =
      c.name === "created_at" ||
      c.name === "updated_at" ||
      c.name === "timestamp"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : c.name === "ephemeral"
            ? " default false"
            : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const CRM = randomUUID();
const OTHER = randomUUID();
const PERSON_KIND = randomUUID();
const ROLE_LEAD = randomUUID();
const LEA = randomUUID();
const ELI = randomUUID();
const CH_LEA = randomUUID();
const CH_ELI = randomUUID();
const MIA = randomUUID(); // a lead of CRM whose channel is stamped OTHER
const CH_MIA = randomUUID();
const CH_TEAM = randomUUID(); // an external channel of OTHER, no person

/** The CRM app's key: reads people and sends in CRM only. */
const CRM_KEY = {
  scopes: [
    {
      permissions: [
        "entity.*.read",
        "channel.read",
        "capability.send_message.run",
      ],
      workspaceIds: [CRM],
    },
  ],
  clientId: "crm-app",
};
/** The same app with a pod-wide key. */
const FULL_KEY = {
  scopes: [{ permissions: ["*"], workspaceIds: null }],
  clientId: "crm-app",
};

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    OWNER,
    "owner@example.test",
  ]);
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), OWNER]
  );
  for (const [ws, name] of [
    [CRM, "CRM"],
    [OTHER, "Other"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, name, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id) values
       ($1,'person','Person','kind','system','pod',true,'{}'::jsonb,null),
       ($2,'lead','Lead','role','workspace','workspace',true,'{}'::jsonb,null)`,
    [PERSON_KIND, ROLE_LEAD]
  );
  for (const [id, title, ws, ch, chat, chWs] of [
    [LEA, "Lea Lead", CRM, CH_LEA, "chat-lea", null],
    [ELI, "Eli Elsewhere", OTHER, CH_ELI, "chat-eli", null],
    [MIA, "Mia Mixed", CRM, CH_MIA, "chat-mia", OTHER],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,null,$3,'person',$4,'{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, PERSON_KIND, title]
    );
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties)
       values ($1,$2,$3,$4,$5,'{}'::jsonb)`,
      [randomUUID(), id, ROLE_LEAD, OWNER, ws]
    );
    await q(
      `insert into channels (id, user_id, workspace_id, title, channel_type, scope, status,
         context_object_type, context_object_id, external_source, external_channel_id, external_id, metadata, ai_reaction_mode)
       values ($1,$2,$6,$3,'external','pod','active','entity',$4,'linkedin',$5,$5,
         '{"accountId":"acc-1","participantExternalId":"ACoAAA"}'::jsonb,'when_confident')`,
      [ch, OWNER, title, id, chat, chWs]
    );
  }
  await q(
    `insert into channels (id, user_id, workspace_id, title, channel_type, scope, status,
       external_source, external_channel_id, external_id, metadata, ai_reaction_mode)
     values ($1,$2,$3,'Team','external','workspace','active','linkedin','chat-team','chat-team',
       '{"accountId":"acc-1"}'::jsonb,'when_confident')`,
    [CH_TEAM, OWNER, OTHER]
  );
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status)
     values ($1,$2,'linkedin','acc-1','Owner on LinkedIn','connected')`,
    [randomUUID(), OWNER]
  );
}, 120_000);

const handler = () => BUILTIN_VERBS["messaging.send"]!;

function appSends(to: string, grant: typeof CRM_KEY | typeof FULL_KEY) {
  return runWithGrant(grant, () =>
    handler()(
      { to, text: "Hello" },
      {
        userId: OWNER,
        workspaceId: CRM,
        mustPropose: true,
        governanceReason: "APP_OUTWARD_INTENT",
      }
    )
  ) as Promise<Record<string, unknown>>;
}

const proposalsOn = async (channelId: string) =>
  (
    await q(`select 1 from proposals where data->>'channelId' = $1`, [
      channelId,
    ])
  ).rows.length;

describe("a space-limited key sends only to the people of its space", () => {
  it("the CRM key files a proposed message to a lead of CRM", async () => {
    const out = await appSends(LEA, CRM_KEY);
    expect(out).toMatchObject({ proposed: true, channelId: CH_LEA });
    expect(await proposalsOn(CH_LEA)).toBe(1);
  });

  it("the CRM key cannot write to a person of another space (not found)", async () => {
    await expect(appSends(ELI, CRM_KEY)).rejects.toThrow(/not found/i);
    expect(await proposalsOn(CH_ELI)).toBe(0);
  });

  it("the CRM key cannot send on another space's person channel by its id", async () => {
    const out = await runWithGrant(CRM_KEY, () =>
      sendExternalMessage({
        channelId: CH_ELI,
        accountId: "acc-1",
        body: "Hello",
        userId: OWNER,
        workspaceId: CRM,
        mustPropose: true,
      })
    );
    expect(out.success).toBe(false);
    expect(String(out.error)).toMatch(/grant does not allow/);
    expect(await proposalsOn(CH_ELI)).toBe(0);
  });

  it("the CRM key sends on its person's channel by id, though the channel is stamped with another space", async () => {
    const out = (await runWithGrant(CRM_KEY, () =>
      handler()(
        { channelId: CH_MIA, text: "Hello" },
        {
          userId: OWNER,
          workspaceId: CRM,
          mustPropose: true,
          governanceReason: "APP_OUTWARD_INTENT",
        }
      )
    )) as Record<string, unknown>;
    expect(out).toMatchObject({ proposed: true, channelId: CH_MIA });
    expect(await proposalsOn(CH_MIA)).toBe(1);
    expect(h.sent).toBe(0);
  });

  it("a channel bound to no person stays in the acting space", async () => {
    await expect(
      handler()(
        { channelId: CH_TEAM, text: "Hello" },
        { userId: OWNER, workspaceId: CRM }
      )
    ).rejects.toThrow(/not in the acting workspace/);
    expect(await proposalsOn(CH_TEAM)).toBe(0);
  });

  it("a pod-wide key reaches the same person (the refusal is the space, not the person)", async () => {
    const out = await appSends(ELI, FULL_KEY);
    expect(out).toMatchObject({ proposed: true, channelId: CH_ELI });
    expect(h.sent).toBe(0);
  });
});
