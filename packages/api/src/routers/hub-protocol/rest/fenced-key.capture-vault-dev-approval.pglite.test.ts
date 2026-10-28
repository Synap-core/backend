/**
 * Issue 314a6554, siblings (2026-10-28): three Hub REST doors file a proposal
 * from caller data that approval then runs AS the person, and none passed the
 * gate's grant rung. A pod app holds `hub-protocol.write` (its OAuth door
 * scopes), so a key granted ONE space could:
 *
 *  - `POST /capture/graph`: file records in a space it was never granted (or
 *    pod-wide), link the graph to a record outside its grant, bind channels,
 *    and propose skills/automations/rules as plan steps; its raw source was
 *    stored as a document wherever it named;
 *  - `POST /vault/request`: ask for any secret, and approval hands its agent
 *    redeem access without the key ever holding `vault.grant`;
 *  - `POST /proposals/dev-approval`: file a plan/deploy approval on a session
 *    in a space it was never granted, and approval stamps that session.
 *
 * Now a key limited to spaces (`isFencedGrant`) files only what its governed
 * doors would let it write, checked with the gate's rung 0 (`grantWriteDenial`)
 * where the write lands. Every other key is unchanged.
 *
 * Driven through the REAL hub auth door (W1 fence + `runWithGrant`), the real
 * routes and the real capture core, with each key's grant as a real `grants`
 * row, on PGlite. Mocked: the key lookup, the guest check, the sub-token
 * mapping, the audit log, the event log, the two proposal writers (observed),
 * the materializer (observed), the capture source staging (observed), the
 * notification, the agent-governance verdict (execute) and graph placement
 * (abstains). Cannot see: production Postgres, a real minted app token.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface Filed {
  terminal: "pending" | "auto";
  workspaceId: string | null;
  projectId: string | null;
  proposalType: string;
  data: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  getApiKeyStatus: vi.fn(),
  filed: [] as Array<{
    terminal: "pending" | "auto";
    workspaceId: string | null;
    projectId: string | null;
    proposalType: string;
    data: Record<string, unknown>;
  }>,
  materialized: [] as Array<Array<Record<string, unknown>>>,
  staged: [] as Array<{ workspaceId: string | null }>,
  /** A no-op event log (it appends over its own connection). Never thenable. */
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
    // Placement abstains: a graph with no space stays pod-wide.
    resolveGraphWorkspaceFromSlugs: vi.fn(async () => ({
      workspaceId: null,
      rung: 6,
      reason: "pod-wide",
      confidence: 1,
      candidates: [],
      ask: false,
    })),
  };
});
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: vi.fn(async () => ({ decision: "execute" })),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: globalThis.crypto.randomUUID() })),
}));
vi.mock(
  "../../../services/agent-identity-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getAgentFocusProjectId: vi.fn(async () => null),
  })
);
// The two terminals a door files through: observed, never written.
vi.mock("../../../utils/event-backed-proposal.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const record =
    (terminal: "pending" | "auto") =>
    async (input: {
      id?: string;
      workspaceId?: string | null;
      projectId?: string | null;
      proposalType: string;
      data?: Record<string, unknown>;
    }) => {
      const id = input.id ?? globalThis.crypto.randomUUID();
      h.filed.push({
        terminal,
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        proposalType: input.proposalType,
        data: input.data ?? {},
      });
      return {
        proposal: {
          id,
          status: terminal === "auto" ? "auto_approved" : "pending",
          data: input.data ?? {},
          workspaceId: input.workspaceId ?? null,
        },
        requestedEvent: null,
        completedEvent: null,
        correlationId: "c",
      };
    };
  return {
    ...actual,
    createEventBackedProposal: record("pending"),
    createAutoApprovedProposal: record("auto"),
  };
});
vi.mock("../../../utils/materialize-composite.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  materializeCompositeGraph: vi.fn(
    async (ops: Array<Record<string, unknown>>) => {
      h.materialized.push(ops);
      const made = ops.filter((o) => o.op === "create_entity");
      return {
        entities: made.map((o) => ({
          ref: o.ref,
          entityId: (o.existingEntityId as string) ?? randomUUID(),
          linked: Boolean(o.existingEntityId),
        })),
        relations: [],
        relationsFailed: [],
        created: made.filter((o) => !o.existingEntityId).length,
      };
    }
  ),
}));
vi.mock(
  "../../../services/intake/record-structure-intake.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    stageCaptureSources: vi.fn(
      async (input: { workspaceId: string | null }) => {
        h.staged.push({ workspaceId: input.workspaceId });
        return { sourceDocumentIds: [randomUUID()], errors: [] };
      }
    ),
  })
);
vi.mock("../../../utils/pending-capture-dedup.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findPriorCaptureGraphProposal: vi.fn(async () => null),
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { ProfileResolutionService } from "@synap/database";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { NotificationService } from "../../../notifications/NotificationService.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerCaptureRoutes } from "./capture.js";
import { registerVaultRoutes } from "./vault.js";
import { registerProposalsRoutes } from "./proposals.js";
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

const OWNER = randomUUID(); // the person who connected the app (pod owner)
const AGENT = randomUUID(); // the app's own agent
const CRM = randomUUID();
const BRAND = randomUUID(); // the owner's other space, never granted to the app
const PERSON_KIND = randomUUID();
const COMPANY_KIND = randomUUID();

const IN_CRM = randomUUID(); // a person in CRM
const IN_BRAND = randomUUID(); // a person in Brand, with a known email
const BRAND_EMAIL = "rhea@brand.test";

const SESSION_CRM = randomUUID();
const SESSION_BRAND = randomUUID();
const SECRET = randomUUID();

/** Everything an app filing records, links, sessions and secrets in CRM asks for. */
const CRM_APP = [
  "entity.*.read",
  "entity.*.create",
  "entity.*.update",
  "relation.create",
  "document.create",
  "session.update",
  "vault.grant",
];

interface Key {
  id: string;
  permissions: string[];
  workspaceIds: string[] | null;
}
const KEYS = {
  /** The CRM app's agent: records, links, sources, sessions, secrets — in CRM only. */
  crm: { id: randomUUID(), permissions: CRM_APP, workspaceIds: [CRM] },
  /** The CRM app, records only: no source documents, sessions or secrets. */
  crmRecords: {
    id: randomUUID(),
    permissions: ["entity.*.read", "entity.*.create"],
    workspaceIds: [CRM],
  },
  /** "Full access" ticked in CRM: a `*` pinned to one space is still fenced. */
  crmStar: { id: randomUUID(), permissions: ["*"], workspaceIds: [CRM] },
  /** The owner's agent, unbounded (`*`): not limited to spaces. */
  full: { id: randomUUID(), permissions: ["*"], workspaceIds: null },
} satisfies Record<string, Key>;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

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
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id) values
       ($1,'person','Person','kind','system','pod',true,'{}'::jsonb,null),
       ($2,'company','Company','kind','system','pod',true,'{}'::jsonb,null)`,
    [PERSON_KIND, COMPANY_KIND]
  );
  for (const [id, ws, title] of [
    [IN_CRM, CRM, "Mia CRM"],
    [IN_BRAND, BRAND, "Rhea Brand"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, created_at)
       values ($1,$2,$3,$4,'person',$5,'{}'::jsonb,'{}'::jsonb, now() - interval '1 day')`,
      [id, OWNER, ws, PERSON_KIND, title]
    );
  }
  await q(
    `insert into entity_identity_signals (id, entity_id, signal_type, signal_value, source)
     values (gen_random_uuid(),$1,'email',$2,'seed')`,
    [IN_BRAND, BRAND_EMAIL]
  );
  for (const [id, ws] of [
    [SESSION_CRM, CRM],
    [SESSION_BRAND, BRAND],
  ] as const) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, status) values ($1,$2,$3,'Ship it','active')`,
      [id, OWNER, ws]
    );
  }
  for (const k of Object.values(KEYS)) {
    // The act-as link a minted key carries: the app's agent acts for its person.
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,$3,true)`,
      [k.id, AGENT, OWNER]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        AGENT,
        OWNER,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
      ]
    );
  }
  // No kind overlay to validate against: the preflight stays advisory.
  vi.spyOn(
    ProfileResolutionService.prototype,
    "resolveProfile"
  ).mockResolvedValue(null as never);
  vi.spyOn(NotificationService, "create").mockResolvedValue(undefined as never);
}, 120_000);

beforeEach(() => {
  h.filed.length = 0;
  h.materialized.length = 0;
  h.staged.length = 0;
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const key: Key = KEYS[bearer.replace(/^synap_/, "") as KeyName];
    return {
      status: "valid",
      record: {
        id: key.id,
        userId: AGENT,
        linkedUserId: OWNER,
        parentKeyId: null,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        keyType: "hub_inbound",
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerCaptureRoutes(hub);
  registerVaultRoutes(hub);
  registerProposalsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const post = (key: KeyName, path: string, body: Record<string, unknown>) => {
  const json = JSON.stringify(body);
  return app().request(`/api/hub${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer synap_${key}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
    },
    body: json,
  });
};

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

type Op = Record<string, unknown> & { op: string };
const opsOf = (f: Filed | undefined): Op[] =>
  ((f?.data.operations as Op[] | undefined) ?? []).filter(Boolean);
const entityOps = (f: Filed | undefined) =>
  opsOf(f).filter((o) => o.op === "create_entity");

// ─── POST /capture/graph ────────────────────────────────────────────────────

const ada = { ref: "ada", profileSlug: "person", title: "Ada Lovelace" };
const acme = { ref: "acme", profileSlug: "company", title: "Acme" };

describe("POST /capture/graph — a key limited to CRM captures inside CRM only", () => {
  it("records in Brand: 403, nothing filed, nothing staged", async () => {
    for (const key of ["crm", "crmStar"] as const) {
      const res = await post(key, "/capture/graph", {
        workspaceId: BRAND,
        entities: [ada],
      });
      const body = await json(res);
      expect(res.status, `${key}: ${JSON.stringify(body)}`).toBe(403);
    }
    expect(h.filed).toEqual([]);
    expect(h.materialized).toEqual([]);
  });

  it("no space named and placement abstains (pod-wide): 403, nothing filed", async () => {
    const res = await post("crm", "/capture/graph", { entities: [ada] });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(String(body.error)).toContain("workspaceId");
    expect(h.filed).toEqual([]);
  });

  it("a plan step (a skill): 403, the skill is never proposed", async () => {
    const res = await post("crmStar", "/capture/graph", {
      workspaceId: CRM,
      entities: [ada],
      skills: [
        {
          ref: "s1",
          name: "Pricing rules",
          slug: "crm/pricing-rules",
          body: "When asked about pricing, answer from the price list.",
        },
      ],
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(String(body.error)).toContain("create_skill");
    expect(h.filed).toEqual([]);
  });

  it("a channel binding: 403, nothing filed", async () => {
    const res = await post("crm", "/capture/graph", {
      workspaceId: CRM,
      entities: [ada],
      bindings: [{ externalChannelId: "discord-123", entityRef: "ada" }],
    });
    expect(res.status).toBe(403);
    expect(h.filed).toEqual([]);
  });

  it("linking an existing record in Brand by id: 403, nothing filed", async () => {
    const res = await post("crm", "/capture/graph", {
      workspaceId: CRM,
      entities: [{ ...ada, existingEntityId: IN_BRAND }, acme],
      relations: [{ sourceRef: "ada", targetRef: "acme", type: "works_at" }],
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(h.filed).toEqual([]);
  });

  it("a key with no `entity.<kind>.create` for a kind: 403", async () => {
    const res = await post("crmRecords", "/capture/graph", {
      workspaceId: CRM,
      entities: [ada, acme],
      // crmRecords holds no `relation.create`.
      relations: [{ sourceRef: "ada", targetRef: "acme", type: "works_at" }],
    });
    expect(res.status).toBe(403);
    expect(h.filed).toEqual([]);
  });

  it("a raw source without `document.create` in CRM: 403, nothing staged or filed", async () => {
    const res = await post("crmRecords", "/capture/graph", {
      workspaceId: CRM,
      entities: [ada],
      rawSource: { rawText: "Met Ada at the fair." },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(h.staged).toEqual([]);
    expect(h.filed).toEqual([]);
  });

  it("CONTROL — records and a link in CRM: filed, each record pinned to CRM", async () => {
    const res = await post("crm", "/capture/graph", {
      workspaceId: CRM,
      entities: [ada, acme],
      relations: [{ sourceRef: "ada", targetRef: "acme", type: "works_at" }],
      rawSource: { rawText: "Ada works at Acme." },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(h.staged).toEqual([{ workspaceId: CRM }]);
    expect(h.filed).toHaveLength(1);
    expect(h.filed[0]!.workspaceId).toBe(CRM);
    const ops = entityOps(h.filed[0]);
    expect(ops).toHaveLength(2);
    // A pod-scope kind would otherwise land pod-wide, outside every space grant.
    for (const op of ops) expect(op.targetWorkspaceId).toBe(CRM);
  });

  it("a strong identity match in Brand is never linked: a new record in CRM", async () => {
    const res = await post("crm", "/capture/graph", {
      workspaceId: CRM,
      entities: [
        { ...ada, title: "R. Brand", properties: { email: BRAND_EMAIL } },
      ],
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    const [op] = entityOps(h.filed[0]);
    expect(op!.existingEntityId).toBeUndefined();
    expect(op!.targetWorkspaceId).toBe(CRM);
    expect(JSON.stringify(h.materialized)).not.toContain(IN_BRAND);
  });

  it("CONTROL — an unbounded key still links the strong match and files where it asks", async () => {
    const res = await post("full", "/capture/graph", {
      workspaceId: CRM,
      entities: [
        { ...ada, title: "R. Brand", properties: { email: BRAND_EMAIL } },
      ],
    });
    expect(res.status).toBe(200);
    const [op] = entityOps(h.filed[0]);
    expect(op!.existingEntityId).toBe(IN_BRAND);

    h.filed.length = 0;
    const brand = await post("full", "/capture/graph", {
      workspaceId: BRAND,
      entities: [ada],
    });
    expect(brand.status).toBe(200);
    expect(h.filed[0]!.workspaceId).toBe(BRAND);
    // Unchanged for an unbounded key: a pod-scope kind is not pinned.
    expect(entityOps(h.filed[0])[0]!.targetWorkspaceId).toBeUndefined();
  });
});

// ─── POST /vault/request ────────────────────────────────────────────────────

const askSecret = (workspaceId?: string, secretId?: string) => ({
  secretType: "api_key",
  service: "stripe",
  purpose: "Charge the invoice",
  ...(workspaceId ? { workspaceId } : {}),
  ...(secretId ? { secretId } : {}),
});

describe("POST /vault/request — a key limited to CRM asks only where it may grant", () => {
  it("in Brand, or with no space: 403, nothing filed", async () => {
    for (const key of ["crm", "crmStar"] as const) {
      for (const body of [
        askSecret(BRAND),
        askSecret(),
        askSecret(BRAND, SECRET),
      ]) {
        const res = await post(key, "/vault/request", body);
        expect(res.status, `${key} ${JSON.stringify(body)}`).toBe(403);
      }
    }
    expect(h.filed).toEqual([]);
  });

  it("in CRM without `vault.grant`: 403", async () => {
    const res = await post("crmRecords", "/vault/request", askSecret(CRM));
    expect(res.status).toBe(403);
    expect(h.filed).toEqual([]);
  });

  it("CONTROL — in CRM with `vault.grant`: filed in CRM", async () => {
    const res = await post("crm", "/vault/request", askSecret(CRM, SECRET));
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(h.filed).toHaveLength(1);
    expect(h.filed[0]).toMatchObject({
      proposalType: "vault.request",
      workspaceId: CRM,
    });
  });

  it("CONTROL — an unbounded key asks anywhere", async () => {
    const res = await post("full", "/vault/request", askSecret(BRAND));
    expect(res.status).toBe(200);
    expect(h.filed[0]!.workspaceId).toBe(BRAND);
  });
});

// ─── POST /proposals/dev-approval ───────────────────────────────────────────

const planApproval = (sessionId: string, workspaceId?: string) => ({
  type: "dev.plan_approval",
  ...(workspaceId ? { workspaceId } : {}),
  payload: {
    sessionId,
    repo: "synap-backend",
    branch: "lane/x",
    planMarkdown: "1. Fix it.",
    gateCommand: "pnpm test",
  },
});

describe("POST /proposals/dev-approval — a key limited to CRM gates only its sessions", () => {
  it("a session in Brand: 403, nothing filed", async () => {
    for (const key of ["crm", "crmStar"] as const) {
      for (const ws of [undefined, CRM, BRAND]) {
        const res = await post(
          key,
          "/proposals/dev-approval",
          planApproval(SESSION_BRAND, ws)
        );
        expect(res.status, `${key} ${ws}`).toBe(403);
      }
    }
    expect(h.filed).toEqual([]);
  });

  it("a CRM session filed under Brand: 403", async () => {
    const res = await post(
      "crm",
      "/proposals/dev-approval",
      planApproval(SESSION_CRM, BRAND)
    );
    expect(res.status).toBe(403);
    expect(h.filed).toEqual([]);
  });

  it("an unknown session: 403", async () => {
    const res = await post(
      "crm",
      "/proposals/dev-approval",
      planApproval(randomUUID())
    );
    expect(res.status).toBe(403);
    expect(h.filed).toEqual([]);
  });

  it("a CRM session without `session.update`: 403", async () => {
    const res = await post(
      "crmRecords",
      "/proposals/dev-approval",
      planApproval(SESSION_CRM)
    );
    expect(res.status).toBe(403);
    expect(h.filed).toEqual([]);
  });

  it("CONTROL — its own CRM session: filed in the session's space", async () => {
    const res = await post(
      "crm",
      "/proposals/dev-approval",
      planApproval(SESSION_CRM)
    );
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(h.filed).toHaveLength(1);
    expect(h.filed[0]).toMatchObject({
      proposalType: "dev.plan_approval",
      workspaceId: CRM,
    });
  });

  it("CONTROL — an unbounded key files for any session, as before", async () => {
    const res = await post(
      "full",
      "/proposals/dev-approval",
      planApproval(SESSION_BRAND, BRAND)
    );
    expect(res.status).toBe(200);
    expect(h.filed[0]!.workspaceId).toBe(BRAND);
  });
});
