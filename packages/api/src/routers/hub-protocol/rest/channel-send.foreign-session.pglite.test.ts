/**
 * The person sends (or saves) an AI draft filed in a run they own in ANOTHER
 * space, from their own space-limited app token (founder, 9 Nov 2026).
 *
 * Live: the CRM's send of the 8 drafts filed 3 Nov in the founder's dev
 * session d00cd2ac (Builder) answered 404 "Proposal not found". The review
 * ladder's session rung read the run under the CRM token's grant (fenced to
 * the CRM space), so the founder could not decide his own draft. A send of
 * the draft as written answered 200 "failed" with the reason stored on 4 Nov
 * although nothing was tried.
 *
 * The fix this file holds to:
 *   1. the session rung judges the PERSON (no key grant) when neither the
 *      request nor the viewer is an agent; agents keep the key-bounded rung;
 *   2. the person's own token on the send and save doors gets the human
 *      doors' session roster (a run their own agent owns is theirs to decide);
 *   3. a send refused before anything ran answers that refusal, never an
 *      earlier attempt's failure.
 * And to the floors: F1 an agent or an integration key never sends, saves or
 * approves; F2 an agent revises only its own proposal; F3 a space-limited key
 * decides nothing outside its spaces; F4 the key still cannot READ the other
 * space's run; F5 a stranger learns nothing (NOT_FOUND).
 *
 * Real: PGlite, the hub auth door (W1 fence + grant), the routes, the send
 * door, the revise core, the tRPC approve procedure (gates, ladder, D3
 * fence), the approval dispatch and the messaging executor. Stubbed: the key
 * lookup, the guest check, the provider (a fake Unipile), the side-effect
 * fan-out, `db.transaction` (inline on the one PGlite connection: the
 * ladder's pool reads would otherwise wait on the revise core's row lock).
 *
 * Cannot see: production Postgres row locks, a real minted app token, a live
 * Unipile account.
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
  (db as unknown as { transaction: unknown }).transaction = async (
    fn: (tx: unknown) => unknown
  ) => fn(db);
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
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));
vi.mock(
  "../../../services/capabilities/execute-capability.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    assertApprovalTargetResolves: async () => null,
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { and, eq } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import {
  grantOfScope,
  runWithActingAgent,
  runWithGrant,
} from "@synap/database";
import "../../../access/grant-read.js";
import { sessionReadableWhere } from "../../../access/session-visibility.js";
import {
  computeCanReviewApproval,
  resolveViewerReviewVerdicts,
} from "../../proposals/review-authority.js";
import { registerMessagingExecutors } from "../../proposals/executors/messaging.js";
import { proposalsRouter } from "../../proposals.js";
import { mergeProposalRevision } from "../../../services/proposals/proposals-service.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { createHubProtocolCallerContext } from "../utils.js";
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
const AGENT = randomUUID(); // the founder's Claude Code agent (created by OWNER)
const OTHER_AGENT = randomUUID(); // another agent of the founder
const STRANGER = randomUUID(); // a teammate who is in neither space
const CRM = randomUUID();
const BUILDER = randomUUID(); // another space of the same founder
const PERSON_KIND = randomUUID();
const ROLE_LEAD = randomUUID();
const ACCOUNT = "acc-1";

/** Focus sessions a draft may be filed in. */
const S = {
  /** LIVE: the founder's own dev session, in Builder (d00cd2ac). */
  ownerInBuilder: randomUUID(),
  /** The founder's own session, in the CRM space. */
  ownerInCrm: randomUUID(),
  /** Hypothesis A: a run the AGENT owns, in the CRM space. */
  agentInCrm: randomUUID(),
};

/**
 * One person, one pending channel and one failed draft per case. `outside`
 * is the live draft's twin filed in BUILDER (F3).
 */
const CASES = [
  "live",
  "crmSession",
  "agentSession",
  "noSession",
  "outside",
] as const;
type Case = (typeof CASES)[number];
const SESSION_OF: Record<Case, string | null> = {
  live: S.ownerInBuilder,
  crmSession: S.ownerInCrm,
  agentSession: S.agentInCrm,
  noSession: null,
  outside: S.ownerInBuilder,
};
const SPACE_OF: Record<Case, string> = {
  live: CRM,
  crmSession: CRM,
  agentSession: CRM,
  noSession: CRM,
  outside: BUILDER,
};
const ids = () =>
  Object.fromEntries(CASES.map((c) => [c, randomUUID()])) as Record<
    Case,
    string
  >;
const PERSON = ids();
const CHANNEL = ids();
const DRAFT = ids();

/** The CRM's grant as its consent asks for it (site.config.ts), fenced to CRM. */
const CRM_PERMISSIONS = [
  "entity.*.read",
  "facet.read",
  "channel.read",
  "session.read",
  "proposal.read",
  "proposal.approve",
  "proposal.reject",
  "capability.send_message.run",
];
const crmGrant = () =>
  grantOfScope({ permissions: CRM_PERMISSIONS, workspaceIds: [CRM] }, null);

interface Key {
  id: string;
  userId: string;
  linkedUserId: string | null;
  keyType: string;
  permissions: string[];
  workspaceIds: string[] | null;
  hubId?: string;
}
const KEYS = {
  /** The CRM, signed in as the person (their own app token). */
  crm: {
    id: randomUUID(),
    userId: OWNER,
    linkedUserId: null,
    keyType: "app_person",
    permissions: CRM_PERMISSIONS,
    workspaceIds: [CRM],
  },
  /** The same token without the right to approve. */
  crmNoApprove: {
    id: randomUUID(),
    userId: OWNER,
    linkedUserId: null,
    keyType: "app_person",
    permissions: CRM_PERMISSIONS.filter((p) => p !== "proposal.approve"),
    workspaceIds: [CRM],
  },
  /** The founder's own unbounded key. */
  full: {
    id: randomUUID(),
    userId: OWNER,
    linkedUserId: null,
    keyType: "hub_inbound",
    permissions: ["*"],
    workspaceIds: null,
  },
  /** The founder's agent, granted the same as the CRM (approve included). */
  agent: {
    id: randomUUID(),
    userId: AGENT,
    linkedUserId: OWNER,
    keyType: "hub_inbound",
    permissions: CRM_PERMISSIONS,
    workspaceIds: [CRM],
  },
  /** The founder's full key pasted into another AI app. */
  integration: {
    id: randomUUID(),
    userId: OWNER,
    linkedUserId: null,
    keyType: "hub_inbound",
    permissions: ["*"],
    workspaceIds: null,
    hubId: "integration:custom",
  },
  /** A teammate's own CRM-like token. */
  stranger: {
    id: randomUUID(),
    userId: STRANGER,
    linkedUserId: null,
    keyType: "app_person",
    permissions: CRM_PERMISSIONS,
    workspaceIds: [CRM],
  },
} satisfies Record<string, Key>;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const sendMessage = vi.fn();
const startChat = vi.fn();
const getProfile = vi.fn();
const OLD_REASON = "Couldn't apply — No LinkedIn profile on file.";

async function resetDraft(c: Case) {
  await q(`delete from proposals where id=$1`, [DRAFT[c]]);
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status,
       created_by, agent_user_id, subject_user_id, rejection_reason, revision_history, session_id,
       reviewed_at, created_at, updated_at)
     values ($1,$2,'messaging',$3,'messaging.external.send',$4::jsonb,'approval_failed',$5,$6,$5,$7,'[]'::jsonb,$8,
       '2026-11-03T23:55:16Z','2026-11-03T23:52:14Z','2026-11-03T23:55:16Z')`,
    [
      DRAFT[c],
      SPACE_OF[c],
      CHANNEL[c],
      JSON.stringify({
        body: "Bonjour, the AI's words",
        failure: { errorClass: "missing_field", providerRef: "linkedin" },
        summary: "Send a LinkedIn message",
        entityId: PERSON[c],
        platform: "linkedin",
        provider: "linkedin",
        threadId: null,
        accountId: ACCOUNT,
        channelId: CHANNEL[c],
        draftedBy: { agentUserId: AGENT, appClientId: null },
        sessionId: SESSION_OF[c],
        playbookId: null,
        agentUserId: AGENT,
        workspaceId: SPACE_OF[c],
        capabilityId: "messaging://linkedin",
        capabilityKind: "messaging",
      }),
      OWNER,
      AGENT,
      OLD_REASON,
      SESSION_OF[c],
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
    `insert into users (id, email, user_type, name) values ($1,$2,'human','Owner'), ($3,$4,'human','Stranger')`,
    [OWNER, "owner@example.test", STRANGER, "stranger@example.test"]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id, name)
     values ($1,$2,'agent',$5,'Claude Code'), ($3,$4,'agent',$5,'Other agent')`,
    [AGENT, "agent@example.test", OTHER_AGENT, "other@example.test", OWNER]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'), ($3,$4,'member')`,
    [randomUUID(), OWNER, randomUUID(), STRANGER]
  );
  for (const [ws, name] of [
    [CRM, "CRM"],
    [BUILDER, "Builder"],
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
  for (const [sid, owner, ws] of [
    [S.ownerInBuilder, OWNER, BUILDER],
    [S.ownerInCrm, OWNER, CRM],
    [S.agentInCrm, AGENT, CRM],
  ] as const) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, status) values ($1,$2,$3,'Draft first messages','active')`,
      [sid, owner, ws]
    );
  }
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, created_at, updated_at)
     values ($1,$2,'linkedin',$3,'Me on LinkedIn','connected',now(),now())`,
    [randomUUID(), OWNER, ACCOUNT]
  );
  for (const c of CASES) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,null,$3,'person',$4,$5::jsonb,'{}'::jsonb)`,
      [
        PERSON[c],
        OWNER,
        PERSON_KIND,
        `Person ${c}`,
        JSON.stringify({
          linkedinProviderId: `ACo-${c}`,
          linkedinConnection: "connected",
        }),
      ]
    );
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties)
       values ($1,$2,$3,$4,$5,'{}'::jsonb)`,
      [randomUUID(), PERSON[c], ROLE_LEAD, OWNER, CRM]
    );
    // A pending channel: bound to the person, no chat yet.
    await q(
      `insert into channels (id, user_id, workspace_id, title, channel_type, scope, status,
         context_object_type, context_object_id, external_source, external_channel_id, external_id, metadata, ai_reaction_mode, updated_at)
       values ($1,$2,null,null,'external','pod','active','entity',$3,'linkedin',null,null,$4::jsonb,'when_confident',now())`,
      [CHANNEL[c], OWNER, PERSON[c], JSON.stringify({ accountId: ACCOUNT })]
    );
  }
  for (const k of Object.values(KEYS) as Key[]) {
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,$3,true)`,
      [k.id, k.userId, k.linkedUserId]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by, client_id)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4,null)`,
      [
        randomUUID(),
        k.id,
        k.userId,
        k.linkedUserId ?? k.userId,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
      ]
    );
  }
}, 120_000);

beforeEach(async () => {
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
  startChat.mockResolvedValue({
    chatId: `chat-${randomUUID()}`,
    messageId: `sent-${randomUUID()}`,
  });
  getProfile.mockResolvedValue({
    providerId: "ACo",
    publicIdentifier: "p",
    name: "P",
    networkDistance: "FIRST_DEGREE",
    connection: "connected",
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
        hubId: key.hubId ?? null,
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
  for (const c of CASES) await resetDraft(c);
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerChannelConversationsRoutes(hub);
  registerChannelsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}
const call = (key: KeyName, method: string, path: string, body: unknown) =>
  app().request(`/api/hub${path}`, {
    method,
    headers: {
      authorization: `Bearer synap_${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const NEW_WORDS = "Bonjour, the person's words";
const sendEdited = (key: KeyName, c: Case) =>
  call(key, "POST", `/channels/${CHANNEL[c]}/send`, {
    text: NEW_WORDS,
    draftId: DRAFT[c],
    workspaceId: CRM,
  });
const sendAsIs = (key: KeyName, c: Case) =>
  call(key, "POST", `/channels/${CHANNEL[c]}/send`, {
    text: "Bonjour, the AI's words",
    draftId: DRAFT[c],
    workspaceId: CRM,
  });
const save = (key: KeyName, c: Case) =>
  call(key, "PUT", `/channels/${CHANNEL[c]}/drafts/${DRAFT[c]}`, {
    text: NEW_WORDS,
  });

async function row(c: Case) {
  return (
    await q<{
      status: string;
      data: { body: string };
      rejection_reason: string | null;
    }>(`select status, data, rejection_reason from proposals where id=$1`, [
      DRAFT[c],
    ])
  ).rows[0]!;
}
const providerCalls = () =>
  startChat.mock.calls.length + sendMessage.mock.calls.length;

const reviewed = (c: Case) => ({
  workspaceId: SPACE_OF[c],
  data: {},
  agentUserId: AGENT,
  targetType: "messaging",
  targetId: CHANNEL[c],
  sessionId: SESSION_OF[c],
  proposalType: "messaging.external.send",
});

/** The ladder as the revise core / approve door ask it, under the CRM grant. */
const ladder = (
  c: Case,
  purpose: "approve" | "reject",
  opts: { roster?: boolean; actingAgent?: string; grant?: boolean } = {}
) => {
  const run = () =>
    computeCanReviewApproval({
      proposal: reviewed(c),
      userId: OWNER,
      purpose,
      roster: opts.roster ?? false,
      ...(purpose === "approve" && opts.actingAgent
        ? { actingAgentUserId: opts.actingAgent }
        : {}),
    });
  const granted = () =>
    opts.grant === false ? run() : runWithGrant(crmGrant(), run);
  return opts.actingAgent
    ? runWithActingAgent(opts.actingAgent, granted)
    : granted();
};

const revise = (c: Case, actorId = OWNER) =>
  mergeProposalRevision({
    proposalId: DRAFT[c],
    patch: { kind: "inner", fields: { body: NEW_WORDS } },
    actorId,
  });

/** The tRPC approve door as the send route reaches it (a Hub caller). */
async function approveAsHub(
  c: Case,
  opts: { agentUserId?: string; personRoster?: boolean } = {}
) {
  const ctx = await createHubProtocolCallerContext(
    OWNER,
    ["hub-protocol.read", "hub-protocol.write"],
    undefined,
    undefined,
    undefined,
    opts.agentUserId ?? null
  );
  ctx.personRoster = opts.personRoster ?? true;
  const caller = proposalsRouter.createCaller(
    ctx as Parameters<typeof proposalsRouter.createCaller>[0]
  );
  return caller.approve({ proposalId: DRAFT[c] });
}

describe("LIVE SHAPE — the person sends an AI draft filed in their run in another space", () => {
  it("the edited draft is revised as the person and sent", async () => {
    const res = await sendEdited("crm", "live");
    expect({ status: res.status, json: await res.json() }).toMatchObject({
      status: 200,
      json: { proposalId: DRAFT.live, status: "sent" },
    });
    expect((await row("live")).data.body).toBe(NEW_WORDS);
    expect(providerCalls()).toBe(1);
  });

  it("the draft sent as written is approved by the click and sent", async () => {
    const res = await sendAsIs("crm", "live");
    expect({ status: res.status, json: await res.json() }).toMatchObject({
      status: 200,
      json: { proposalId: DRAFT.live, status: "sent" },
    });
    expect(providerCalls()).toBe(1);
  });

  it("PUT save keeps the person's words and reopens the failed send", async () => {
    const res = await save("crm", "live");
    expect({ status: res.status, json: await res.json() }).toMatchObject({
      status: 200,
      json: { draftId: DRAFT.live, changed: true, status: "pending" },
    });
    expect((await row("live")).data.body).toBe(NEW_WORDS);
    expect(providerCalls()).toBe(0);
  });
});

describe("the session rung judges the person, the key's reach stays", () => {
  it("as the person under the CRM grant: the live draft may be revised and approved", async () => {
    expect(await ladder("live", "reject")).toEqual({
      allowed: true,
      reason: "agent-owner",
    });
    expect((await ladder("live", "approve")).allowed).toBe(true);
  });

  it("an acting agent keeps the key-bounded rung: session-only under the same grant", async () => {
    expect(await ladder("live", "reject", { actingAgent: AGENT })).toEqual({
      allowed: false,
      reason: "session-only",
    });
    expect(
      (await ladder("live", "approve", { actingAgent: AGENT })).allowed
    ).toBe(false);
  });

  it("controls: no session, or the founder's session in the CRM space, pass", async () => {
    expect((await ladder("noSession", "reject")).allowed).toBe(true);
    expect((await ladder("crmSession", "approve")).allowed).toBe(true);
  });

  it("the list's canApprove equals the mutation's verdict, case by case", async () => {
    const cases = ["live", "crmSession", "agentSession", "noSession"] as const;
    for (const roster of [false, true]) {
      const verdicts = await runWithGrant(crmGrant(), () =>
        resolveViewerReviewVerdicts({
          userId: OWNER,
          roster,
          rows: cases.map((c) => ({ id: DRAFT[c], ...reviewed(c) })),
        })
      );
      for (const c of cases) {
        const one = await ladder(c, "approve", { roster });
        expect({
          c,
          roster,
          list: verdicts.get(DRAFT[c])!.viewerCanReview,
        }).toEqual({ c, roster, list: one.allowed });
      }
      expect(verdicts.get(DRAFT.live)!.viewerCanReview).toBe(true);
    }
    // An acting agent: both refuse the live draft.
    const agentList = await runWithActingAgent(AGENT, () =>
      runWithGrant(crmGrant(), () =>
        resolveViewerReviewVerdicts({
          userId: OWNER,
          roster: false,
          actingAgentUserId: AGENT,
          rows: [{ id: DRAFT.live, ...reviewed("live") }],
        })
      )
    );
    expect(agentList.get(DRAFT.live)!.viewerCanReview).toBe(false);
  });

  it("the founder's unbounded key sends the same live draft", async () => {
    const res = await sendEdited("full", "live");
    expect(res.status).toBe(200);
    expect((await row("live")).data.body).toBe(NEW_WORDS);
  });

  it("controls through the route: no session, or a CRM session, send under the CRM grant", async () => {
    for (const c of ["noSession", "crmSession"] as const) {
      const res = await sendEdited("crm", c);
      const json = (await res.json()) as { status?: string };
      expect({ c, status: res.status, sent: json.status }).toEqual({
        c,
        status: 200,
        sent: "sent",
      });
    }
  });
});

describe("hypothesis A — a run the person's own AGENT owns (option 5)", () => {
  it("the person's token sends the draft filed in it (the human doors' roster)", async () => {
    const res = await sendEdited("crm", "agentSession");
    expect({ status: res.status, json: await res.json() }).toMatchObject({
      status: 200,
      json: { status: "sent" },
    });
  });

  it("the person's token saves the draft filed in it", async () => {
    const res = await save("crm", "agentSession");
    expect(res.status).toBe(200);
    expect((await row("agentSession")).data.body).toBe(NEW_WORDS);
  });

  it("an acting agent is refused it, whatever roster it claims", async () => {
    expect(
      (await ladder("agentSession", "reject", { actingAgent: AGENT })).allowed
    ).toBe(false);
    await expect(
      approveAsHub("agentSession", { agentUserId: AGENT, personRoster: true })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("without personRoster the Hub approve door stays owner-only (rosterReadFor unchanged)", async () => {
    await expect(
      runWithGrant(crmGrant(), () =>
        approveAsHub("agentSession", { personRoster: false })
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only people in this session can approve this proposal",
    });
  });
});

describe("a send refused before anything ran answers the refusal, not an old failure", () => {
  it("unedited send without the approve right: 403 with the refusal, the draft untouched, nothing sent", async () => {
    const res = await sendAsIs("crmNoApprove", "live");
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(403);
    expect(json.proposalId).toBe(DRAFT.live);
    expect(json.status).toBeUndefined();
    expect(json.reason).toBeUndefined();
    expect(json.error).not.toBe(OLD_REASON);
    expect(providerCalls()).toBe(0);
    const after = await row("live");
    expect(after.status).toBe("approval_failed");
    expect(after.rejection_reason).toBe(OLD_REASON);
  });

  it("a send that fails NOW still answers 200 failed with the new reason", async () => {
    startChat.mockRejectedValue(new Error("LinkedIn refused the message."));
    sendMessage.mockRejectedValue(new Error("LinkedIn refused the message."));
    const res = await sendAsIs("crm", "live");
    const json = (await res.json()) as { status?: string; reason?: string };
    expect(res.status).toBe(200);
    expect(json.status).toBe("failed");
    expect(json.reason).not.toBe(OLD_REASON);
  });
});

describe("floors", () => {
  it("F1: an agent key and an integration key never send or save, live draft or not", async () => {
    for (const key of ["agent", "integration"] as const) {
      for (const c of ["live", "noSession"] as const) {
        const sent = await sendEdited(key, c);
        const saved = await save(key, c);
        expect({ key, c, sent: sent.status, saved: saved.status }).toEqual({
          key,
          c,
          sent: 403,
          saved: 403,
        });
      }
    }
    expect(providerCalls()).toBe(0);
    expect((await row("live")).data.body).toBe("Bonjour, the AI's words");
  });

  it("F1: an acting agent never approves, under the lift or the person's roster flag", async () => {
    expect(
      (await ladder("live", "approve", { actingAgent: AGENT })).allowed
    ).toBe(false);
    await expect(
      runWithGrant(crmGrant(), () =>
        approveAsHub("live", { agentUserId: AGENT, personRoster: true })
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(providerCalls()).toBe(0);
  });

  it("F2: an agent revises only its own proposal", async () => {
    await expect(
      runWithActingAgent(OTHER_AGENT, () =>
        runWithGrant(crmGrant(), () => revise("live"))
      )
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Proposal not found",
    });
    expect((await row("live")).data.body).toBe("Bonjour, the AI's words");
    await runWithActingAgent(AGENT, () =>
      runWithGrant(crmGrant(), () => revise("live"))
    );
    expect((await row("live")).data.body).toBe(NEW_WORDS);
  });

  it("F3: the CRM key neither revises nor approves a draft filed in Builder, though the person owns its run", async () => {
    await expect(
      runWithGrant(crmGrant(), () => revise("outside"))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      runWithGrant(crmGrant(), () => approveAsHub("outside"))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const after = await row("outside");
    expect(after.data.body).toBe("Bonjour, the AI's words");
    expect(after.status).toBe("approval_failed");
    expect(providerCalls()).toBe(0);
  });

  it("F4: the CRM key still cannot READ the Builder run, before and after a send that decided its draft", async () => {
    const { db } = await import("@synap/database");
    const readRun = () =>
      runWithGrant(crmGrant(), () =>
        db
          .select({ id: schema.focusSessions.id })
          .from(schema.focusSessions)
          .where(
            and(
              eq(schema.focusSessions.id, S.ownerInBuilder),
              sessionReadableWhere({ userId: OWNER, roster: true })
            )
          )
      );
    expect(await readRun()).toEqual([]);
    expect((await sendEdited("crm", "live")).status).toBe(200);
    expect(await readRun()).toEqual([]);
    // The same read without a grant: the founder reads his run.
    expect(
      await db
        .select({ id: schema.focusSessions.id })
        .from(schema.focusSessions)
        .where(
          and(
            eq(schema.focusSessions.id, S.ownerInBuilder),
            sessionReadableWhere({ userId: OWNER, roster: true })
          )
        )
    ).toEqual([{ id: S.ownerInBuilder }]);
  });

  it("F5: a stranger learns nothing — the route answers not found, the revise core NOT_FOUND", async () => {
    const sent = await sendEdited("stranger", "live");
    expect(sent.status).toBe(404);
    const saved = await save("stranger", "live");
    expect(saved.status).toBe(404);
    for (const grant of [true, false]) {
      const run = () => revise("live", STRANGER);
      await expect(
        grant ? runWithGrant(crmGrant(), run) : run()
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Proposal not found",
      });
    }
    expect((await row("live")).data.body).toBe("Bonjour, the AI's words");
    expect(providerCalls()).toBe(0);
  });
});
