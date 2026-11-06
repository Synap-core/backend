/**
 * A space's conversations and the person's own send (CRM Messages contract
 * b4f8c2cd, A, B and D) through the REAL hub auth door (its W1 fence +
 * `runWithGrant`), the REAL routes, the REAL send door
 * (`sendExternalMessage`, its grant verdict and capability gate), the REAL
 * revise core and the REAL `messaging.external.send` executor behind the
 * REAL approval dispatch tail, all on PGlite. Stubbed: the key lookup, the
 * guest check, the provider connector (a fake Unipile), the side-effect
 * fan-out, the proposal insert's notification plumbing (the row is real),
 * and the tRPC `proposals.approve` procedure's own preamble: the route's
 * caller runs `dispatchProposalApproval` with the real executor and the
 * failure write `apply-approval` makes (that procedure's checks have their
 * own tests); and the revise core's reviewer ladder (see its mock).
 *
 * Rows rule out:
 *   - Messages capped at a few people: one read lists every person in the
 *     space with a channel or an open send, paged without loss or overlap;
 *   - someone else's person (a facet in another space) listed, or a space
 *     the key may not read answered;
 *   - a lead whose role facet is POD-WIDE (granted to the space) left out,
 *     or a pod-wide role the space was not granted let in;
 *   - a held draft or a failed send missing from the list, or shown as a
 *     plain draft;
 *   - the person's typed message lost when they are not reachable (it is
 *     kept as a held draft), or sent when it should be held;
 *   - a revised draft sending its OLD text;
 *   - an agent sending through the person's door.
 *
 * Cannot see: production Postgres, a real minted app token, a live Unipile
 * account, the tRPC approve procedure's preamble (presence, review ladder).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  getApiKeyStatus: vi.fn(),
  connector: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return {
    ...actual,
    db,
    getDb: async () => db,
    workerAutomationOfSession: async () => null,
  };
});
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => h.getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));
vi.mock("../../../connectors/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMessagingConnector: async () => h.connector,
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: async () => ({ id: "evt" }),
}));
// The proposal ROW is real; only the notification / dedup / session plumbing
// of the one insert door is left out.
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
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
vi.mock(
  "../../../services/capabilities/execute-capability.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    assertApprovalTargetResolves: async () => null,
  })
);
// The reviewer ladder of the revise core: it reads through the shared pool
// INSIDE the revise transaction, which a single-connection PGlite cannot
// serve (it would wait on itself). The person owns the space here; the
// ladder has its own tests.
vi.mock("../../proposals/review-authority.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  computeCanReviewApproval: async () => ({ allowed: true }),
}));
// The approve procedure: the REAL dispatch tail and executor, and the
// failure write `apply-approval` makes on a throw.
vi.mock("../../proposals.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    proposalsRouter: {
      createCaller: (ctx: { userId: string }) => ({
        approve: async (input: { proposalId: string }) => {
          const { dispatchProposalApproval } =
            await import("../../proposals/execution-registry.js");
          const { transitionProposal, eq, proposals } =
            await import("@synap/database");
          const { ProposalStatus } = await import("@synap/database/schema");
          const row = (
            await h.client!.query<Record<string, unknown>>(
              `select id, workspace_id as "workspaceId", session_id as "sessionId",
                      target_type as "targetType", target_id as "targetId", proposal_type as "proposalType",
                      agent_user_id as "agentUserId", data from proposals where id=$1`,
              [input.proposalId]
            )
          ).rows[0]!;
          return dispatchProposalApproval(
            {
              proposal: row as never,
              payload: row.data as never,
              userId: ctx.userId,
              input: { proposalId: input.proposalId } as never,
              ctx: {} as never,
              deps: {
                emitProposalReviewed: () => undefined,
                reportProposalOutcome: () => undefined,
              } as never,
            },
            async (id, message) => {
              await transitionProposal(h.db as never, {
                to: ProposalStatus.APPROVAL_FAILED,
                set: { rejectionReason: message },
                where: eq(proposals.id, id),
              });
            }
          );
        },
      }),
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import "../../../access/grant-read.js";
import { registerMessagingExecutors } from "../../proposals/executors/messaging.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerChannelConversationsRoutes } from "./channel-conversations.js";
import { registerChannelsRoutes } from "./channels.js";
import type { HubHono, HubVariables } from "./_shared.js";

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
    const def =
      c.name === "created_at" ||
      c.name === "updated_at" ||
      c.name === "timestamp"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : c.name === "ephemeral"
            ? " default false"
            : c.name === "revision_history"
              ? " default '[]'::jsonb"
              : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID();
const AGENT = randomUUID();
const CRM = randomUUID();
const OTHER = randomUUID();
const PERSON_KIND = randomUUID();
const COMPANY_KIND = randomUUID();
const ROLE_LEAD = randomUUID();
const ACCOUNT = "acc-1";

// People in CRM: LEAD (a chat, 3 unread, a draft), NOCONN (a pending
// channel, a HELD draft), FAILED (a chat, a failed send), QUIET (a chat, no
// draft, nothing unread). ELSEWHERE is a lead in OTHER only.
const LEAD = randomUUID();
const NOCONN = randomUUID();
const FAILED = randomUUID();
const QUIET = randomUUID();
const ELSEWHERE = randomUUID();
const ACME = randomUUID();
const CH = {
  LEAD: randomUUID(),
  NOCONN: randomUUID(),
  FAILED: randomUUID(),
  QUIET: randomUUID(),
  ELSEWHERE: randomUUID(),
};
const P_LEAD = randomUUID();
const P_NOCONN = randomUUID();
const P_FAILED = randomUUID();
const P_OTHER = randomUUID(); // a draft to LEAD filed in OTHER: not the app's

const T = (min: number) =>
  new Date(Date.UTC(2026, 10, 1, 10, min)).toISOString();

interface Key {
  id: string;
  userId: string;
  linkedUserId: string | null;
  keyType: string;
  permissions: string[];
  workspaceIds: string[] | null;
  clientId: string | null;
}
const KEYS = {
  /** The CRM, signed in as the person (an official app's person token). */
  crm: {
    id: randomUUID(),
    userId: OWNER,
    linkedUserId: null,
    keyType: "app_person",
    permissions: [
      "entity.*.read",
      "channel.read",
      "proposal.read",
      "proposal.approve",
      "capability.send_message.run",
    ],
    workspaceIds: [CRM],
    clientId: "crm-app",
  },
  /** The same app connected as its agent. */
  agent: {
    id: randomUUID(),
    userId: AGENT,
    linkedUserId: OWNER,
    keyType: "hub_inbound",
    permissions: ["entity.*.read", "channel.read", "proposal.read"],
    workspaceIds: [CRM],
    clientId: "crm-app",
  },
  /** The owner, unbounded. */
  full: {
    id: randomUUID(),
    userId: OWNER,
    linkedUserId: null,
    keyType: "hub_inbound",
    permissions: ["*"],
    workspaceIds: null,
    clientId: null,
  },
} satisfies Record<string, Key>;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const sendMessage = vi.fn();
const startChat = vi.fn();
const getProfile = vi.fn();

async function draft(
  id: string,
  ws: string,
  channelId: string,
  entityId: string,
  at: string,
  extra: { status?: string; data?: object; reason?: string } = {}
) {
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status,
       created_by, agent_user_id, subject_user_id, rejection_reason, revision_history, created_at, updated_at)
     values ($1,$2,'messaging',$3,'messaging.external.send',$4::jsonb,$5,$6,$7,$6,$8,'[]'::jsonb,$9,$9)`,
    [
      id,
      ws,
      channelId,
      JSON.stringify({
        channelId,
        entityId,
        provider: "linkedin",
        platform: "linkedin",
        accountId: ACCOUNT,
        body: "Hello there\nsecond line",
        ...(extra.data ?? {}),
      }),
      extra.status ?? "pending",
      OWNER,
      AGENT,
      extra.reason ?? null,
      at,
    ]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await h.client!.exec(
    `create unique index channels_ext_uniq on channels (external_source, external_id) where external_id is not null;
     create unique index messages_channel_ext_msg_uniq on messages (channel_id, external_message_id) where external_message_id is not null;`
  );

  await q(
    `insert into users (id, email, user_type, name) values ($1,$2,'human','Owner')`,
    [OWNER, "owner@example.test"]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id, name) values ($1,$2,'agent',$3,'CRM agent')`,
    [AGENT, "agent@example.test", OWNER]
  );
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
       ($2,'company','Company','kind','system','pod',true,'{}'::jsonb,null),
       ($3,'lead','Lead','role','workspace','workspace',true,'{}'::jsonb,null)`,
    [PERSON_KIND, COMPANY_KIND, ROLE_LEAD]
  );
  const people: Array<[string, string, string, object]> = [
    [
      LEAD,
      "Lea Lead",
      CRM,
      { linkedinProviderId: "ACoLea", linkedinConnection: "connected" },
    ],
    [
      NOCONN,
      "Nora Noconn",
      CRM,
      { linkedinUrl: "https://www.linkedin.com/in/nora" },
    ],
    [FAILED, "Fay Failed", CRM, {}],
    [QUIET, "Quinn Quiet", CRM, {}],
    [ELSEWHERE, "Eli Elsewhere", OTHER, {}],
  ];
  for (const [id, title, ws, props] of people) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,null,$3,'person',$4,$5::jsonb,'{}'::jsonb)`,
      [id, OWNER, PERSON_KIND, title, JSON.stringify(props)]
    );
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties)
       values ($1,$2,$3,$4,$5,'{}'::jsonb)`,
      [randomUUID(), id, ROLE_LEAD, OWNER, ws]
    );
  }
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
     values ($1,$2,$3,$4,'company','Acme','{}'::jsonb,'{}'::jsonb)`,
    [ACME, OWNER, CRM, COMPANY_KIND]
  );
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, created_at)
     values ($1,$2,$3,$4,$5,'works_at',now())`,
    [randomUUID(), OWNER, CRM, LEAD, ACME]
  );
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, created_at, updated_at)
     values ($1,$2,'linkedin',$3,'Me on LinkedIn','connected',now(),now())`,
    [randomUUID(), OWNER, ACCOUNT]
  );
  for (const [key, entityId, chat] of [
    ["LEAD", LEAD, "chat-lead"],
    ["NOCONN", NOCONN, null],
    ["FAILED", FAILED, "chat-failed"],
    ["QUIET", QUIET, "chat-quiet"],
    ["ELSEWHERE", ELSEWHERE, "chat-else"],
  ] as const) {
    await q(
      `insert into channels (id, user_id, workspace_id, title, channel_type, scope, status,
         context_object_type, context_object_id, external_source, external_channel_id, external_id, metadata, ai_reaction_mode, updated_at)
       values ($1,$2,null,null,'external','pod','active','entity',$3,'linkedin',$4,$4,$5::jsonb,'when_confident',$6)`,
      [
        CH[key],
        OWNER,
        entityId,
        chat,
        JSON.stringify({ accountId: ACCOUNT }),
        T(0),
      ]
    );
  }
  const msg = (
    channel: string,
    at: string,
    direction: "inbound" | "outbound",
    content: string
  ) =>
    q(
      `insert into messages (id, channel_id, role, author_type, message_category, content, user_id,
         timestamp, hash, ephemeral, direction, delivery_status, external_source, external_message_id)
       values ($1,$2,$3,$4,'chat',$5,$6,$7,$8,false,$9,$10,'linkedin',$11)`,
      [
        randomUUID(),
        channel,
        direction === "outbound" ? "assistant" : "user",
        direction === "outbound" ? "human" : "external",
        content,
        OWNER,
        at,
        `hash-${randomUUID()}`,
        direction,
        direction === "outbound" ? "sent" : null,
        `ext-${randomUUID()}`,
      ]
    );
  await msg(CH.LEAD, T(1), "outbound", "Hello Lea");
  for (const i of [0, 1, 2]) await msg(CH.LEAD, T(2), "inbound", `reply ${i}`);
  await msg(CH.QUIET, T(0), "outbound", "Hi Quinn");
  await msg(CH.ELSEWHERE, T(1), "inbound", "Eli's secret");

  await draft(P_LEAD, CRM, CH.LEAD, LEAD, T(3));
  await draft(P_NOCONN, CRM, CH.NOCONN, NOCONN, T(4), {
    data: {
      held: {
        errorClass: "not_connected",
        reason:
          "Nora Noconn is not one of your Linkedin connections yet. Ask to connect first.",
        at: T(4),
      },
    },
  });
  await draft(P_FAILED, CRM, CH.FAILED, FAILED, T(5), {
    status: "approval_failed",
    reason: "Couldn't apply — Linkedin refused the message.",
  });
  await draft(P_OTHER, OTHER, CH.LEAD, LEAD, T(6));

  for (const k of Object.values(KEYS)) {
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,$3,true)`,
      [k.id, k.userId, k.linkedUserId]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by, client_id)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4,$7)`,
      [
        randomUUID(),
        k.id,
        k.userId,
        OWNER,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
        k.clientId,
      ]
    );
  }
}, 120_000);

beforeEach(() => {
  h.connector = {
    requiresAccount: () => true,
    sendMessage,
    startChat,
    getProfile,
  };
  sendMessage.mockReset();
  startChat.mockReset();
  getProfile.mockReset();
  sendMessage.mockResolvedValue({ messageId: `sent-${randomUUID()}` });
  getProfile.mockResolvedValue({
    providerId: "ACoNora",
    publicIdentifier: "nora",
    name: "Nora Noconn",
    networkDistance: "SECOND_DEGREE",
    connection: "not_connected",
    relationRequest: null,
  });
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const key: Key = KEYS[bearer.replace(/^synap_/, "") as KeyName];
    return {
      status: "valid",
      record: {
        id: key.id,
        userId: key.userId,
        linkedUserId: key.linkedUserId,
        parentKeyId: null,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        keyType: key.keyType,
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  // As the served app wires them: the static /channels/<word> routes first.
  registerChannelConversationsRoutes(hub);
  registerChannelsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const get = (key: KeyName, path: string) =>
  app().request(`/api/hub${path}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });
const post = (key: KeyName, path: string, body: unknown) =>
  app().request(`/api/hub${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer synap_${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

interface Conversation {
  person: { id: string; name: string; company: { name: string } | null };
  channelIds: string[];
  lastMessage: { text: string; direction: string } | null;
  draft: {
    proposalId: string;
    firstLine: string;
    state: string;
    reason: string | null;
  } | null;
  unread: number;
  reach: Record<string, unknown>;
}
async function page(key: KeyName, query: string) {
  const res = await get(key, `/channels/conversations?${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    conversations: Conversation[];
    nextCursor: string | null;
  };
}

describe("GET /channels/conversations — every person in one read", () => {
  it("lists every person of the space with a channel or an open send, newest activity first, with draft state, unread, reach and company", async () => {
    const { conversations, nextCursor } = await page(
      "crm",
      `workspaceId=${CRM}`
    );
    expect(nextCursor).toBeNull();
    expect(conversations.map((c) => c.person.id)).toEqual([
      FAILED,
      NOCONN,
      LEAD,
      QUIET,
    ]);
    const by = Object.fromEntries(conversations.map((c) => [c.person.id, c]));
    expect(by[LEAD]).toMatchObject({
      person: { name: "Lea Lead", company: { name: "Acme" } },
      channelIds: [CH.LEAD],
      lastMessage: { direction: "inbound" },
      // The draft filed in CRM; the one in OTHER is outside the app's grant.
      draft: { proposalId: P_LEAD, firstLine: "Hello there", state: "draft" },
      unread: 3,
      reach: { linkedinConnection: "connected", hasProviderId: true },
    });
    expect(by[NOCONN]).toMatchObject({
      draft: {
        proposalId: P_NOCONN,
        state: "held",
        reason: expect.stringMatching(/Ask to connect first/),
      },
      lastMessage: null,
      reach: { hasLinkedinUrl: true, hasProviderId: false },
    });
    expect(by[FAILED]).toMatchObject({
      draft: {
        proposalId: P_FAILED,
        state: "failed",
        reason: expect.stringMatching(/refused/),
      },
    });
    expect(by[QUIET]).toMatchObject({ draft: null, unread: 0 });
  });

  it("SECURITY: a person whose only facet is in another space is never listed", async () => {
    for (const key of ["crm", "full"] as const) {
      const { conversations } = await page(key, `workspaceId=${CRM}`);
      expect(conversations.map((c) => c.person.id)).not.toContain(ELSEWHERE);
      expect(JSON.stringify(conversations)).not.toContain("Eli's secret");
    }
  });

  it("SECURITY: a key limited to CRM asking about another space is refused", async () => {
    const res = await get(
      "crm",
      `/channels/conversations?workspaceId=${OTHER}`
    );
    expect(res.status).toBe(403);
  });

  it("needsYou keeps the people a draft, a held draft, a failed send or an unread message waits on", async () => {
    const { conversations } = await page(
      "crm",
      `workspaceId=${CRM}&needsYou=true`
    );
    expect(conversations.map((c) => c.person.id)).toEqual([
      FAILED,
      NOCONN,
      LEAD,
    ]);
  });

  it("pages by cursor: every person once, none twice", async () => {
    const first = await page("crm", `workspaceId=${CRM}&limit=2`);
    expect(first.conversations.map((c) => c.person.id)).toEqual([
      FAILED,
      NOCONN,
    ]);
    expect(first.nextCursor).toBeTruthy();
    const second = await page(
      "crm",
      `workspaceId=${CRM}&limit=2&cursor=${first.nextCursor}`
    );
    expect(second.conversations.map((c) => c.person.id)).toEqual([LEAD, QUIET]);
    expect(second.nextCursor).toBeNull();
    expect(
      (
        await get(
          "crm",
          `/channels/conversations?workspaceId=${CRM}&cursor=bad`
        )
      ).status
    ).toBe(400);
  });
});

// Most leads on a real pod wear a POD-WIDE role facet (no workspace) whose
// role is granted to the CRM space, not a facet stamped in it; their LinkedIn
// channel is stamped wherever the connector filed it (the Pod Admin space on
// the founder's pod). The door must list them as the CRM's own lead lists do
// (`roleInSpacesWhere`), and still keep out a pod-wide role the space was
// never granted.
describe("GET /channels/conversations — pod-wide leads", () => {
  const ROLE_INVESTOR = randomUUID();
  const POD_LEAD = randomUUID();
  const POD_INVESTOR = randomUUID();
  const CH_POD_LEAD = randomUUID();
  const CH_POD_INVESTOR = randomUUID();

  beforeAll(async () => {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
       values ($1,'investor','Investor','role','workspace','workspace',true,'{}'::jsonb,null)`,
      [ROLE_INVESTOR]
    );
    // The lead role is granted to CRM; the investor role to OTHER only.
    await q(
      `insert into profile_workspace_access (profile_id, workspace_id, granted_at) values ($1,$2,now()), ($3,$4,now())`,
      [ROLE_LEAD, CRM, ROLE_INVESTOR, OTHER]
    );
    for (const [id, title, role, channel, chat] of [
      [POD_LEAD, "Paul Podlead", ROLE_LEAD, CH_POD_LEAD, "chat-podlead"],
      [
        POD_INVESTOR,
        "Ivy Investor",
        ROLE_INVESTOR,
        CH_POD_INVESTOR,
        "chat-investor",
      ],
    ] as const) {
      await q(
        `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
         values ($1,$2,null,$3,'person',$4,'{}'::jsonb,'{}'::jsonb)`,
        [id, OWNER, PERSON_KIND, title]
      );
      // A POD-WIDE facet: no workspace.
      await q(
        `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties)
         values ($1,$2,$3,$4,null,'{}'::jsonb)`,
        [randomUUID(), id, role, OWNER]
      );
      // The channel stamped in ANOTHER space than the one asked about.
      await q(
        `insert into channels (id, user_id, workspace_id, title, channel_type, scope, status,
           context_object_type, context_object_id, external_source, external_channel_id, external_id, metadata, ai_reaction_mode, updated_at)
         values ($1,$2,$3,null,'external','workspace','active','entity',$4,'linkedin',$5,$5,$6::jsonb,'when_confident',$7)`,
        [
          channel,
          OWNER,
          OTHER,
          id,
          chat,
          JSON.stringify({ accountId: ACCOUNT }),
          T(0),
        ]
      );
      await q(
        `insert into messages (id, channel_id, role, author_type, message_category, content, user_id,
           timestamp, hash, ephemeral, direction, delivery_status, external_source, external_message_id)
         values ($1,$2,'user','external','chat',$3,$4,$5,$6,false,'inbound',null,'linkedin',$7)`,
        [
          randomUUID(),
          channel,
          `${title} says hi`,
          OWNER,
          T(7),
          `hash-${randomUUID()}`,
          `ext-${randomUUID()}`,
        ]
      );
    }
  });

  it("lists a person whose POD-WIDE role is granted to the space, with their channel stamped in another space", async () => {
    for (const key of ["crm", "full"] as const) {
      const { conversations } = await page(key, `workspaceId=${CRM}`);
      const lead = conversations.find((c) => c.person.id === POD_LEAD);
      expect(lead).toMatchObject({
        person: { name: "Paul Podlead" },
        channelIds: [CH_POD_LEAD],
        lastMessage: { text: "Paul Podlead says hi", direction: "inbound" },
        unread: 1,
      });
      const waiting = await page(key, `workspaceId=${CRM}&needsYou=true`);
      expect(waiting.conversations.map((c) => c.person.id)).toContain(POD_LEAD);
    }
  });

  it("SECURITY: a person whose pod-wide role is NOT granted to the space is never listed", async () => {
    for (const key of ["crm", "full"] as const) {
      const { conversations } = await page(key, `workspaceId=${CRM}`);
      expect(conversations.map((c) => c.person.id)).not.toContain(POD_INVESTOR);
      expect(JSON.stringify(conversations)).not.toContain("Ivy Investor");
    }
    // The space the role IS granted to lists them (the owner's full key).
    const other = await page("full", `workspaceId=${OTHER}`);
    expect(other.conversations.map((c) => c.person.id)).toContain(POD_INVESTOR);
  });
});

// Most company leads are reached through a person who works at the company
// (plan 87088d2d W1; on the founder's pod Geoffroy d'Halluin works_at
// Guideflow, and the role is Guideflow's). The door lists such a contact,
// says which lead the row belongs to and its stage, and keeps out the
// contacts of a company whose role is in another space. A contact the
// key's grant cannot read (pod-wide, no role, not homed in the space) is
// still left out for a key limited to the space.
describe("GET /channels/conversations — contacts of company leads", () => {
  const GUIDEFLOW = randomUUID(); // a lead stamped in CRM, stage "qualified"
  const PODCO = randomUUID(); // a POD-WIDE lead granted to CRM, "contacted"
  const OTHERCO = randomUUID(); // a lead in OTHER only
  const GEOFFROY = randomUUID(); // no role, works_at GUIDEFLOW, homed in CRM
  const PAULINE = randomUUID(); // no role, works_at PODCO, homed in CRM
  const UNHOMED = randomUUID(); // no role, works_at GUIDEFLOW, no home
  const SILENT = randomUUID(); // no role, works_at GUIDEFLOW, no channel
  const OTTO = randomUUID(); // no role, works_at OTHERCO, homed in CRM
  const BOTH = randomUUID(); // a lead in CRM ("new") AND works_at GUIDEFLOW
  const CHS = {
    GEOFFROY: randomUUID(),
    PAULINE: randomUUID(),
    UNHOMED: randomUUID(),
    OTTO: randomUUID(),
    BOTH: randomUUID(),
  };

  beforeAll(async () => {
    // The lead role is granted to CRM (the pod-wide company's role).
    await q(
      `insert into profile_workspace_access (profile_id, workspace_id, granted_at) values ($1,$2,now())`,
      [ROLE_LEAD, CRM]
    );
    for (const [id, title] of [
      [GUIDEFLOW, "Guideflow"],
      [PODCO, "Podco"],
      [OTHERCO, "Otherco"],
    ] as const) {
      await q(
        `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
         values ($1,$2,null,$3,'company',$4,'{}'::jsonb,'{}'::jsonb)`,
        [id, OWNER, COMPANY_KIND, title]
      );
    }
    for (const [entityId, ws, status] of [
      [GUIDEFLOW, CRM, "qualified"],
      [PODCO, null, "contacted"],
      [OTHERCO, OTHER, "qualified"],
      [BOTH, CRM, "new"],
    ] as const) {
      await q(
        `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, properties)
         values ($1,$2,$3,$4,$5,$6,'{}'::jsonb)`,
        [randomUUID(), entityId, ROLE_LEAD, OWNER, ws, status]
      );
    }
    for (const [id, title, home, company, channel] of [
      [GEOFFROY, "Geoffroy Contact", CRM, GUIDEFLOW, CHS.GEOFFROY],
      [PAULINE, "Pauline Podco", CRM, PODCO, CHS.PAULINE],
      [UNHOMED, "Una Unhomed", null, GUIDEFLOW, CHS.UNHOMED],
      [SILENT, "Sid Silent", CRM, GUIDEFLOW, null],
      [OTTO, "Otto Otherco", CRM, OTHERCO, CHS.OTTO],
      [BOTH, "Bea Both", null, GUIDEFLOW, CHS.BOTH],
    ] as const) {
      await q(
        `insert into entities (id, user_id, workspace_id, home_workspace_id, profile_id, type, title, properties, system_data)
         values ($1,$2,null,$3,$4,'person',$5,'{}'::jsonb,'{}'::jsonb)`,
        [id, OWNER, home, PERSON_KIND, title]
      );
      await q(
        `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, created_at)
         values ($1,$2,null,$3,$4,'works_at',now())`,
        [randomUUID(), OWNER, id, company]
      );
      if (!channel) continue;
      // The channel stamped where the connector filed it, not in CRM.
      await q(
        `insert into channels (id, user_id, workspace_id, title, channel_type, scope, status,
           context_object_type, context_object_id, external_source, external_channel_id, external_id, metadata, ai_reaction_mode, updated_at)
         values ($1,$2,$3,null,'external','workspace','active','entity',$4,'linkedin',$5,$5,$6::jsonb,'when_confident',$7)`,
        [
          channel,
          OWNER,
          OTHER,
          id,
          `chat-${channel}`,
          JSON.stringify({ accountId: ACCOUNT }),
          T(8),
        ]
      );
    }
  });

  interface LeadRow {
    person: { id: string; company: { id: string; name: string } | null };
    lead: { kind: string; id: string; stage: string | null };
  }
  const rowsOf = async (key: KeyName, ws: string) => {
    const all: LeadRow[] = [];
    let cursor: string | null = null;
    do {
      const res = await page(
        key,
        `workspaceId=${ws}&limit=3${cursor ? `&cursor=${cursor}` : ""}`
      );
      all.push(...(res.conversations as unknown as LeadRow[]));
      cursor = res.nextCursor;
    } while (cursor);
    return all;
  };

  it("lists a person with no role who works at a lead company, with the company's id and stage", async () => {
    for (const key of ["crm", "full"] as const) {
      const rows = await rowsOf(key, CRM);
      const by = Object.fromEntries(rows.map((r) => [r.person.id, r]));
      expect(by[GEOFFROY]).toMatchObject({
        person: { company: { id: GUIDEFLOW, name: "Guideflow" } },
        lead: { kind: "company", id: GUIDEFLOW, stage: "qualified" },
      });
      // A pod-wide company whose role is granted to the space.
      expect(by[PAULINE]).toMatchObject({
        person: { company: { id: PODCO, name: "Podco" } },
        lead: { kind: "company", id: PODCO, stage: "contacted" },
      });
      // A person who is a lead themselves keeps kind person (no stage here).
      expect(by[LEAD]).toMatchObject({
        lead: { kind: "person", id: LEAD, stage: null },
      });
    }
  });

  it("a contact with no channel and no open send is not listed", async () => {
    for (const key of ["crm", "full"] as const) {
      const rows = await rowsOf(key, CRM);
      expect(rows.map((r) => r.person.id)).not.toContain(SILENT);
    }
  });

  it("SECURITY: the contact of a company whose role is only in another space is not listed", async () => {
    for (const key of ["crm", "full"] as const) {
      const rows = await rowsOf(key, CRM);
      expect(rows.map((r) => r.person.id)).not.toContain(OTTO);
      expect(JSON.stringify(rows)).not.toContain("Otherco");
    }
    // The space the company IS a lead of lists them (the owner's full key).
    const other = await rowsOf("full", OTHER);
    expect(other.find((r) => r.person.id === OTTO)).toMatchObject({
      lead: { kind: "company", id: OTHERCO, stage: "qualified" },
    });
  });

  it("a person who is a lead AND works at a lead company: one row, kind person, their own stage", async () => {
    for (const key of ["crm", "full"] as const) {
      const rows = (await rowsOf(key, CRM)).filter((r) => r.person.id === BOTH);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        person: { company: { id: GUIDEFLOW } },
        lead: { kind: "person", id: BOTH, stage: "new" },
      });
    }
  });

  it("SECURITY: a contact the space-limited key cannot read (no role, not homed in the space) is listed only for the owner's own key", async () => {
    expect((await rowsOf("full", CRM)).map((r) => r.person.id)).toContain(
      UNHOMED
    );
    const crm = await rowsOf("crm", CRM);
    expect(crm.map((r) => r.person.id)).not.toContain(UNHOMED);
    expect(JSON.stringify(crm)).not.toContain("Una Unhomed");
  });
});

describe("GET /channels/:id/proposed-messages — failed sends kept, held marked", () => {
  it("lists the held draft as held and the failed send as failed, each with its reason", async () => {
    const held = await get("crm", `/channels/${CH.NOCONN}/proposed-messages`);
    expect(held.status).toBe(200);
    expect(((await held.json()) as { proposed: unknown[] }).proposed).toEqual([
      expect.objectContaining({
        proposalId: P_NOCONN,
        state: "held",
        reason: expect.stringMatching(/Ask to connect first/),
      }),
    ]);
    const failed = await get("crm", `/channels/${CH.FAILED}/proposed-messages`);
    expect(((await failed.json()) as { proposed: unknown[] }).proposed).toEqual(
      [
        expect.objectContaining({
          proposalId: P_FAILED,
          state: "failed",
          reason: expect.stringMatching(/refused/),
        }),
      ]
    );
  });
});

describe("POST /channels/:id/send — the person sends what is in the box", () => {
  const statusOf = async (id: string) =>
    (
      await q<{ status: string; data: Record<string, unknown> }>(
        `select status, data from proposals where id=$1`,
        [id]
      )
    ).rows[0]!;

  it("a typed message with no draft: filed, approved by the click, sent once", async () => {
    const res = await post("crm", `/channels/${CH.QUIET}/send`, {
      text: "Quick question, Quinn",
      workspaceId: CRM,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; proposalId: string };
    expect(body.status).toBe("sent");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      ACCOUNT,
      "chat-quiet",
      "Quick question, Quinn"
    );
    expect((await statusOf(body.proposalId)).status).toBe("approved");
  });

  it("someone not connected: the typed text is kept as a HELD draft, nothing sent", async () => {
    const res = await post("crm", `/channels/${CH.NOCONN}/send`, {
      text: "Nora, my own words",
      workspaceId: CRM,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      proposalId: string;
      reason: string;
    };
    expect(body).toMatchObject({
      status: "held",
      reason: expect.stringMatching(/Ask to connect first/),
    });
    expect(startChat).not.toHaveBeenCalled();
    const row = await statusOf(body.proposalId);
    expect(row.status).toBe("pending");
    expect(row.data).toMatchObject({
      body: "Nora, my own words",
      held: { errorClass: "not_connected" },
    });
  });

  it("sending a held draft while still not connected: it stays held, never failed", async () => {
    const res = await post("crm", `/channels/${CH.NOCONN}/send`, {
      text: "Hello there\nsecond line",
      draftId: P_NOCONN,
      workspaceId: CRM,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "held",
      proposalId: P_NOCONN,
    });
    expect((await statusOf(P_NOCONN)).status).toBe("pending");
    expect(startChat).not.toHaveBeenCalled();
  });

  it("an edited draft sends the NEW text, to the same person", async () => {
    const res = await post("crm", `/channels/${CH.LEAD}/send`, {
      text: "Edited: shall we talk Tuesday?",
      draftId: P_LEAD,
      expectedRevision: 0,
      workspaceId: CRM,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "sent",
      proposalId: P_LEAD,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      ACCOUNT,
      "chat-lead",
      "Edited: shall we talk Tuesday?"
    );
    const row = await statusOf(P_LEAD);
    expect(row.status).toBe("approved");
    expect(row.data).toMatchObject({
      body: "Edited: shall we talk Tuesday?",
      channelId: CH.LEAD,
      entityId: LEAD,
    });
  });

  it("a draft that is not on this conversation is not found; nothing sent", async () => {
    const res = await post("crm", `/channels/${CH.QUIET}/send`, {
      text: "x",
      draftId: P_FAILED,
      workspaceId: CRM,
    });
    expect(res.status).toBe(404);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("SECURITY: an agent never sends through the person's door", async () => {
    const res = await post("agent", `/channels/${CH.QUIET}/send`, {
      text: "x",
      workspaceId: CRM,
    });
    expect(res.status).toBe(403);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("SECURITY: a conversation of someone outside the app's space is not found", async () => {
    const res = await post("crm", `/channels/${CH.ELSEWHERE}/send`, {
      text: "x",
      workspaceId: CRM,
    });
    expect(res.status).toBe(404);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
