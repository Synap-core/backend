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
 *  - an unfenced operator, or an existing `capability.run` grant, changed;
 *  - an agent's key (no app) unable to ask for the intent form, or its
 *    outward intent run (or the person's own) running instead of proposing;
 *  - a LinkedIn id sent through an Instagram account;
 *  - the sends to one person not findable from their page (`recipient`).
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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  /** The accounts Unipile lists right now. */
  accounts: [] as Array<Record<string, unknown>>,
  /** What the LinkedIn profile lookup answers right now. */
  found: null as unknown,
  /** A tool's pod connections, per tool id, when a test sets them. */
  credentials: {} as Record<string, () => Promise<unknown[]>>,
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
      spec: { method: string; pathTemplate?: string },
      params: Record<string, unknown>
    ) => {
      h.calls.push({ method: spec.method, params });
      if (spec.pathTemplate === "/linkedin/find-profile") return h.found;
      if (spec.pathTemplate === "/boom")
        throw new Error("the provider did not answer");
      if (spec.pathTemplate === "/empty") return { items: [] };
      if (spec.method === "GET")
        return spec.pathTemplate === "/accounts"
          ? { items: h.accounts }
          : { channels: h.channels };
      return [{ postId: "p-1", integration: params.integrationId }];
    },
  })
);
vi.mock(
  "../../../services/capabilities/capability-connections.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../services/capabilities/capability-connections.js")
      >();
    return {
      ...actual,
      listCredentials: async (toolId: string, userId: string) =>
        h.credentials[toolId]
          ? h.credentials[toolId]!()
          : actual.listCredentials(toolId, userId),
    };
  }
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
import { registerProposalsRoutes } from "./proposals.js";
import { officialCatalogUrl } from "@synap/jobs/workers/cp-catalog-sync.js";
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
  /** The CRM: send messages and connection requests, read the people in CRM. */
  crm: app([
    "capability.send_message.run",
    "capability.request_connection.run",
    "entity.*.read",
  ]),
  /** The CRM looking up a person's LinkedIn profile (enrich_entity, 0410). */
  finder: app(["capability.enrich_entity.run", "entity.*.read"]),
  /** A poster used only to exhaust the per-intent cap. */
  busy: app(["capability.publish_post.run"]),
  /** The CRM reading its sends waiting for approval. */
  crmReview: app([
    "capability.send_message.run",
    "entity.*.read",
    "proposal.read",
  ]),
  /** An app that shares updates (the unavailable fixture's intent). */
  sharer: app(["capability.share_update.run"]),
  /** An app granted an intent this pod has no input shape for. */
  lister: app(["capability.list_records.run"]),
  /** An agent's own key (no app): unbounded, acting for the person. */
  agent: app(["*"], { workspaceIds: null, clientId: null }),
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
  registerProposalsRoutes(hub);
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

// ─── A recipient: the pod finds the address, ranks the channels ───────────
//
// CRM consolidation plan, Lane 2 (founder 2026-10-28: the POD resolves the
// recipient, the POD ranks channels). Unipile reaches two accounts through
// one key (LinkedIn, Instagram); a mail tool reaches one inbox. The app names
// a person by entity id and never sees an address or a provider id.

describe("an app sends to a person it names: the pod finds the address", () => {
  const UNIPILE = randomUUID();
  const MAIL = randomUUID();
  const ACCOUNTS = randomUUID(); // unipile_list_accounts
  const REPLY = randomUUID(); // unipile_send_message: the chat with them
  const FIRST = randomUUID(); // linkedin_send_first_message: by attendee
  const INVITE = randomUUID(); // linkedin_send_invite: request_connection
  const MAIL_SEND = randomUUID(); // mail_send: by email
  const MARIE = randomUUID(); // in CRM: email, LinkedIn id, a LinkedIn chat
  const PAUL = randomUUID(); // in CRM: no address at all
  const HIDDEN = randomUUID(); // in Brand: outside the CRM's grant
  const LI = { id: "acc-li", name: "Antoine Servant", type: "LINKEDIN" };
  const IG = { id: "acc-ig", name: "antoiinesrvt", type: "INSTAGRAM" };
  const ACCOUNT_SOURCE = {
    verb: "unipile_list_accounts",
    id: "id",
    label: "name",
    provider: "type",
  };

  beforeAll(async () => {
    // The intents' real input shapes: migration 0369, run as shipped.
    await q(
      `update capability_intents set input_schema = null where slug = 'send_message'`
    );
    await q(
      `insert into capability_intents (slug, effect, statement, synonyms) values ('request_connection','write','Ask a person to connect','{}')`
    );
    await h.client!.exec(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../../database/migrations/0369_intent_input_send_message.sql",
            import.meta.url
          )
        ),
        "utf8"
      )
    );
    for (const [id, name] of [
      [UNIPILE, "unipile_linkedin"],
      [MAIL, "mail"],
    ] as const)
      await q(
        `insert into tools (id, name, kind, approved, created_by, workspace_id) values ($1,$2,'api',true,$3,null)`,
        [id, name, OWNER]
      );
    const skill = async (
      id: string,
      tool: string,
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
        [randomUUID(), id, tool]
      );
    };
    const post = (path: string) => ({
      tool: "unipile_linkedin",
      method: "POST",
      pathTemplate: path,
    });
    await skill(
      ACCOUNTS,
      UNIPILE,
      "unipile_list_accounts",
      "list_records",
      null,
      {},
      {
        tool: "unipile_linkedin",
        method: "GET",
        pathTemplate: "/accounts",
        responseShape: {
          collectionPath: "items",
          item: { id: "id", name: "name", type: "type" },
        },
      },
      { readOnly: true }
    );
    await skill(
      REPLY,
      UNIPILE,
      "unipile_send_message",
      "send_message",
      {
        params: {
          accountId: "$account.id",
          threadId: "$to.chat",
          text: "$.text",
        },
        accounts: ACCOUNT_SOURCE,
      },
      { accountId: "string", threadId: "string", text: "string" },
      post("/chats/{threadId}/messages"),
      { verbType: "write" }
    );
    await skill(
      FIRST,
      UNIPILE,
      "linkedin_send_first_message",
      "send_message",
      {
        params: {
          accountId: "$account.id",
          attendeeId: "$to.attendee",
          text: "$.text",
        },
        accounts: ACCOUNT_SOURCE,
      },
      { accountId: "string", attendeeId: "string", text: "string" },
      post("/chats"),
      { verbType: "write" }
    );
    await skill(
      INVITE,
      UNIPILE,
      "linkedin_send_invite",
      "request_connection",
      {
        params: {
          accountId: "$account.id",
          providerId: "$to.linkedin.providerId",
          message: "$.text",
        },
        accounts: ACCOUNT_SOURCE,
      },
      { accountId: "string", providerId: "string", message: "string?" },
      post("/users/invite"),
      { verbType: "write" }
    );
    await skill(
      MAIL_SEND,
      MAIL,
      "mail_send",
      "send_message",
      { params: { to: "$to.email", subject: "$.subject", body: "$.text" } },
      { to: "string", subject: "string?", body: "string" },
      { tool: "mail", method: "POST", pathTemplate: "/send" },
      { verbType: "write" }
    );
    const tool = (id: string, name: string, verbs: unknown[]) => ({
      kind: "tool",
      id,
      name,
      description: name,
      enabled: true,
      governance: "auto",
      catalogOnly: false,
      verbs,
    });
    h.registry = [
      ...h.registry,
      tool(UNIPILE, "unipile_linkedin", [
        verb("unipile_list_accounts", "List accounts", "list_records", "read"),
        verb(
          "unipile_send_message",
          "Reply in the chat",
          "send_message",
          "write"
        ),
        verb(
          "linkedin_send_first_message",
          "Send a first message",
          "send_message",
          "write"
        ),
        verb(
          "linkedin_send_invite",
          "Send a connection request",
          "request_connection",
          "write"
        ),
      ]),
      tool(MAIL, "mail", [
        verb("mail_send", "Send an email", "send_message", "write"),
      ]),
    ];

    const person = (id: string, ws: string, title: string, props: unknown) =>
      q(
        `insert into entities (id, user_id, workspace_id, type, title, properties) values ($1,$2,$3,'person',$4,$5::jsonb)`,
        [id, OWNER, ws, title, JSON.stringify(props)]
      );
    await person(MARIE, CRM, "Marie Dupont", {
      email: "marie@example.test",
      linkedinProviderId: "ACoAAMarie",
    });
    await person(PAUL, CRM, "Paul Martin", {});
    await person(HIDDEN, BRAND, "Someone in Brand", {
      email: "brand@example.test",
    });
    // The LinkedIn chat the pod holds with Marie, on the LinkedIn account,
    // last used yesterday.
    await q(
      `insert into channels (id, user_id, workspace_id, channel_type, title, context_object_type, context_object_id, external_source, external_channel_id, external_id, metadata)
       values ($1,$2,$3,'external','Marie Dupont','entity',$4,'linkedin','chat-marie','chat-marie',$5::jsonb)`,
      [
        randomUUID(),
        OWNER,
        CRM,
        MARIE,
        JSON.stringify({
          accountId: "acc-li",
          lastMessageAt: "2026-10-27T10:00:00Z",
        }),
      ]
    );
    // An email to Marie went out last week: older than the LinkedIn chat.
    const touch = randomUUID();
    await q(
      `insert into entities (id, user_id, workspace_id, type, title, properties, status) values ($1,$2,$3,'outreach-touch','First email',$4::jsonb,'sent')`,
      [
        touch,
        OWNER,
        CRM,
        JSON.stringify({ channel: "email", sentDate: "2026-10-20" }),
      ]
    );
    await q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,$5,'sent_to')`,
      [randomUUID(), OWNER, CRM, touch, MARIE]
    );
  }, 120_000);

  beforeEach(() => {
    h.accounts = [LI, IG];
  });

  const forMarie = async (intent = "send_message", subject = MARIE) => {
    const res = await list(
      "crm",
      `workspaceId=${CRM}&intent=${intent}&subject=${subject}`
    );
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body.actions as Array<
      ActionView & { reach?: { ok: boolean; why?: string } }
    >;
  };
  const named = (a: ActionView) =>
    `${a.label} · ${a.connection?.account ?? a.tool}`;

  it("lists each action with its reach, ranked: reachable, then the channel last used with her", async () => {
    const actions = await forMarie();
    expect(actions.map((a) => [named(a), a.reach])).toEqual([
      // The LinkedIn chat (yesterday), then her email (last week), then the
      // reachable ones never used with her, in the pod's order.
      ["Reply in the chat · Antoine Servant", { ok: true }],
      ["Send a first message · Antoine Servant", { ok: true }],
      ["Send an email · Mail", { ok: true }],
      ["Send a direct message · Postiz", { ok: true }],
      [
        "Reply in the chat · antoiinesrvt",
        {
          ok: false,
          why: "No conversation with Marie Dupont on antoiinesrvt yet.",
        },
      ],
      [
        "Send a first message · antoiinesrvt",
        { ok: false, why: "No Instagram id on file for Marie Dupont." },
      ],
    ]);
    // Never an address, a provider id or a chat id on the app's side.
    const wire = JSON.stringify(actions);
    for (const secret of ["marie@example.test", "ACoAAMarie", "chat-marie"])
      expect(wire).not.toContain(secret);
    // An action that sends to someone asks for `to`.
    const mail = actions.find((a) => a.tool === "Mail")!;
    expect(Object.keys(mail.input.properties).sort()).toEqual([
      "subject",
      "text",
      "to",
    ]);
    expect(mail.input.required.sort()).toEqual(["text", "to"]);
  });

  it("without a subject, the list is as before: no reach, no ranking", async () => {
    const res = await list("crm", `workspaceId=${CRM}&intent=send_message`);
    const actions = (await json(res)).actions as Array<Record<string, unknown>>;
    expect(res.status).toBe(200);
    expect(actions.every((a) => !("reach" in a))).toBe(true);
  });

  it("someone with no address on file is reachable by nothing that needs one", async () => {
    const actions = await forMarie("send_message", PAUL);
    expect(
      actions.filter((a) => a.tool !== "Postiz").map((a) => a.reach?.ok)
    ).toEqual([false, false, false, false, false]);
    expect(actions.find((a) => a.tool === "Mail")!.reach).toEqual({
      ok: false,
      why: "No email on file for Paul Martin.",
    });
  });

  it.each([
    ["outside the key's grant", "crm", HIDDEN],
    ["that does not exist", "crm", randomUUID()],
    ["that is not an id", "crm", "marie"],
    ["when the key reads no entities", "messenger", MARIE],
  ] as const)(
    "refuses a subject %s (SUBJECT_NOT_READABLE)",
    async (_why, key, subject) => {
      const res = await list(
        key,
        `workspaceId=${CRM}&intent=send_message&subject=${subject}`
      );
      const body = await json(res);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(body.code).toBe("SUBJECT_NOT_READABLE");
      expect(body.actions).toBeUndefined();
    }
  );

  it("a send is proposed with the address the POD resolved, and reviewed by name", async () => {
    const reply = (await forMarie())[0]!;
    const res = await run("crm", {
      workspaceId: CRM,
      intent: "send_message",
      actionId: reply.id,
      input: { to: MARIE, text: "Bonjour Marie" },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(202);
    const row = await proposalRow(String(body.proposalId));
    expect(row).toMatchObject({
      target_id: REPLY,
      governance_reason: "APP_OUTWARD_INTENT",
    });
    expect(row.data).toMatchObject({
      parameters: {
        accountId: "acc-li",
        threadId: "chat-marie",
        text: "Bonjour Marie",
      },
      summary:
        "Reply in the chat to Marie Dupont from Antoine Servant on LinkedIn",
      intentRequest: {
        recipient: { id: MARIE, name: "Marie Dupont" },
        account: {
          id: "acc-li",
          label: "Antoine Servant",
          provider: "LINKEDIN",
        },
        input: { to: MARIE, text: "Bonjour Marie" },
      },
    });
    expect(posts()).toEqual([]);
  });

  it("an email goes to the address on file, with its subject", async () => {
    const mail = (await forMarie()).find((a) => a.tool === "Mail")!;
    const res = await run("crm", {
      workspaceId: CRM,
      intent: "send_message",
      actionId: mail.id,
      input: { to: MARIE, text: "Hello", subject: "Our call" },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(202);
    const row = await proposalRow(String(body.proposalId));
    expect(row.data).toMatchObject({
      parameters: {
        to: "marie@example.test",
        subject: "Our call",
        body: "Hello",
      },
      summary: "Send an email to Marie Dupont",
    });
  });

  it("a connection request goes to her LinkedIn id", async () => {
    const actions = await forMarie("request_connection");
    const li = actions.find(
      (a) => a.connection?.account === "Antoine Servant"
    )!;
    expect(li.reach).toEqual({ ok: true });
    const res = await run("crm", {
      workspaceId: CRM,
      intent: "request_connection",
      actionId: li.id,
      input: { to: MARIE },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(202);
    expect((await proposalRow(String(body.proposalId))).data).toMatchObject({
      parameters: { accountId: "acc-li", providerId: "ACoAAMarie" },
    });
  });

  it("a LinkedIn invitation never goes through her Instagram account", async () => {
    const ig = (await forMarie("request_connection")).find(
      (a) => a.connection?.account === "antoiinesrvt"
    )!;
    expect(ig.reach).toEqual({
      ok: false,
      why: "Instagram can't reach Marie Dupont on LinkedIn.",
    });
    const before = (await q(`select id from proposals`)).rows.length;
    const res = await run("crm", {
      workspaceId: CRM,
      intent: "request_connection",
      actionId: ig.id,
      input: { to: MARIE },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.code).toBe("RECIPIENT_UNREACHABLE");
    expect((await q(`select id from proposals`)).rows.length).toBe(before);
  });

  it("refuses a send the pod cannot address (RECIPIENT_UNREACHABLE), and files nothing", async () => {
    const mail = (await forMarie()).find((a) => a.tool === "Mail")!;
    const before = (await q(`select id from proposals`)).rows.length;
    const res = await run("crm", {
      workspaceId: CRM,
      intent: "send_message",
      actionId: mail.id,
      input: { to: PAUL, text: "Hello" },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body).toMatchObject({
      code: "RECIPIENT_UNREACHABLE",
      why: "No email on file for Paul Martin.",
    });
    expect((await q(`select id from proposals`)).rows.length).toBe(before);
  });

  it.each([
    ["outside the key's grant", HIDDEN],
    ["that does not exist", randomUUID()],
  ])(
    "refuses to send to someone %s (SUBJECT_NOT_READABLE), and files nothing",
    async (_why, to) => {
      const mail = (await forMarie()).find((a) => a.tool === "Mail")!;
      const before = (await q(`select id from proposals`)).rows.length;
      const res = await run("crm", {
        workspaceId: CRM,
        intent: "send_message",
        actionId: mail.id,
        input: { to, text: "Hello" },
      });
      const body = await json(res);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(body.code).toBe("SUBJECT_NOT_READABLE");
      expect((await q(`select id from proposals`)).rows.length).toBe(before);
    }
  );

  it("never takes an address from the app: a field the action does not read is refused", async () => {
    const mail = (await forMarie()).find((a) => a.tool === "Mail")!;
    const res = await run("crm", {
      workspaceId: CRM,
      intent: "send_message",
      actionId: mail.id,
      input: { to: PAUL, text: "Hello", email: "someone@else.test" },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("INVALID_INPUT");
  });

  // ── An agent drafting for the person (decision 790baeb5: the AI proposes
  //    sends, the person approves them whenever). Its key is not an app's: it
  //    asks for the intent form, and its outward run still files a proposal.

  it("an agent's key reads the raw projection unless it asks for the intent form", async () => {
    const raw = await list("agent", `workspaceId=${CRM}&intent=send_message`);
    const rawBody = await json(raw);
    expect(raw.status, JSON.stringify(rawBody)).toBe(200);
    expect((rawBody.actions as unknown[]).length).toBeGreaterThan(0);
    expect(
      (rawBody.actions as Array<Record<string, unknown>>).every(
        (a) => typeof a.verbId === "string"
      )
    ).toBe(true);

    const asked = await list(
      "agent",
      `workspaceId=${CRM}&intent=send_message&form=intent`
    );
    const askedBody = await json(asked);
    expect(asked.status, JSON.stringify(askedBody)).toBe(200);
    const views = askedBody.actions as Array<Record<string, unknown>>;
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      expect(v).not.toHaveProperty("verbId");
      expect(v).not.toHaveProperty("reach");
      expect(typeof v.id).toBe("string");
    }

    expect(
      (await list("agent", `workspaceId=${CRM}&intent=send_message&form=raw`))
        .status
    ).toBe(400);
  });

  it("an agent's key listing for a subject gets her reach and ranking", async () => {
    const res = await list(
      "agent",
      `workspaceId=${CRM}&intent=send_message&subject=${MARIE}`
    );
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    const actions = body.actions as Array<
      ActionView & { reach?: { ok: boolean; why?: string } }
    >;
    expect(actions.map((a) => [named(a), a.reach]).slice(0, 2)).toEqual([
      ["Reply in the chat · Antoine Servant", { ok: true }],
      ["Send a first message · Antoine Servant", { ok: true }],
    ]);
    expect(JSON.stringify(actions)).not.toContain("ACoAAMarie");
  });

  it("an agent's send is proposed for the person, never run", async () => {
    const res0 = await list(
      "agent",
      `workspaceId=${CRM}&intent=send_message&subject=${MARIE}`
    );
    const reply = ((await json(res0)).actions as ActionView[])[0]!;
    const res = await run("agent", {
      workspaceId: CRM,
      intent: "send_message",
      actionId: reply.id,
      input: { to: MARIE, text: "Bonjour Marie, from the agent" },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(202);
    const row = (
      await q<{
        governance_reason: string | null;
        agent_user_id: string | null;
        app_id: string | null;
        data: Record<string, unknown>;
      }>(
        `select governance_reason, agent_user_id, app_id, data from proposals where id = $1`,
        [String(body.proposalId)]
      )
    ).rows[0]!;
    expect(row).toMatchObject({
      governance_reason: "INTENT_OUTWARD",
      agent_user_id: AGENT,
      app_id: null,
    });
    expect(row.data).toMatchObject({
      parameters: { accountId: "acc-li", threadId: "chat-marie" },
      intentRequest: { recipient: { id: MARIE, name: "Marie Dupont" } },
    });
    expect(posts()).toEqual([]);
  });

  it("an intent action asked for with the person's own key is proposed too (no owner bypass)", async () => {
    const res0 = await list(
      "operator",
      `workspaceId=${CRM}&intent=send_message&subject=${MARIE}`
    );
    const mail = ((await json(res0)).actions as ActionView[]).find(
      (a) => a.tool === "Mail"
    )!;
    const res = await run("operator", {
      workspaceId: CRM,
      intent: "send_message",
      actionId: mail.id,
      input: { to: MARIE, text: "By the person, through the intent form" },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(202);
    expect((await proposalRow(String(body.proposalId))).governance_reason).toBe(
      "INTENT_OUTWARD"
    );
    expect(posts()).toEqual([]);
  });

  it("an agent's run body is told apart by its actionId: a raw body stays raw", async () => {
    const res = await run("agent", {
      workspaceId: CRM,
      intent: "send_message",
      actionId: "x.y",
      input: { to: MARIE, text: "Hi" },
      verbId: "mail_send",
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  // ── "Sends waiting for your approval" on a lead: the proposals of the
  //    intent actions sent to her, and only those.

  it("lists the sends proposed to one person (GET /proposals?recipient=)", async () => {
    const sentTo = async (key: KeyName, who: string) => {
      const res = await send(
        key,
        "GET",
        `/proposals?status=pending&limit=200&recipient=${who}`
      );
      const body = await json(res);
      expect(res.status, JSON.stringify(body)).toBe(200);
      return body.proposals as Array<{
        id: string;
        data: { intentRequest?: { recipient?: { id: string } } };
      }>;
    };
    const all = await q<{ id: string }>(
      `select id from proposals where status = 'pending'`
    );
    const toMarie = await sentTo("operator", MARIE);
    // The app's sends and the agent's, and nothing else of the queue.
    expect(toMarie.length).toBeGreaterThanOrEqual(4);
    expect(toMarie.length).toBeLessThan(all.rows.length);
    for (const p of toMarie)
      expect(p.data.intentRequest?.recipient?.id).toBe(MARIE);
    expect(await sentTo("operator", PAUL)).toEqual([]);
    // An app that reads proposals in its space sees the same list.
    expect((await sentTo("crmReview", MARIE)).map((p) => p.id).sort()).toEqual(
      toMarie.map((p) => p.id).sort()
    );
    expect(
      (await send("operator", "GET", "/proposals?recipient=marie")).status
    ).toBe(400);
  });
});

// ─── enrich_entity (0410): an app looks a person up with the person's tool ──
//
// CRM "Find their LinkedIn" (founder 2026-11-07: "for actions that are just
// an API with a parameter ... it should just launch the underlying tool, no
// need for ai"). The intent's input is migration 0410's, run as shipped; the
// lookup verb maps it the way the catalog's linkedin_find_profile does. Rules
// out: an app offered no lookup (no input shape, the state before 0410), the
// lookup filed as a proposal or its result withheld (enrich_entity is a read:
// the app gets the answer inline), the verb's parameters or an extra field
// taken from the app, and the company the verb needs left optional.
// Cannot see: the real verb's sandboxed code (here a provider call answers
// for it), a real Unipile.

describe("an app looks a person up with the person's tool (enrich_entity)", () => {
  const PEOPLE = randomUUID(); // the lookup tool
  const PEOPLE_ACCOUNTS = randomUUID(); // people_list_accounts: account source
  const FIND = randomUUID(); // linkedin_find_profile: enrich_entity, mapped
  const LI = { id: "acc-li", name: "Antoine Servant", type: "LINKEDIN" };
  const MATCH = {
    matched: true,
    profile: {
      name: "Jean-Luc Le Noguès",
      headline: "CEO at Acme",
      url: "https://www.linkedin.com/in/jlln",
    },
    properties: {
      linkedinUrl: "https://www.linkedin.com/in/jlln",
      linkedinProviderId: "ACoAAJLLN",
    },
  };

  beforeAll(async () => {
    await q(
      `insert into capability_intents (slug, effect, statement, synonyms) values ('enrich_entity','read','Add known facts to a person or company we already have','{}')`
    );
    await h.client!.exec(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../../database/migrations/0410_intent_input_enrich_entity.sql",
            import.meta.url
          )
        ),
        "utf8"
      )
    );
    await q(
      `insert into tools (id, name, kind, approved, created_by, workspace_id) values ($1,'people_lookup','api',true,$2,null)`,
      [PEOPLE, OWNER]
    );
    const skill = async (
      id: string,
      name: string,
      intent: string,
      inputMap: unknown,
      parameters: unknown,
      providerSpec: unknown
    ) => {
      await q(
        `insert into skills (id, user_id, name, kind, scope, status, approved, intent, input_map, parameters, provider_spec, metadata)
         values ($1,$2,$3,'declarative','pod','active',true,$4,$5::jsonb,$6::jsonb,$7::jsonb,'{"readOnly":true}'::jsonb)`,
        [
          id,
          OWNER,
          name,
          intent,
          inputMap === null ? null : JSON.stringify(inputMap),
          JSON.stringify(parameters),
          JSON.stringify(providerSpec),
        ]
      );
      await q(
        `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1,'skill',$2,'tool',$3,'requires')`,
        [randomUUID(), id, PEOPLE]
      );
    };
    await skill(
      PEOPLE_ACCOUNTS,
      "people_list_accounts",
      "list_records",
      null,
      {},
      {
        tool: "people_lookup",
        method: "GET",
        pathTemplate: "/accounts",
        responseShape: {
          collectionPath: "items",
          item: { id: "id", name: "name", type: "type" },
        },
      }
    );
    // The catalog's map for linkedin_find_profile (app-bases
    // unipile-linkedin.capability.json), on an account source of its tool.
    await skill(
      FIND,
      "linkedin_find_profile",
      "enrich_entity",
      {
        params: {
          fullName: "$.name",
          company: "$.company",
          accountId: "$account.id",
        },
        accounts: {
          verb: "people_list_accounts",
          id: "id",
          label: "name",
          provider: "type",
        },
      },
      { fullName: "string", company: "string", accountId: "string" },
      {
        tool: "people_lookup",
        method: "GET",
        pathTemplate: "/linkedin/find-profile",
      }
    );
    h.registry = [
      ...h.registry,
      {
        kind: "tool",
        id: PEOPLE,
        name: "people_lookup",
        description: "people_lookup",
        enabled: true,
        governance: "auto",
        catalogOnly: false,
        verbs: [
          verb("people_list_accounts", "List accounts", "list_records", "read"),
          // The registry projects the skill's authored `metadata.readOnly`
          // (the catalog's linkedin_find_profile declares it): the gate runs a
          // declared read at once, so the door says `auto` (run-posture.ts).
          {
            ...verb(
              "linkedin_find_profile",
              "Find their LinkedIn profile",
              "enrich_entity",
              "read"
            ),
            declaredReadOnly: true,
          },
        ],
      },
    ];
  }, 120_000);

  beforeEach(() => {
    h.accounts = [LI];
    h.found = MATCH;
  });

  const lookups = () => actionsOf("finder", CRM, "enrich_entity");
  const lookup = (actionId: string, input: unknown) =>
    run("finder", {
      workspaceId: CRM,
      intent: "enrich_entity",
      actionId,
      input,
    });

  it("lists the lookup for an app granted enrich_entity: its input is { name, company }", async () => {
    const actions = await lookups();
    expect(
      actions.map((a) => [a.label, a.connection?.account, a.governance])
    ).toEqual([["Find their LinkedIn profile", LI.name, "auto"]]);
    const [find] = actions;
    expect(Object.keys(find!.input.properties).sort()).toEqual([
      "company",
      "name",
    ]);
    // The verb needs the company: its action requires it, the intent does not.
    expect([...find!.input.required].sort()).toEqual(["company", "name"]);
    expect(JSON.stringify(find)).not.toMatch(/fullName|accountId|skill/);
  });

  it("runs the lookup at once and hands the app its answer: no proposal, no AI", async () => {
    const [find] = await lookups();
    const before = await q<{ n: number }>(
      `select count(*)::int as n from proposals`
    );
    const res = await lookup(find!.id, {
      name: "Jean-Luc Le Noguès",
      company: "Acme",
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("run");
    expect(JSON.stringify(body.result)).toContain(
      MATCH.properties.linkedinProviderId
    );
    const calls = h.calls.filter((c) => "fullName" in c.params);
    expect(calls).toEqual([
      {
        method: "GET",
        params: {
          fullName: "Jean-Luc Le Noguès",
          company: "Acme",
          accountId: LI.id,
        },
      },
    ]);
    const after = await q<{ n: number }>(
      `select count(*)::int as n from proposals`
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("refuses a lookup with no company, or a field the action does not read", async () => {
    const [find] = await lookups();
    for (const input of [
      { name: "Jean-Luc Le Noguès" },
      {
        name: "Jean-Luc Le Noguès",
        company: "Acme",
        linkedinUrl: "https://x",
      },
    ]) {
      const res = await lookup(find!.id, input);
      const body = await json(res);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(body.code).toBe("INVALID_INPUT");
    }
    expect(h.calls.filter((c) => "fullName" in c.params)).toEqual([]);
  });

  it("an app not granted enrich_entity is refused (GRANT_DENIED)", async () => {
    const res = await list("crm", `workspaceId=${CRM}&intent=enrich_entity`);
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("GRANT_DENIED");
  });
});

// ─── unavailable: every verb declaring the intent that is not offered ──────

describe("the door says why an action is not offered (unavailable)", () => {
  // Plan 498b6be3 S1, founder D5 (all reasons), D-C (`update`), D-D (one
  // entry per tool and account), D-E (the permission named). One tool per
  // cause, all declaring `share_update`.
  const SHARE_INPUT = {
    type: "object",
    properties: { text: { type: "string", minLength: 1 } },
    required: ["text"],
    additionalProperties: false,
  };
  const C_DRAFT = randomUUID(); // drafty's container
  const C_OLD = randomUUID(); // oldpack's container: its template moved on
  const C_MIS = randomUUID(); // mismatch's container: no update known
  const T_NOSOURCE = randomUUID();
  const T_EMPTY = randomUUID();
  const T_FLAKY = randomUUID();
  const T_SLACKISH = randomUUID();
  const ENABLE = {
    kind: "enable",
    hint: "Its actions are off. Turn them on to use it.",
    url: "https://pod.test/open/capability/c-locked",
    opensIn: "web",
  };
  const ACCOUNTS_OF = (tool: string) => ({
    verb: `${tool}_accounts`,
    id: "id",
    label: "name",
    provider: "type",
  });

  interface Unavailable {
    why: string;
    label: string;
    tool: string | null;
    connection: { provider: string | null; account: string | null } | null;
    retryable: boolean;
    fix: {
      kind: string;
      hint: string;
      url?: string;
      opensIn?: string;
    } | null;
  }
  const listing = async (key: KeyName = "sharer", intent = "share_update") => {
    const res = await list(key, `workspaceId=${CRM}&intent=${intent}`);
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body as { actions: ActionView[]; unavailable: Unavailable[] };
  };
  const entriesOf = async (tool: string) =>
    (await listing()).unavailable.filter((u) => u.tool === tool);

  beforeAll(async () => {
    await q(
      `insert into capability_intents (slug, effect, statement, synonyms, input_schema) values ('share_update','write','Share an update','{}',$1::jsonb)`,
      [JSON.stringify(SHARE_INPUT)]
    );
    const skill = async (
      name: string,
      intent: string | null,
      inputMap: unknown,
      providerSpec: unknown = {
        tool: name,
        method: "POST",
        pathTemplate: "/x",
      },
      metadata: unknown = { verbType: "write" },
      toolId: string | null = null
    ) => {
      const id = randomUUID();
      await q(
        `insert into skills (id, user_id, name, kind, scope, status, approved, intent, input_map, parameters, provider_spec, metadata)
         values ($1,$2,$3,'declarative','pod','active',true,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`,
        [
          id,
          OWNER,
          name,
          intent,
          inputMap === null ? null : JSON.stringify(inputMap),
          JSON.stringify({ text: "string" }),
          JSON.stringify(providerSpec),
          JSON.stringify(metadata),
        ]
      );
      if (toolId)
        await q(
          `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1,'skill',$2,'tool',$3,'requires')`,
          [randomUUID(), id, toolId]
        );
    };
    // The installed versions that fall short, and the tools whose accounts
    // the door reads.
    await skill("oldpack_share", null, { params: { text: "$.text" } });
    await skill("mismatch_share", "publish_post", {
      params: { text: "$.text" },
    });
    await skill("nomap_share", "share_update", null);
    await skill("slackish_share", "share_update", {
      params: { text: "$.text" },
    });
    await skill("flaky_share", "share_update", { params: { text: "$.text" } });
    for (const [toolId, name, path] of [
      [T_NOSOURCE, "nosource", "/boom"],
      [T_EMPTY, "emptytool", "/empty"],
    ] as const) {
      await q(
        `insert into tools (id, name, kind, approved, created_by, workspace_id) values ($1,$2,'api',true,$3,null)`,
        [toolId, name, OWNER]
      );
      await skill(
        `${name}_accounts`,
        "list_records",
        null,
        {
          tool: name,
          method: "GET",
          pathTemplate: path,
          responseShape: {
            collectionPath: "items",
            item: { id: "id", name: "name", type: "type" },
          },
        },
        { readOnly: true },
        toolId
      );
      await skill(
        `${name}_share`,
        "share_update",
        {
          params: { accountId: "$account.id", text: "$.text" },
          accounts: ACCOUNTS_OF(name),
        },
        { tool: name, method: "POST", pathTemplate: "/share" },
        { verbType: "write" },
        toolId
      );
    }
    // oldpack holds an older version of its template than the catalog's.
    await q(
      `insert into capabilities (id, created_by, name, metadata) values ($1,$2,'oldpack',$3::jsonb)`,
      [
        C_OLD,
        OWNER,
        JSON.stringify({ templateKey: "oldpack", contentHash: "v1" }),
      ]
    );
    await q(
      `insert into cp_catalog_cache (id, source, kind, slug, name, content_hash) values ($1,$2,'capability','oldpack','Oldpack','v2')`,
      [randomUUID(), officialCatalogUrl()]
    );

    const share = (tool: string, extra: Record<string, unknown> = {}) => ({
      ...verb(`${tool}_share`, "Share an update", "share_update", "write"),
      ...extra,
    });
    const tool = (
      id: string,
      name: string,
      verbs: unknown[],
      extra: Record<string, unknown> = {}
    ) => ({
      kind: "tool",
      id,
      name,
      description: name,
      enabled: true,
      governance: "auto",
      catalogOnly: false,
      verbs,
      ...extra,
    });
    h.registry = [
      ...h.registry,
      // Two of its verbs are off: it says so once (one entry per tool).
      tool(
        randomUUID(),
        "drafty",
        [
          share("drafty"),
          verb("drafty_share_later", "Share later", "share_update", "write"),
        ],
        { enabled: false, containerId: C_DRAFT }
      ),
      tool(randomUUID(), "offline", [share("offline")], {
        connection: { required: true, connected: false, provider: "slack" },
      }),
      tool(randomUUID(), "twice", [share("twice")], {
        enabled: false,
        connection: { required: true, connected: false, provider: "slack" },
      }),
      tool(randomUUID(), "retired", [share("retired")], { runnable: false }),
      tool(randomUUID(), "locked", [
        share("locked", {
          backingSkillExecutable: false,
          blocked: "not_enabled",
          enable: ENABLE,
        }),
      ]),
      tool(randomUUID(), "oldpack", [share("oldpack")], {
        containerId: C_OLD,
      }),
      tool(randomUUID(), "mismatch", [share("mismatch")], {
        containerId: C_MIS,
      }),
      tool(randomUUID(), "nomap", [share("nomap")]),
      tool(T_NOSOURCE, "nosource", [
        verb("nosource_accounts", "List accounts", "list_records", "read"),
        share("nosource"),
      ]),
      tool(T_EMPTY, "emptytool", [
        verb("emptytool_accounts", "List accounts", "list_records", "read"),
        share("emptytool"),
      ]),
      tool(T_FLAKY, "flaky", [share("flaky")], {
        connection: { required: true, connected: true, provider: "slack" },
      }),
      tool(T_SLACKISH, "slackish", [share("slackish")], {
        connection: { required: true, connected: true, provider: "slack" },
      }),
    ];
    const cred = (id: string, account: string, health: string) => ({
      id,
      label: account,
      accountHint: account,
      provider: "slack",
      persisted: true,
      health,
    });
    h.credentials[T_FLAKY] = async () => {
      throw new Error("the vault did not answer");
    };
    h.credentials[T_SLACKISH] = async () => [
      cred("cred-ok", "team@acme.test", "connected"),
      cred("cred-old", "old@acme.test", "needs_reauth"),
    ];
  }, 120_000);

  it("a tool that is turned off: not_enabled, with the enable door, said once", async () => {
    const entries = await entriesOf("Drafty");
    expect(entries).toEqual([
      {
        why: "not_enabled",
        label: "Drafty is installed, but this action of it is turned off.",
        tool: "Drafty",
        connection: null,
        retryable: false,
        fix: expect.objectContaining({
          kind: "enable",
          url: expect.stringContaining(`/open/capability/${C_DRAFT}`),
        }),
      },
    ]);
  });

  it("a tool with no connection: not_connected, with the connect door", async () => {
    expect(await entriesOf("Offline")).toEqual([
      expect.objectContaining({
        why: "not_connected",
        connection: { provider: "slack", account: null },
        retryable: false,
        fix: expect.objectContaining({ kind: "connect" }),
      }),
    ]);
  });

  it("every reason, not the first one (D5)", async () => {
    expect((await entriesOf("Twice")).map((u) => [u.why, u.fix?.kind])).toEqual(
      [
        ["not_enabled", "enable"],
        ["not_connected", "connect"],
      ]
    );
  });

  it("an inactive tool: not_launchable, nothing in the pod fixes it", async () => {
    expect(await entriesOf("Retired")).toEqual([
      expect.objectContaining({ why: "not_launchable", fix: null }),
    ]);
  });

  it("an action whose skill is installed but off carries the registry's own enable door", async () => {
    expect(await entriesOf("Locked")).toEqual([
      expect.objectContaining({ why: "not_enabled", fix: ENABLE }),
    ]);
  });

  it("an installed version that lacks the intent, with its update held: update_waiting (D-C)", async () => {
    expect(await entriesOf("Oldpack")).toEqual([
      {
        why: "update_waiting",
        label: "Oldpack has an update waiting for you that adds this.",
        tool: "Oldpack",
        connection: null,
        retryable: false,
        fix: {
          kind: "update",
          hint: "An update is waiting for you. Apply it to use this.",
          url: expect.stringContaining(`/open/capability/${C_OLD}`),
          opensIn: "web",
        },
      },
    ]);
  });

  it("an installed version that lacks the intent, no update known: intent_not_declared", async () => {
    expect(await entriesOf("Mismatch")).toEqual([
      expect.objectContaining({
        why: "intent_not_declared",
        retryable: false,
        fix: null,
      }),
    ]);
  });

  it("a verb with no input map: no_input_map", async () => {
    expect(await entriesOf("Nomap")).toEqual([
      expect.objectContaining({ why: "no_input_map", fix: null }),
    ]);
  });

  it("an account source that fails: accounts_unreadable, retryable, never an empty list", async () => {
    expect(await entriesOf("Nosource")).toEqual([
      expect.objectContaining({ why: "accounts_unreadable", retryable: true }),
    ]);
  });

  it("an account source that lists none: no_account", async () => {
    expect(await entriesOf("Emptytool")).toEqual([
      expect.objectContaining({ why: "no_account", retryable: false }),
    ]);
  });

  it("connections that cannot be read: accounts_unreadable, and no action offered on a guess", async () => {
    const { actions, unavailable } = await listing();
    expect(actions.filter((a) => a.tool === "Flaky")).toEqual([]);
    expect(unavailable.filter((u) => u.tool === "Flaky")).toEqual([
      expect.objectContaining({
        why: "accounts_unreadable",
        connection: { provider: "slack", account: null },
        retryable: true,
        fix: null,
      }),
    ]);
  });

  it("an account to reconnect is its own entry; the live one stays an action (D-D)", async () => {
    const { actions, unavailable } = await listing();
    expect(actions.filter((a) => a.tool === "Slackish")).toHaveLength(1);
    expect(unavailable.filter((u) => u.tool === "Slackish")).toEqual([
      expect.objectContaining({
        why: "connection_expired",
        label: "The account old@acme.test in Slackish must be reconnected.",
        connection: { provider: "slack", account: "old@acme.test" },
        fix: expect.objectContaining({ kind: "connect" }),
      }),
    ]);
  });

  it("an offered verb is never also listed as unavailable, and actions keep their shape", async () => {
    const { actions, unavailable } = await listing();
    const offered = new Set(actions.map((a) => a.tool));
    for (const u of unavailable)
      if (u.why !== "connection_expired")
        expect(offered.has(u.tool!)).toBe(false);
    for (const a of actions)
      expect(Object.keys(a).sort()).toEqual([
        "connection",
        "governance",
        "id",
        "input",
        "intent",
        "label",
        "tool",
      ]);
    expect(JSON.stringify(unavailable)).not.toContain("_share");
  });

  it("an intent this pod has no input shape for: no_input_schema", async () => {
    const { actions, unavailable } = await listing("lister", "list_records");
    expect(actions).toEqual([]);
    expect(unavailable).toEqual([
      {
        why: "no_input_schema",
        label: 'Apps cannot ask for "List records" on this pod yet.',
        tool: null,
        connection: null,
        retryable: false,
        fix: null,
      },
    ]);
  });

  it("an app without the intent's permission is told which permission (D-E)", async () => {
    const res = await list(
      "messenger",
      `workspaceId=${CRM}&intent=publish_post`
    );
    const body = await json(res);
    expect(res.status).toBe(403);
    expect(body).toMatchObject({
      code: "GRANT_DENIED",
      why: "permission_missing",
      permission: "capability.publish_post.run",
    });
    expect(body.label).toContain("capability.publish_post.run");
  });
});
