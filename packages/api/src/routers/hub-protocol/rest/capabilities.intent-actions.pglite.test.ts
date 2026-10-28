/**
 * Intent actions (decision 3A + 4A, founder 2026-10-28): a pod app asks the
 * person's tools to publish a post through the TWO existing capability doors,
 * `GET /capabilities/actions?intent` and `POST /capabilities/execute`, with
 * the REAL hub auth door (W1 fence + `runWithGrant`), the REAL routes, the
 * real grant check, the real run core (`executeCapability`) and the real
 * capability gate (the app outward floor included), on PGlite.
 *
 * The tool is Postiz as P1 ships it: one key, several social channels, listed
 * by a read verb (the account source); the schedule verb maps the intent's
 * input `{ text, when }` and the targeted channel onto its parameters.
 *
 * Rows rule out:
 *  - an app listing or running without `capability.publish_post.run`, in
 *    another space, or for another intent (GRANT_DENIED; the fence for a key
 *    holding no run at all);
 *  - an app seeing a verb id, a skill id or a verb's raw parameters;
 *  - an outward run RUNNING for an app — its agent key or the person's own
 *    token (the owner bypass) — instead of filing a proposal;
 *  - the proposal missing what the person must review (the app, the intent,
 *    the account, the app's own words, the mapped parameters);
 *  - an unmapped input field silently dropped, an invalid input passing, an
 *    action of another intent running under this one (INTENT_MISMATCH), an
 *    account that is gone still running (404);
 *  - a raw body (`verbId`/`parameters`) accepted from an app;
 *  - the per-key, per-intent cap missing (429 + retryAfter);
 *  - an unfenced operator, or an existing `capability.run` grant, changed.
 *
 * Mocked: the key lookup, the guest check, the sub-token mapping, the audit
 * log, the event log, the person-token classification (the identity a mint
 * yields is pinned by app-person-token.pglite.test.ts), the capability
 * REGISTRY read (one Postiz tool row; the registry has its own tests), the
 * provider HTTP call (Postiz), and the proposal ROW write (PGlite nests no
 * transactions; the VERDICT is the real gate's). Cannot see: production
 * Postgres, a real Postiz, the approval screen (synap-app).
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
  registry: [] as unknown[],
  /** The channels Postiz lists right now. */
  channels: [] as Array<Record<string, unknown>>,
  /** Every provider call (method, params) — a post must never be among them. */
  calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
  noopEvents: () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then"
            ? undefined
            : async () => ({ id: globalThis.crypto.randomUUID() }),
      }
    ),
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
    eventRepository: h.noopEvents(),
    EventRepository: class {
      constructor() {
        return h.noopEvents();
      }
    },
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: globalThis.crypto.randomUUID() })),
}));
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
vi.mock("../../../services/app-person-token.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  classifyAppPersonKey: async (args: { grant: unknown }) => ({
    kind: "person",
    grant: args.grant,
  }),
}));
vi.mock(
  "../../../services/capabilities/capability-registry.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    listCapabilities: async () => h.registry,
  })
);
vi.mock(
  "../../../services/capabilities/execute-provider-verb.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    executeProviderVerb: async (
      spec: { method: string },
      params: Record<string, unknown>
    ) => {
      h.calls.push({ method: spec.method, params });
      return spec.method === "GET"
        ? { channels: h.channels }
        : [{ postId: "p-1", integration: params.integrationId }];
    },
  })
);
// PGlite runs ONE connection and the proposal writer nests transactions on
// it: a PROPOSE verdict (the real gate's) files its row here, with the data
// the run core built and the app the request's grant names.
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/permission-check.js")>();
  const { getRequestGrant } = await import("@synap/database");
  return {
    ...actual,
    createPendingProposal: async (input: {
      userId: string;
      workspaceId?: string | null;
      agentUserId?: string;
      targetType: string;
      targetId: string;
      proposalType: string;
      data: Record<string, unknown>;
      governanceReason?: string | null;
    }) => {
      const id = globalThis.crypto.randomUUID();
      await h.client!.query(
        `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by, subject_user_id, agent_user_id, governance_reason, app_id)
         values ($1,$2,$3,$4,$5,$6::jsonb,'pending',$7,$7,$8,$9,$10)`,
        [
          id,
          input.workspaceId ?? null,
          input.targetType,
          input.targetId,
          input.proposalType,
          JSON.stringify(input.data),
          input.userId,
          input.agentUserId ?? null,
          input.governanceReason ?? null,
          getRequestGrant()?.clientId ?? null,
        ]
      );
      return { id };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { intentActionId } from "../../../services/capabilities/intent-actions.js";
import { registerCapabilitiesActionsRoutes } from "./capabilities-actions.js";
import { registerCapabilitiesExecuteRoutes } from "./capabilities-execute.js";
import type { HubHono, HubVariables } from "./_shared.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID(); // the person
const AGENT = randomUUID(); // the app's own agent
const CRM = randomUUID(); // the space the app was granted
const BRAND = randomUUID(); // the person's other space
const TOOL = randomUUID(); // Postiz
const SCHEDULE = randomUUID(); // postiz_schedule (publish_post, mapped)
const LIST = randomUUID(); // postiz_list_integrations (the account source)
const DM = randomUUID(); // postiz_dm (send_message, mapped)
const CLIENT = `app_${randomUUID()}`; // the app's public id

/** migrations/0368_intent_input_schema.sql's publish_post input. */
const PUBLISH_POST_INPUT = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1, maxLength: 3000 },
    media: {
      type: "array",
      items: { type: "string", format: "uuid" },
      maxItems: 10,
    },
    link: {
      type: "string",
      format: "uri",
      pattern: "^https://",
      maxLength: 2048,
    },
    when: { type: "string", format: "date-time" },
  },
  required: ["text"],
  additionalProperties: false,
};
const SEND_MESSAGE_INPUT = {
  type: "object",
  properties: { text: { type: "string", minLength: 1 } },
  required: ["text"],
  additionalProperties: false,
};
const SCHEDULE_MAP = {
  params: {
    content: "$.text",
    date: "$.when",
    integrationId: "$account.id",
    provider: "$account.provider",
  },
  accounts: {
    verb: "postiz_list_integrations",
    id: "id",
    label: "name",
    provider: "provider",
  },
};
const LINKEDIN = {
  id: "int-li",
  name: "LinkedIn (Antoine)",
  provider: "linkedin",
};
const BLUESKY = {
  id: "int-bs",
  name: "Bluesky (Antoine)",
  provider: "bluesky",
};

interface Key {
  id: string;
  permissions: string[];
  workspaceIds: string[] | null;
  principal: string;
  person: string;
  clientId: string | null;
}
const app = (permissions: string[], over: Partial<Key> = {}): Key => ({
  id: randomUUID(),
  permissions,
  workspaceIds: [CRM],
  principal: AGENT,
  person: OWNER,
  clientId: CLIENT,
  ...over,
});
const KEYS = {
  /** The app's agent key: publish posts, in CRM. */
  poster: app(["capability.publish_post.run"]),
  /** The person's own token for the app (acts as the person). */
  person: app(["capability.publish_post.run"], { principal: OWNER }),
  /** An app whose grant predates intents: run tools for any intent, in CRM. */
  anyRun: app(["capability.run"]),
  /** An app that may only send messages. */
  messenger: app(["capability.send_message.run"]),
  /** An app with no tool run at all. */
  reader: app(["entity.*.read"]),
  /** A poster used only to exhaust the per-intent cap. */
  busy: app(["capability.publish_post.run"]),
  /** The person's own unbounded key: not limited to spaces, no app. */
  operator: app(["*"], {
    workspaceIds: null,
    principal: OWNER,
    clientId: null,
  }),
} satisfies Record<string, Key>;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const verb = (id: string, label: string, intent: string, kind: string) => ({
  id,
  label,
  kind,
  intent,
  granted: false,
  backingSkillExecutable: true,
});

beforeAll(async () => {
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
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "app-agent@example.test", OWNER]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), OWNER]
  );
  for (const [ws, name] of [
    [CRM, "CRM"],
    [BRAND, "Brand"],
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
    `insert into capability_intents (slug, effect, statement, synonyms, input_schema) values
       ('publish_post','write','Broadcast a post','{}',$1::jsonb),
       ('send_message','write','Deliver a message','{}',$2::jsonb),
       ('list_records','read','Enumerate records','{}',null)`,
    [JSON.stringify(PUBLISH_POST_INPUT), JSON.stringify(SEND_MESSAGE_INPUT)]
  );
  await q(
    `insert into tools (id, name, kind, approved, created_by, workspace_id) values ($1,'postiz','api',true,$2,null)`,
    [TOOL, OWNER]
  );
  const skill = async (
    id: string,
    name: string,
    intent: string,
    inputMap: unknown,
    parameters: unknown,
    providerSpec: unknown,
    metadata: unknown
  ) => {
    await q(
      `insert into skills (id, user_id, name, kind, scope, status, approved, intent, input_map, parameters, provider_spec, metadata)
       values ($1,$2,$3,'declarative','pod','active',true,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [
        id,
        OWNER,
        name,
        intent,
        inputMap === null ? null : JSON.stringify(inputMap),
        JSON.stringify(parameters),
        JSON.stringify(providerSpec),
        JSON.stringify(metadata),
      ]
    );
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1,'skill',$2,'tool',$3,'requires')`,
      [randomUUID(), id, TOOL]
    );
  };
  await skill(
    SCHEDULE,
    "postiz_schedule",
    "publish_post",
    SCHEDULE_MAP,
    {
      content: "string",
      integrationId: "string",
      provider: "string",
      date: "string",
    },
    { tool: "postiz", method: "POST", pathTemplate: "/public/v1/posts" },
    { verbType: "write" }
  );
  await skill(
    LIST,
    "postiz_list_integrations",
    "list_records",
    null,
    {},
    {
      tool: "postiz",
      method: "GET",
      pathTemplate: "/public/v1/integrations",
      responseShape: {
        collectionPath: "",
        collectionAs: "channels",
        item: { id: "id", name: "name", provider: "identifier" },
      },
    },
    { readOnly: true }
  );
  await skill(
    DM,
    "postiz_dm",
    "send_message",
    { params: { content: "$.text" } },
    { content: "string" },
    { tool: "postiz", method: "POST", pathTemplate: "/public/v1/dm" },
    { verbType: "write" }
  );
  h.registry = [
    {
      kind: "tool",
      id: TOOL,
      name: "postiz",
      description: "Post to social networks",
      enabled: true,
      governance: "auto",
      catalogOnly: false,
      verbs: [
        verb("postiz_schedule", "Schedule a post", "publish_post", "write"),
        verb(
          "postiz_list_integrations",
          "List channels",
          "list_records",
          "read"
        ),
        verb("postiz_dm", "Send a direct message", "send_message", "write"),
      ],
    },
  ];

  for (const k of Object.values(KEYS)) {
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,$3,true)`,
      [k.id, k.principal, k.person]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by, client_id)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4,$7)`,
      [
        randomUUID(),
        k.id,
        k.principal,
        k.person,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
        k.clientId,
      ]
    );
  }
}, 120_000);

beforeEach(() => {
  h.channels = [LINKEDIN, BLUESKY];
  h.calls = [];
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const key: Key = KEYS[bearer.replace(/^synap_/, "") as KeyName];
    return {
      status: "valid",
      record: {
        id: key.id,
        userId: key.principal,
        linkedUserId: key.person,
        parentKeyId: null,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        keyType: "hub_inbound",
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
});

function hubApp() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerCapabilitiesActionsRoutes(hub);
  registerCapabilitiesExecuteRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const send = (
  key: KeyName,
  method: "GET" | "POST",
  path: string,
  body?: unknown
) => {
  const json = body === undefined ? undefined : JSON.stringify(body);
  return hubApp().request(`/api/hub${path}`, {
    method,
    headers: {
      authorization: `Bearer synap_${key}`,
      ...(json
        ? {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(json)),
          }
        : {}),
    },
    ...(json ? { body: json } : {}),
  });
};
const list = (key: KeyName, query: string) =>
  send(key, "GET", `/capabilities/actions?${query}`);
const run = (key: KeyName, body: unknown) =>
  send(key, "POST", "/capabilities/execute", body);

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

interface ActionView {
  id: string;
  label: string;
  tool: string;
  connection: { provider: string | null; account: string | null } | null;
  governance: string;
  intent: string;
  input: { properties: Record<string, unknown>; required: string[] };
}
async function actionsOf(key: KeyName, ws = CRM, intent = "publish_post") {
  const res = await list(key, `workspaceId=${ws}&intent=${intent}`);
  const body = await json(res);
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.actions as ActionView[];
}
const linkedinAction = async (key: KeyName = "poster") =>
  (await actionsOf(key)).find((a) => a.connection?.account === LINKEDIN.name)!;

const proposalRow = (id: string) =>
  q<{
    proposal_type: string;
    target_id: string;
    data: Record<string, unknown>;
    governance_reason: string | null;
    app_id: string | null;
    workspace_id: string | null;
  }>(
    `select proposal_type, target_id, data, governance_reason, app_id, workspace_id from proposals where id = $1`,
    [id]
  ).then((r) => r.rows[0]!);

const posts = () => h.calls.filter((c) => c.method !== "GET");

// ─── GET /capabilities/actions — one intent's actions, in the pod's words ──

describe("an app lists the actions for an intent it was granted", () => {
  it("one action per Postiz channel, each with its own input — never a verb's internals", async () => {
    const actions = await actionsOf("poster");
    expect(actions.map((a) => a.connection)).toEqual([
      { provider: "linkedin", account: "LinkedIn (Antoine)" },
      { provider: "bluesky", account: "Bluesky (Antoine)" },
    ]);
    for (const a of actions) {
      expect(a).toMatchObject({
        label: "Schedule a post",
        tool: "Postiz",
        governance: "propose",
        intent: "publish_post",
      });
      expect(Object.keys(a).sort()).toEqual([
        "connection",
        "governance",
        "id",
        "input",
        "intent",
        "label",
        "tool",
      ]);
      expect(JSON.stringify(a)).not.toContain("postiz_schedule");
      expect(JSON.stringify(a)).not.toContain(SCHEDULE);
      // The schedule verb needs a date: `when` is required for this action;
      // `media` and `link` are not mapped, so they are not offered.
      expect(Object.keys(a.input.properties).sort()).toEqual(["text", "when"]);
      expect(a.input.required.sort()).toEqual(["text", "when"]);
    }
    expect(new Set(actions.map((a) => a.id)).size).toBe(2);
    // Listing the channels ran the read verb; nothing was posted.
    expect(posts()).toEqual([]);
  });

  it("the person's own token lists the same actions", async () => {
    expect((await actionsOf("person")).map((a) => a.id)).toEqual(
      (await actionsOf("poster")).map((a) => a.id)
    );
  });

  it("an existing capability.run grant lists them too (every intent)", async () => {
    expect(await actionsOf("anyRun")).toHaveLength(2);
  });

  it.each([
    [
      "another space",
      "poster",
      `workspaceId=${BRAND}&intent=publish_post`,
      403,
      "GRANT_DENIED",
    ],
    [
      "another intent",
      "poster",
      `workspaceId=${CRM}&intent=send_message`,
      403,
      "GRANT_DENIED",
    ],
    [
      "an intent it holds, not this one",
      "messenger",
      `workspaceId=${CRM}&intent=publish_post`,
      403,
      "GRANT_DENIED",
    ],
    ["no intent", "poster", `workspaceId=${CRM}`, 400, "INTENT_REQUIRED"],
    [
      "an unknown intent",
      "poster",
      `workspaceId=${CRM}&intent=make_coffee`,
      400,
      "UNKNOWN_INTENT",
    ],
  ] as const)("refuses %s", async (_why, key, query, status, code) => {
    const res = await list(key, query);
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(status);
    expect(body.code).toBe(code);
    expect(body.actions).toBeUndefined();
  });

  it("a key holding no tool run never reaches the door (the fence)", async () => {
    const res = await list("reader", `workspaceId=${CRM}&intent=publish_post`);
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("GRANT_DOOR_UNSUPPORTED");
  });

  it("the person's operator key reads the door as before (every action, raw)", async () => {
    const res = await list(
      "operator",
      `workspaceId=${CRM}&intent=publish_post`
    );
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.actions).toEqual([
      expect.objectContaining({
        verbId: "postiz_schedule",
        enabled: true,
        parameters: expect.any(Object),
      }),
    ]);
  });
});

// ─── POST /capabilities/execute — the app asks; the person approves ────────

describe("an app asks one action to run: it is proposed, never run", () => {
  it("the app's agent key files a proposal carrying what the person reviews", async () => {
    const action = await linkedinAction();
    const res = await run("poster", {
      workspaceId: CRM,
      intent: "publish_post",
      actionId: action.id,
      input: { text: "Hello from the studio", when: "2026-11-02T09:00:00Z" },
      idempotencyKey: "post-1",
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(202);
    expect(body).toMatchObject({
      status: "proposed",
      proposed: true,
      ackState: "proposed",
    });
    expect(typeof body.reviewUrl).toBe("string");
    const row = await proposalRow(String(body.proposalId));
    expect(row).toMatchObject({
      proposal_type: "capability.run",
      target_id: SCHEDULE,
      governance_reason: "APP_OUTWARD_INTENT",
      app_id: CLIENT,
      workspace_id: CRM,
    });
    expect(row.data).toMatchObject({
      skillId: SCHEDULE,
      parameters: {
        content: "Hello from the studio",
        date: "2026-11-02T09:00:00Z",
        integrationId: "int-li",
        provider: "linkedin",
      },
      idempotencyKey: "post-1",
      intentRequest: {
        intent: "publish_post",
        actionId: action.id,
        tool: "Postiz",
        label: "Schedule a post",
        account: {
          id: "int-li",
          label: "LinkedIn (Antoine)",
          provider: "linkedin",
        },
        input: { text: "Hello from the studio", when: "2026-11-02T09:00:00Z" },
      },
    });
    expect(posts()).toEqual([]);
  });

  it("the person's own token proposes too: no owner bypass for an app (4A)", async () => {
    const action = await linkedinAction("person");
    const res = await run("person", {
      workspaceId: CRM,
      intent: "publish_post",
      actionId: action.id,
      input: { text: "Posted from my phone", when: "2026-11-03T09:00:00Z" },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(202);
    expect(body.status).toBe("proposed");
    expect((await proposalRow(String(body.proposalId))).governance_reason).toBe(
      "APP_OUTWARD_INTENT"
    );
    expect(posts()).toEqual([]);
  });

  it.each([
    [
      "a field the action does not map (never dropped)",
      { text: "Hi", when: "2026-11-02T09:00:00Z", link: "https://synap.live" },
    ],
    ["no text", { when: "2026-11-02T09:00:00Z" }],
    [
      "text over 3000 characters",
      { text: "x".repeat(3001), when: "2026-11-02T09:00:00Z" },
    ],
    ["a date that is not one", { text: "Hi", when: "next tuesday" }],
    ["no date for a scheduled post", { text: "Hi" }],
  ])("refuses %s (INVALID_INPUT)", async (_why, input) => {
    const action = await linkedinAction();
    const res = await run("poster", {
      workspaceId: CRM,
      intent: "publish_post",
      actionId: action.id,
      input,
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.code).toBe("INVALID_INPUT");
    expect((body.issues as unknown[]).length).toBeGreaterThan(0);
  });

  it("an account that is gone is not found (404), and nothing is filed", async () => {
    const action = await linkedinAction();
    h.channels = [BLUESKY];
    const before = (await q(`select id from proposals`)).rows.length;
    const res = await run("poster", {
      workspaceId: CRM,
      intent: "publish_post",
      actionId: action.id,
      input: { text: "Hi", when: "2026-11-02T09:00:00Z" },
    });
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe("ACTION_NOT_FOUND");
    expect((await q(`select id from proposals`)).rows.length).toBe(before);
  });

  it("an id that names no action is not found (404)", async () => {
    const res = await run("poster", {
      workspaceId: CRM,
      intent: "publish_post",
      actionId: "nothing.here",
      input: { text: "Hi", when: "2026-11-02T09:00:00Z" },
    });
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe("ACTION_NOT_FOUND");
  });

  it("an action of another intent never runs under this one (INTENT_MISMATCH)", async () => {
    // The direct-message verb serves send_message; its action id, asked as a
    // publish_post action by a key that may run any intent.
    const res = await run("anyRun", {
      workspaceId: CRM,
      intent: "publish_post",
      actionId: intentActionId(DM, ""),
      input: { text: "Hi" },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.code).toBe("INTENT_MISMATCH");
  });

  it.each([
    ["another space", "poster", BRAND, "publish_post"],
    ["another intent", "poster", CRM, "send_message"],
    ["an intent it does not hold", "messenger", CRM, "publish_post"],
  ] as const)("refuses %s (GRANT_DENIED)", async (_why, key, ws, intent) => {
    const res = await run(key, {
      workspaceId: ws,
      intent,
      actionId: "x.y",
      input: { text: "Hi" },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("GRANT_DENIED");
  });

  it("refuses a raw run from an app: no verb, no parameters (INVALID_REQUEST)", async () => {
    const res = await run("anyRun", {
      workspaceId: CRM,
      verbId: "postiz_schedule",
      parameters: {
        content: "Hi",
        integrationId: "int-li",
        provider: "linkedin",
        date: "2026-11-02T09:00:00Z",
      },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("INVALID_REQUEST");
    expect(posts()).toEqual([]);
  });

  it("caps an app at 30 outward asks an hour per intent (429 + retryAfter)", async () => {
    const action = await linkedinAction("busy");
    const ask = (i: number) =>
      run("busy", {
        workspaceId: CRM,
        intent: "publish_post",
        actionId: action.id,
        input: { text: `Post ${i}`, when: "2026-11-02T09:00:00Z" },
      });
    for (let i = 0; i < 30; i++) expect((await ask(i)).status).toBe(202);
    const res = await ask(30);
    const body = await json(res);
    expect(res.status).toBe(429);
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBe(String(body.retryAfter));
    // Another key is not touched by this one's cap.
    const other = await linkedinAction();
    expect(
      (
        await run("poster", {
          workspaceId: CRM,
          intent: "publish_post",
          actionId: other.id,
          input: { text: "Still mine", when: "2026-11-02T09:00:00Z" },
        })
      ).status
    ).toBe(202);
  }, 120_000);

  it("the person's operator key runs the verb as before (owner, unfenced)", async () => {
    const res = await run("operator", {
      workspaceId: CRM,
      verbId: "postiz_schedule",
      parameters: {
        content: "By hand",
        integrationId: "int-li",
        provider: "linkedin",
        date: "2026-11-02T09:00:00Z",
      },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("run");
    expect(posts()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ content: "By hand" }),
      }),
    ]);
  });
});
