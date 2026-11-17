/**
 * `inbound_source.connect` end to end on PGlite (decision abaaa696, design
 * bb2937b6 §3): the verb files a card and nothing else; the person's console
 * approval (the REAL approve door, `applyProposalApproval` → the
 * `webhook/inbound_source.connect` executor) mints the source and hands its
 * secret to Vercel through the installed verbs, and the secret is then found
 * NOWHERE but in the source row itself and in the body Vercel received.
 *
 * Vercel is the injected dispatch (`triggerProviderAction`): it answers the
 * way the API documents, including echoing the `value` it was sent in
 * `created` and in `failed[].error` (what makes the scrub necessary).
 *
 *   1. Filing: a pending card, a preview, no source, no write to Vercel.
 *   2. Approval: both variables set (URL as Config, secret as Secret), a
 *      redeploy of the latest ready production deployment, a receipt; then
 *      EVERY row of every table but `webhook_subscriptions`, every event
 *      appended, every audit call and every log line is searched for the
 *      secret: zero hits. The source verifies an HMAC made with the secret
 *      Vercel received (the real inbound route answers a signed ping).
 *   3. A 201 whose `failed[]` reports the secret variable: the approval fails,
 *      scrubbed; the retry rotates the source this card created, sets both
 *      variables again, and the first secret stops verifying.
 *   4. A source of that name the card did not make: refused before anything
 *      (no proposal, no Vercel call), at filing and at approval.
 *   5. A member who is not a pod admin, or a stale device session: FORBIDDEN
 *      before anything is minted or sent.
 *   6. The verb's handler under a `run` verdict (called directly) files the
 *      card and acts on nothing; an automation step is refused.
 *   7. Only an enabled pod-wide host verb carries the secret: a draft, or a
 *      newer copy made for one space, is never used (review of #1114).
 *   8. The card cannot be revised under the person, and an approval whose
 *      project resolves elsewhere than the card showed acts on nothing.
 *   9. The filing reads Vercel only under the caller's own gate on the read
 *      verbs; the approval does not consult it.
 *  10. A second approval while one runs mints nothing and sends nothing.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { createHmac, randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

type Call = {
  method: string;
  path: string;
  body: unknown;
  alreadyApproved?: boolean;
  sourceProposalId?: string;
};

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  events: [] as unknown[],
  audit: [] as unknown[],
  logs: [] as string[],
  admins: new Set<string>(),
  calls: [] as Call[],
  /** env key → the value Vercel last received for it. */
  received: {} as Record<string, string>,
  /** How many upserts of a `sensitive` variable to fail (201 + failed[]). */
  failSecret: 0,
  hasReadyDeployment: true,
  /** Holds the next env upsert until released (two approvals at once). */
  hold: null as null | { reached: () => void; release: Promise<void> },
  /** The caller's gate on the filing's read verbs, and who asked it. */
  readVerdict: { decision: "run" } as { decision: string; reason?: string },
  gateCalls: [] as Array<Record<string, any>>,
  /** Serialize anything a leak could hide in (an Error's message and cause too). */
  stringify: (v: unknown) =>
    JSON.stringify(v, (_k, x) =>
      x instanceof Error
        ? { message: x.message, stack: x.stack, cause: x.cause }
        : typeof x === "bigint"
          ? String(x)
          : x
    ),
}));
const stringify = h.stringify;

vi.mock("@synap-core/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const rec: Record<string, unknown> = {};
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
    rec[level] = (...args: unknown[]) => {
      h.logs.push(h.stringify(args));
    };
  }
  rec.child = () => rec;
  return {
    ...actual,
    logger: rec,
    createLogger: () => rec,
    createLoggerWithCorrelation: () => rec,
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  class RecordingEventRepository {
    constructor(_sql?: unknown) {}
    async append(event: unknown) {
      h.events.push(event);
      return event;
    }
  }
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    EventRepository: RecordingEventRepository,
  };
});

vi.mock(
  "../capabilities/gate-capability-execution.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    gateCapabilityExecution: async (input: Record<string, any>) => {
      h.gateCalls.push(input);
      return h.readVerdict;
    },
  })
);

vi.mock("../../utils/audit-log.js", () => ({
  auditLog: async (...args: unknown[]) => {
    h.audit.push(args);
    return null;
  },
}));
vi.mock("../../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => h.admins.has(userId),
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  return {
    ...actual,
    createPendingProposal: async (
      input: Record<string, unknown>,
      tx?: unknown
    ) => {
      const [row] = await ((tx ?? h.db) as any)
        .insert(schema.proposals)
        .values({
          targetType: input.targetType,
          targetId: input.targetId,
          proposalType: input.proposalType,
          workspaceId: input.workspaceId ?? null,
          status: "pending",
          data: input.data,
          agentUserId: input.agentUserId ?? null,
          createdBy: input.createdBy,
          expiresAt: input.expiresAt ?? null,
          revisionHistory: [],
          comments: [],
        })
        .returning();
      return row;
    },
  };
});

/** Vercel, as its REST API answers (projects, env, deployments). */
vi.mock("../../connectors/external-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  triggerProviderAction: async (input: Record<string, unknown>) => {
    const method = String(input.method);
    const path = String(input.path).split("?")[0]!;
    h.calls.push({
      method,
      path: String(input.path),
      body: input.body,
      alreadyApproved: input.alreadyApproved as boolean | undefined,
      sourceProposalId: input.sourceProposalId as string | undefined,
    });
    if (method === "GET" && path === "/v9/projects/thearchitech") {
      return {
        success: true,
        status: 200,
        body: { id: "prj_arch", name: "thearchitech", framework: "nextjs" },
      };
    }
    if (method === "GET" && path.startsWith("/v9/projects/")) {
      return { success: false, status: 404, error: "Project not found" };
    }
    if (method === "GET" && path === "/v10/projects/prj_arch/env") {
      return {
        success: true,
        status: 200,
        body: {
          envs: [
            {
              id: "env_old",
              key: "CONTACT_WEBHOOK_URL",
              type: "encrypted",
              target: ["production"],
            },
          ],
        },
      };
    }
    if (method === "POST" && path === "/v10/projects/prj_arch/env") {
      if (h.hold) {
        const hold = h.hold;
        h.hold = null;
        hold.reached();
        await hold.release;
      }
      const b = input.body as Record<string, unknown>;
      const key = String(b.key);
      const value = String(b.value);
      if (b.type === "sensitive" && h.failSecret > 0) {
        h.failSecret -= 1;
        // A 201 that reports the variable as failed, echoing the value.
        return {
          success: true,
          status: 201,
          body: {
            created: [],
            failed: [
              {
                error: {
                  code: "ENV_CONFLICT",
                  message: `The variable ${key} with value ${value} could not be saved`,
                  key,
                  value,
                },
              },
            ],
          },
        };
      }
      h.received[key] = value;
      return {
        success: true,
        status: 201,
        body: {
          created: {
            id: `env_${key.toLowerCase()}`,
            key,
            value,
            type: b.type,
            target: b.target,
          },
          failed: [],
        },
      };
    }
    if (method === "GET" && path === "/v7/deployments") {
      return {
        success: true,
        status: 200,
        body: {
          deployments: h.hasReadyDeployment
            ? [{ uid: "dpl_ready", state: "READY", target: "production" }]
            : [],
        },
      };
    }
    if (method === "POST" && path === "/v13/deployments") {
      return {
        success: true,
        status: 200,
        body: {
          id: "dpl_new",
          inspectorUrl: "https://vercel.com/arch/thearchitech/dpl_new",
        },
      };
    }
    return { success: false, status: 500, error: `unmocked ${method} ${path}` };
  },
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import * as schema from "@synap/database/schema";
import { applyProposalApproval } from "../../routers/proposals/apply-approval.js";
import { webhooksInboundRouter } from "../../routers/webhooks-inbound.js";
import { BUILTIN_VERBS } from "../capabilities/builtin-verbs.js";
import { createInboundWebhookSource } from "./inbound-source.js";
import {
  proposeInboundSourceConnect,
  type InboundSourceConnectRequest,
} from "./connect-inbound-source.js";

const ADMIN = "human-admin";
const MEMBER = "human-member";
const AGENT = "agent-builder";
const CRM = randomUUID();
const SOURCE_NAME = "Architech contact form";

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
const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => is(v, PgTable))
  .map((t) => getTableConfig(t).name);
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params).then((r) => r.rows);

/** The installed Vercel verbs, as the catalog declares them (app-bases). */
const team = { teamId: "{{teamId}}", slug: "{{teamSlug}}" };
const VERBS: Record<string, Record<string, unknown>> = {
  vercel_get_project: {
    tool: "vercel",
    method: "GET",
    pathTemplate: "/v9/projects/{{projectIdOrName}}",
    query: team,
    paramMapping: { projectIdOrName: { required: true, encode: "uri" } },
  },
  vercel_list_env_vars: {
    tool: "vercel",
    method: "GET",
    pathTemplate: "/v10/projects/{{projectIdOrName}}/env",
    query: team,
    paramMapping: { projectIdOrName: { required: true, encode: "uri" } },
  },
  vercel_upsert_env: {
    tool: "vercel",
    method: "POST",
    pathTemplate: "/v10/projects/{{projectIdOrName}}/env",
    query: { upsert: "true", ...team },
    body: {
      key: "{{key}}",
      value: "{{value}}",
      type: "{{type}}",
      target: ["{{target}}"],
      comment: "{{comment}}",
    },
    paramMapping: {
      projectIdOrName: { required: true, encode: "uri" },
      key: { required: true },
      value: { required: true },
      type: { default: "encrypted" },
      target: { default: "production" },
    },
  },
  vercel_list_deployments: {
    tool: "vercel",
    method: "GET",
    pathTemplate: "/v7/deployments",
    query: {
      limit: "{{limit}}",
      projectId: "{{projectId}}",
      target: "{{target}}",
      state: "{{state}}",
      ...team,
    },
    paramMapping: { limit: { default: 20, clampMin: 1, clampMax: 100 } },
  },
  vercel_redeploy: {
    tool: "vercel",
    method: "POST",
    pathTemplate: "/v13/deployments",
    query: team,
    body: {
      name: "{{projectName}}",
      deploymentId: "{{deploymentId}}",
      target: "{{target}}",
    },
    paramMapping: {
      deploymentId: { required: true },
      projectName: { required: true },
      target: { default: "production" },
    },
  },
};

const REQUEST: InboundSourceConnectRequest = {
  workspaceId: CRM,
  name: SOURCE_NAME,
  host: "vercel",
  project: "thearchitech",
  urlEnvKey: "CONTACT_WEBHOOK_URL",
  secretEnvKey: "CONTACT_WEBHOOK_SECRET",
  target: "production",
  redeploy: true,
  replaceExistingSecret: false,
};

beforeAll(async () => {
  process.env.PUBLIC_URL = "https://pod.test.synap.live";
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const [id, email, type] of [
    [ADMIN, "admin@x", "human"],
    [MEMBER, "member@x", "human"],
    [AGENT, "agent@x", "agent"],
  ]) {
    await q(
      `insert into users (id, email, name, user_type) values ($1, $2, $1, $3)`,
      [id, email, type]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'CRM', $2)`,
    [CRM, ADMIN]
  );
  for (const [user, role] of [
    [ADMIN, "owner"],
    [MEMBER, "editor"],
  ]) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
      [randomUUID(), CRM, user, role]
    );
  }
  await q(
    `insert into tools (id, name, approved, created_by) values ($1, 'vercel', true, $2)`,
    [randomUUID(), ADMIN]
  );
  for (const [name, spec] of Object.entries(VERBS)) {
    await q(
      `insert into skills (id, name, kind, scope, status, approved, provider_spec, user_id)
       values ($1, $2, 'declarative', 'pod', 'active', true, $3::jsonb, $4)`,
      [randomUUID(), name, JSON.stringify(spec), ADMIN]
    );
  }
  await q(
    `insert into automations (id, workspace_id, name, trigger_type, trigger_config, created_by, status)
     values ($1, $2, 'Contact form to lead', 'webhook', $3::jsonb, $4, 'active')`,
    [
      randomUUID(),
      CRM,
      JSON.stringify({ webhookSource: { name: SOURCE_NAME } }),
      ADMIN,
    ]
  );
}, 120_000);

beforeEach(async () => {
  await q(`delete from pod_settings`);
  await h.client!.exec(
    `insert into pod_settings (settings) values ('{"presence":{"mode":"report","changedBy":"test","changedAt":"2026-11-05T00:00:00.000Z"}}'::jsonb)`
  );
  await q(`delete from proposals`);
  await q(`delete from webhook_subscriptions`);
  h.admins = new Set([ADMIN]);
  h.calls.length = 0;
  h.events.length = 0;
  h.audit.length = 0;
  h.logs.length = 0;
  h.received = {};
  h.failSecret = 0;
  h.hasReadyDeployment = true;
  h.hold = null;
  h.readVerdict = { decision: "run" };
  h.gateCalls = [];
});

const ctxOf = (userId: string, extra: Record<string, unknown> = {}) =>
  ({ authenticated: true, userId, session: { id: "s" }, ...extra }) as never;

async function file(request: Partial<InboundSourceConnectRequest> = {}) {
  return proposeInboundSourceConnect({
    request: { ...REQUEST, ...request },
    userId: ADMIN,
    agentUserId: AGENT,
    sessionId: null,
  });
}

async function approve(
  proposalId: string,
  userId = ADMIN,
  ctx = ctxOf(userId)
) {
  const row = await (h.db as any).query.proposals.findFirst({
    where: (p: any, { eq }: any) => eq(p.id, proposalId),
  });
  return applyProposalApproval({
    proposal: row,
    userId,
    input: { proposalId },
    ctx,
  });
}

const proposalRow = async (id: string) =>
  (
    await q<{ status: string; data: any; rejection_reason: string | null }>(
      `select status, data, rejection_reason from proposals where id = $1`,
      [id]
    )
  )[0]!;
const sources = () =>
  q<{ id: string; name: string; secret: string }>(
    `select id, name, secret from webhook_subscriptions where direction = 'inbound'`
  );
const writes = () => h.calls.filter((c) => c.method === "POST");
/** The status moves of one proposal (a table the leak scan reads). */
const outboxOf = (proposalId: string) =>
  q<{ transition_id: string }>(
    `select transition_id from lifecycle_transition_outbox where transition->>'proposalId' = $1`,
    [proposalId]
  );

const inboundApp = new Hono().route("/api/webhooks", webhooksInboundRouter);
/** A signed ping to the real inbound route: 200 when the secret verifies. */
async function ping(sourceId: string, secret: string): Promise<number> {
  const body = JSON.stringify({ zen: "connected" });
  const res = await inboundApp.request(`/api/webhooks/inbound/${sourceId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-synap-event": "ping",
      "x-synap-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
  return res.status;
}

/**
 * Every place the secret must NOT be: every row of every table except the
 * source row's own table, every event appended, every audit call, every log
 * line, and whatever the approval returned or threw.
 */
async function leaks(secret: string, extra: unknown[] = []): Promise<string[]> {
  const hits: string[] = [];
  for (const table of TABLES) {
    if (table === "webhook_subscriptions") continue;
    const rows = await q<unknown>(`select * from "${table}"`);
    if (stringify(rows).includes(secret)) hits.push(`table ${table}`);
  }
  if (stringify(h.events).includes(secret)) hits.push("events");
  if (stringify(h.audit).includes(secret)) hits.push("audit");
  h.logs.forEach((l, i) => {
    if (l.includes(secret)) hits.push(`log ${i}`);
  });
  extra.forEach((x, i) => {
    if (stringify(x).includes(secret)) hits.push(`returned ${i}`);
  });
  return hits;
}

describe("filing: the verb files a card and acts on nothing", () => {
  it("a pending webhook/inbound_source.connect with a preview; no source, no write to Vercel", async () => {
    const filed = await file();
    expect(filed).toEqual({
      status: "proposed",
      proposalId: expect.any(String),
    });
    const { proposalId } = filed as { proposalId: string };
    const row = await proposalRow(proposalId);
    expect(row.status).toBe("pending");
    expect(row.data.preview).toMatchObject({
      workspace: { id: CRM, name: "CRM" },
      source: { name: SOURCE_NAME, existingId: null },
      host: {
        projectId: "prj_arch",
        projectName: "thearchitech",
        target: "production",
      },
      env: [
        { key: "CONTACT_WEBHOOK_URL", type: "encrypted", exists: true },
        { key: "CONTACT_WEBHOOK_SECRET", type: "sensitive", exists: false },
      ],
      redeploy: true,
      automations: [{ name: "Contact form to lead" }],
    });
    expect(await sources()).toEqual([]);
    expect(writes()).toEqual([]);
    expect(h.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
});

describe("approval: mint, hand the secret to Vercel, redeploy — and the secret is nowhere else", () => {
  it("sets both variables, redeploys, writes a receipt; zero hits for the secret; the source verifies it", async () => {
    const { proposalId } = (await file()) as { proposalId: string };
    const result = await approve(proposalId);

    const [source] = await sources();
    expect(source).toBeDefined();
    const secret = h.received.CONTACT_WEBHOOK_SECRET!;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(h.received.CONTACT_WEBHOOK_URL).toBe(
      `https://pod.test.synap.live/api/webhooks/inbound/${source!.id}`
    );

    // Each write is the person's approval of THIS card, never a second proposal.
    const posts = writes();
    expect(posts.map((c) => c.path.split("?")[0])).toEqual([
      "/v10/projects/prj_arch/env",
      "/v10/projects/prj_arch/env",
      "/v13/deployments",
    ]);
    for (const c of posts) {
      expect(c).toMatchObject({
        alreadyApproved: true,
        sourceProposalId: proposalId,
      });
    }
    expect(posts.map((c) => (c.body as any).type).slice(0, 2)).toEqual([
      "encrypted",
      "sensitive",
    ]);
    expect(posts[2]!.body).toMatchObject({
      deploymentId: "dpl_ready",
      name: "thearchitech",
    });

    const row = await proposalRow(proposalId);
    expect(row.status).toBe("approved");
    expect(row.data.receipt).toMatchObject({
      source: { id: source!.id, minted: "created", boundAutomations: 1 },
      env: [
        { key: "CONTACT_WEBHOOK_URL", id: "env_contact_webhook_url" },
        { key: "CONTACT_WEBHOOK_SECRET", id: "env_contact_webhook_secret" },
      ],
      redeploy: { status: "started", deploymentId: "dpl_new" },
    });

    expect(await leaks(secret, [result])).toEqual([]);
    // The scan read something: the approval's transition is in a table.
    expect(await outboxOf(proposalId)).not.toEqual([]);
    expect(await ping(source!.id, secret)).toBe(200);
    expect(await ping(source!.id, "0".repeat(64))).toBe(401);
  });

  it("no ready production deployment: the variables are set and the receipt says the next deploy picks them up", async () => {
    h.hasReadyDeployment = false;
    const { proposalId } = (await file()) as { proposalId: string };
    await approve(proposalId);
    const row = await proposalRow(proposalId);
    expect(row.status).toBe("approved");
    expect(row.data.receipt.redeploy).toMatchObject({ status: "skipped" });
    expect(writes().map((c) => c.path.split("?")[0])).not.toContain(
      "/v13/deployments"
    );
  });
});

describe("a 201 with failed[]: a failure, scrubbed; the retry rotates and sets both again", () => {
  it("fails without the secret anywhere, then the retry replaces it and the first one stops", async () => {
    h.failSecret = 1;
    const { proposalId } = (await file()) as { proposalId: string };
    let thrown: unknown;
    await approve(proposalId).catch((e) => {
      thrown = e;
    });
    expect(thrown).toBeInstanceOf(Error);

    const [first] = await sources();
    const firstSecret = first!.secret;
    // The secret Vercel refused is the source's: it was sent once, echoed back.
    const refused = h.calls.find(
      (c) => c.method === "POST" && (c.body as any).type === "sensitive"
    );
    expect((refused!.body as any).value).toBe(firstSecret);
    expect(h.received.CONTACT_WEBHOOK_SECRET).toBeUndefined();

    const failed = await proposalRow(proposalId);
    expect(failed.status).toBe("approval_failed");
    expect(failed.data.progress).toMatchObject({
      sourceId: first!.id,
      minted: "created",
      envSet: ["CONTACT_WEBHOOK_URL"],
    });
    expect(await leaks(firstSecret, [thrown])).toEqual([]);
    // Not vacuous: the approval's failure was logged (with its redacted
    // detail) and its transition written, and the scan read both.
    expect(
      h.logs.some((l) => l.includes("proposal approval failed"))
    ).toBe(true);
    expect(await outboxOf(proposalId)).not.toEqual([]);

    await approve(proposalId);
    const after = await sources();
    expect(after.map((s) => s.id)).toEqual([first!.id]);
    const secondSecret = h.received.CONTACT_WEBHOOK_SECRET!;
    expect(secondSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(secondSecret).not.toBe(firstSecret);
    const done = await proposalRow(proposalId);
    expect(done.status).toBe("approved");
    expect(done.data.failure).toBeUndefined();
    expect(done.data.receipt.source).toMatchObject({
      id: first!.id,
      minted: "created",
    });

    expect(await ping(first!.id, secondSecret)).toBe(200);
    expect(await ping(first!.id, firstSecret)).toBe(401);
    expect(await leaks(secondSecret)).toEqual([]);
    expect(await leaks(firstSecret)).toEqual([]);
  });
});

describe("a source of that name the card did not make: refused before anything", () => {
  it("at filing: no proposal, no Vercel call", async () => {
    await createInboundWebhookSource({
      userId: ADMIN,
      workspaceId: CRM,
      name: SOURCE_NAME,
    });
    const filed = await file();
    expect(filed).toMatchObject({ success: false });
    expect((filed as { error: string }).error).toContain(
      "replaceExistingSecret"
    );
    expect(await q(`select id from proposals`)).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("at approval: nothing minted, nothing sent, the person's source keeps its secret", async () => {
    const { proposalId } = (await file()) as { proposalId: string };
    const { secret } = await createInboundWebhookSource({
      userId: ADMIN,
      workspaceId: CRM,
      name: SOURCE_NAME,
    });
    h.calls.length = 0;
    await expect(approve(proposalId)).rejects.toThrow();
    const all = await sources();
    expect(all).toHaveLength(1);
    expect(all[0]!.secret).toBe(secret);
    expect(h.calls).toEqual([]);
  });
});

describe("only a pod admin, on the console, approves", () => {
  it("a member who is not a pod admin: FORBIDDEN, nothing minted or sent", async () => {
    const { proposalId } = (await file()) as { proposalId: string };
    h.calls.length = 0;
    await expect(approve(proposalId, MEMBER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await sources()).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("a stale device session of the admin: FORBIDDEN, nothing minted or sent", async () => {
    const { proposalId } = (await file()) as { proposalId: string };
    h.calls.length = 0;
    const device = ctxOf(ADMIN, {
      sessionKind: "person_device",
      session: {
        id: "s",
        device: {
          id: "dev-1",
          authTime: new Date(Date.now() - 60 * 60 * 1000),
        },
      },
    });
    await expect(approve(proposalId, ADMIN, device)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await sources()).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});

describe("the verb's handler, whatever the verdict", () => {
  const handler = BUILTIN_VERBS["inbound_source.connect"]!;
  const params = {
    name: SOURCE_NAME,
    project: "thearchitech",
    urlEnvKey: "CONTACT_WEBHOOK_URL",
    secretEnvKey: "CONTACT_WEBHOOK_SECRET",
  };

  it("called directly (a run verdict) it files the card and creates nothing", async () => {
    const out = await handler(params, {
      userId: ADMIN,
      workspaceId: CRM,
      agentUserId: AGENT,
    } as never);
    expect(out).toEqual({ status: "proposed", proposalId: expect.any(String) });
    expect(await sources()).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("an automation step is refused and files nothing", async () => {
    const out = await handler(params, {
      userId: ADMIN,
      workspaceId: CRM,
      automationRun: { sessionId: "run-session", agentUserId: AGENT },
    } as never);
    expect(out).toMatchObject({ success: false });
    expect(await q(`select id from proposals`)).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});

describe("only an enabled pod-wide host verb carries the secret", () => {
  /** A copy of the upsert verb that would save the secret as readable text. */
  const plainUpsert = {
    ...VERBS.vercel_upsert_env,
    body: {
      ...(VERBS.vercel_upsert_env!.body as Record<string, unknown>),
      type: "plain",
    },
  };
  async function plantUpsertCopy(opts: {
    approved: boolean;
    scope: "pod" | "workspace";
  }) {
    await q(
      `insert into skills (id, name, kind, scope, status, approved, provider_spec, user_id, workspace_id, updated_at)
       values ($1, 'vercel_upsert_env', 'declarative', $2, 'active', $3, $4::jsonb, $5, $6, now() + interval '1 hour')`,
      [
        randomUUID(),
        opts.scope,
        opts.approved,
        JSON.stringify(plainUpsert),
        MEMBER,
        opts.scope === "workspace" ? CRM : null,
      ]
    );
  }
  const setOfficialUpsert = (approved: boolean) =>
    q(
      `update skills set approved = $1 where name = 'vercel_upsert_env' and user_id = $2`,
      [approved, ADMIN]
    );
  afterEach(async () => {
    await q(`delete from skills where user_id = $1`, [MEMBER]);
    await setOfficialUpsert(true);
  });

  it("a draft upsert verb and no enabled one: refused at filing, nothing filed or read", async () => {
    await setOfficialUpsert(false);
    await plantUpsertCopy({ approved: false, scope: "pod" });
    const filed = await file();
    expect(filed).toMatchObject({ success: false });
    expect((filed as { error: string }).error).toContain("vercel_upsert_env");
    expect(await q(`select id from proposals`)).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("the verb loses its enable after filing, a draft is there: refused at approval, nothing minted or sent", async () => {
    const { proposalId } = (await file()) as { proposalId: string };
    await setOfficialUpsert(false);
    await plantUpsertCopy({ approved: false, scope: "pod" });
    h.calls.length = 0;
    await expect(approve(proposalId)).rejects.toThrow();
    expect(await sources()).toEqual([]);
    expect(h.calls).toEqual([]);
    expect((await proposalRow(proposalId)).status).toBe("approval_failed");
  });

  it("a newer enabled copy made for the space is never used: the secret goes through the pod-wide verb", async () => {
    await plantUpsertCopy({ approved: true, scope: "workspace" });
    const { proposalId } = (await file()) as { proposalId: string };
    await approve(proposalId);
    const secretPost = writes().find(
      (c) => (c.body as any).key === "CONTACT_WEBHOOK_SECRET"
    );
    expect((secretPost!.body as any).type).toBe("sensitive");
    expect((await proposalRow(proposalId)).status).toBe("approved");
  });
});

describe("the card cannot change under the person", () => {
  it("a revise of the request, the preview, the summary or the progress is refused; the reasoning is not", async () => {
    const { computeRevisedEnvelope } =
      await import("../proposals/proposals-service.js");
    const { proposalId } = (await file()) as { proposalId: string };
    const { data } = await proposalRow(proposalId);
    const revise = (args: Record<string, unknown>) => () =>
      computeRevisedEnvelope({
        proposalType: "inbound_source.connect",
        envelope: data,
        ...args,
      });
    for (const fields of [
      { request: { ...data.request, project: "someone-elses-site" } },
      {
        preview: {
          ...data.preview,
          host: { ...data.preview.host, projectId: "prj_other" },
        },
      },
      { summary: "Sets one harmless variable." },
      { progress: { sourceId: randomUUID(), minted: "created" } },
      { data: { preview: { notes: ["nothing to see"] } } },
    ]) {
      expect(revise({ patch: { kind: "envelope", fields } })).toThrow(
        /cannot change `/
      );
    }
    expect(revise({ summary: "Sets one harmless variable." })).toThrow(
      /cannot change `_summary`/
    );
    expect(revise({ reasoning: "The site's form needs it." })).not.toThrow();
  });

  it("an approval whose project resolves elsewhere than the card showed: nothing minted, nothing sent", async () => {
    const { proposalId } = (await file()) as { proposalId: string };
    await q(
      `update proposals set data = jsonb_set(data, '{preview,host,projectId}', '"prj_other"') where id = $1`,
      [proposalId]
    );
    h.calls.length = 0;
    await expect(approve(proposalId)).rejects.toThrow();
    expect(await sources()).toEqual([]);
    expect(writes()).toEqual([]);
    expect((await proposalRow(proposalId)).status).toBe("approval_failed");
  });
});

describe("the filing reads Vercel only under the caller's own gate", () => {
  it("an agent the gate does not let read Vercel: nothing filed, nothing read", async () => {
    h.readVerdict = { decision: "propose" };
    const filed = await file();
    expect(filed).toMatchObject({ success: false });
    expect((filed as { error: string }).error).toContain("vercel_get_project");
    expect(await q(`select id from proposals`)).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.gateCalls[0]).toMatchObject({
      capabilityKind: "skill",
      actorUserId: ADMIN,
      agentUserId: AGENT,
      workspaceId: CRM,
      skill: { name: "vercel_get_project" },
    });
  });

  it("a filing consults it for both read verbs; the approval does not", async () => {
    const { proposalId } = (await file()) as { proposalId: string };
    expect(h.gateCalls.map((c) => c.skill.name)).toEqual([
      "vercel_get_project",
      "vercel_list_env_vars",
    ]);
    h.gateCalls.length = 0;
    await approve(proposalId);
    expect(h.gateCalls).toEqual([]);
    expect((await proposalRow(proposalId)).status).toBe("approved");
  });
});

describe("two approvals at once: one runs, the other does nothing", () => {
  it("a second approval while the first sets the variables mints nothing and sends nothing", async () => {
    const { proposalId } = (await file()) as { proposalId: string };
    let reached!: () => void;
    let release!: () => void;
    const atVercel = new Promise<void>((r) => (reached = r));
    h.hold = { reached, release: new Promise<void>((r) => (release = r)) };

    const first = approve(proposalId);
    await atVercel;
    const [minted] = await sources();
    expect(minted).toBeDefined();
    const callsBefore = h.calls.length;

    await expect(approve(proposalId)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(h.calls.length).toBe(callsBefore);
    expect(await sources()).toEqual([minted]);

    release();
    await first;
    const row = await proposalRow(proposalId);
    expect(row.status).toBe("approved");
    const envPosts = writes().filter((c) =>
      c.path.startsWith("/v10/projects/prj_arch/env")
    );
    expect(envPosts).toHaveLength(2);
    expect(h.received.CONTACT_WEBHOOK_SECRET).toBe(minted!.secret);
    expect((await sources())[0]!.secret).toBe(minted!.secret);
  });
});
