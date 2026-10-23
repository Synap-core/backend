/**
 * D1 (review rv-model M3, 2026-10-23; DRAFT for the founder): a pod app
 * granted space S can WRITE a role in S, exactly as it reads one. The role IS
 * the space lens: the write is checked against the ROLE's space, never against
 * the pod-wide parent's own (null) workspace.
 *
 * The CRM's core loop, through the doors an app calls — `POST
 * /entities/:id/facets` (make a contact a lead), `PATCH /facets/:id` (move a
 * lead's stage, edit its fields), `DELETE /facets/:id` — with the REAL hub
 * auth door (W1 fence + `runWithGrant`), the REAL routes and governed doors
 * (`checkPermissionOrPropose`, `moveStatus`), and the key's grant as a real
 * `grants` row, on PGlite. The app's agent asks first (`ask-first`, the
 * posture every app connection starts with), so its writes are PROPOSALS; the
 * person's own token (principal = the person) applies.
 *
 * Rows rule out: the parent's null workspace still refusing (every pod-wide
 * person), a role in another space (Brand) passing, a shared role (one row,
 * seen in every space it is granted to) passing for a key limited to S, a role
 * pulling a record S cannot see into S (un-roled, roled elsewhere, a kind the
 * key cannot read), the role's lifecycle move staying refused (`entity.
 * transition` is not grantable), governance being bypassed (the agent's write
 * applied), the attach editing the parent's own fields, and a change for keys
 * that are not limited to spaces (`*`) or for a member.
 *
 * Mocked: the key lookup, the guest check, the sub-token mapping, the audit
 * log (captured: the approval's `.validated` event is replayed into the real
 * materializer, as its hook would), the event log (its own connection) and the
 * delivery side effects. Cannot see: production Postgres, a real minted app
 * key (the identity a mint yields is pinned by pod-app.invariants I3).
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
  audits: [] as Array<Record<string, unknown>>,
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
  auditLog: vi.fn(async (opts: Record<string, unknown>) => {
    h.audits.push(opts);
    return { id: globalThis.crypto.randomUUID() };
  }),
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

import { eq } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { applyAgentPosture } from "@synap/database/agent-governance";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { grantRequestKey } from "@synap/governance-policy";
import {
  InvalidPermissionError,
  parsePermission,
} from "@synap/governance-policy/grants";
import { handleMaterialize } from "@synap/jobs/workers/materializer.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { applyProposalApproval } from "../../proposals/apply-approval.js";
import { registerEntitiesRoutes } from "./entities.js";
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
const AGENT = randomUUID(); // the app's own agent (asks first)
const TEAMMATE = randomUUID(); // an editor of CRM, not the owner
const CRM = randomUUID();
const OTHER = randomUUID();
const BRAND = randomUUID(); // the owner's other space, never granted to the app
const PERSON_KIND = randomUUID();
const COMPANY_KIND = randomUUID();
const ROLE_LEAD = randomUUID(); // stamped per space; lifecycle `leadStage`
const ROLE_CONTACT = randomUUID(); // stamped per space
const ROLE_CLIENT = randomUUID(); // shared, granted to CRM (stored NULL)
const ROLE_VIP = randomUUID(); // stamped per space (LEAD wears it in Brand)
const LEAD_STAGE = randomUUID(); // the `leadStage` property def

const LEAD = randomUUID(); // pod-wide person: lead in CRM (stage new), vip in Brand, client
const CONTACT = randomUUID(); // pod-wide person: contact in CRM → "make a lead"
const CONTACT_B = randomUUID(); // pod-wide person: contact in CRM (person-mode attach)
const ONLY_CRM = randomUUID(); // pod-wide person: its ONE role in CRM is a contact
const STRANGER = randomUUID(); // pod-wide person, no role
const ELSEWHERE = randomUUID(); // pod-wide person, contact in OTHER
const ACME = randomUUID(); // pod-wide company: contact in CRM
const TEAM_PERSON = randomUUID(); // the teammate's pod-wide person, contact in CRM

const F_LEAD = randomUUID(); // LEAD's lead@CRM
const F_LEAD_VIP = randomUUID(); // LEAD's vip@Brand
const F_LEAD_CLIENT = randomUUID(); // LEAD's client (shared, NULL)
const F_ONLY = randomUUID(); // ONLY_CRM's contact@CRM
const F_ACME = randomUUID(); // ACME's contact@CRM

interface Key {
  id: string;
  permissions: string[];
  workspaceIds: string[] | null;
  principal: string;
  person: string;
}
/** What a CRM app asks for: read every kind, write roles, in CRM only. */
const CRM_APP = [
  "entity.*.read",
  "facet.read",
  "facet.create",
  "facet.update",
  "facet.delete",
];
const KEYS = {
  /** The CRM app's agent key (agent mode: its writes are proposals). */
  crm: {
    id: randomUUID(),
    permissions: CRM_APP,
    workspaceIds: [CRM],
    principal: AGENT,
    person: OWNER,
  },
  /** The person's own token for the CRM app (person mode: writes apply). */
  crmPerson: {
    id: randomUUID(),
    permissions: CRM_APP,
    workspaceIds: [CRM],
    principal: OWNER,
    person: OWNER,
  },
  /** The CRM app reading companies only: a person is not its to touch. */
  crmCompanies: {
    id: randomUUID(),
    permissions: [
      "entity.company.read",
      "facet.read",
      "facet.create",
      "facet.update",
    ],
    workspaceIds: [CRM],
    principal: AGENT,
    person: OWNER,
  },
  /** The CRM app with no role write at all. */
  crmReadOnly: {
    id: randomUUID(),
    permissions: ["entity.*.read", "facet.read"],
    workspaceIds: [CRM],
    principal: AGENT,
    person: OWNER,
  },
  /** The owner's agent, unbounded (`*`): not limited to spaces. */
  full: {
    id: randomUUID(),
    permissions: ["*"],
    workspaceIds: null,
    principal: AGENT,
    person: OWNER,
  },
  /** A MEMBER of CRM (editor), unbounded, acting as themself. */
  member: {
    id: randomUUID(),
    permissions: ["*"],
    workspaceIds: null,
    principal: TEAMMATE,
    person: TEAMMATE,
  },
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
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    TEAMMATE,
    "teammate@example.test",
  ]);
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member')`,
    [randomUUID(), OWNER, randomUUID(), TEAMMATE]
  );
  for (const [ws, name] of [
    [CRM, "CRM"],
    [OTHER, "Other"],
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
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
    [randomUUID(), CRM, TEAMMATE]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id) values
       ($1,'person','Person','kind','system','pod',true,'{}'::jsonb,null),
       ($2,'company','Company','kind','system','pod',true,'{}'::jsonb,null),
       ($3,'lead','Lead','role','workspace','workspace',true,'{}'::jsonb,null),
       ($4,'contact','Contact','role','workspace','workspace',true,'{}'::jsonb,null),
       ($5,'client','Client','role','shared','pod',true,'{}'::jsonb,null),
       ($6,'vip','VIP','role','workspace','workspace',true,'{}'::jsonb,null)`,
    [PERSON_KIND, COMPANY_KIND, ROLE_LEAD, ROLE_CONTACT, ROLE_CLIENT, ROLE_VIP]
  );
  await q(
    `insert into profile_workspace_access (profile_id, workspace_id) values ($1,$2)`,
    [ROLE_CLIENT, CRM]
  );
  // The lead's ONE lifecycle, `leadStage` (work model wave 0).
  await q(
    `insert into property_defs (id, slug, value_type, constraints, ui_hints) values ($1,'leadStage','string',$2::jsonb,'{}'::jsonb)`,
    [
      LEAD_STAGE,
      JSON.stringify({
        enumOptions: [
          { key: "new", category: "open" },
          { key: "engaged", category: "active" },
          { key: "won", category: "done" },
          { key: "lost", category: "lost" },
        ],
      }),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1,$2,true)`,
    [ROLE_LEAD, LEAD_STAGE]
  );
  for (const [id, kind, kindId, owner] of [
    [LEAD, "person", PERSON_KIND, OWNER],
    [CONTACT, "person", PERSON_KIND, OWNER],
    [CONTACT_B, "person", PERSON_KIND, OWNER],
    [ONLY_CRM, "person", PERSON_KIND, OWNER],
    [STRANGER, "person", PERSON_KIND, OWNER],
    [ELSEWHERE, "person", PERSON_KIND, OWNER],
    [ACME, "company", COMPANY_KIND, OWNER],
    [TEAM_PERSON, "person", PERSON_KIND, TEAMMATE],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,null,$3,$4,'e','{"email":"x@example.test"}'::jsonb,'{}'::jsonb)`,
      [id, owner, kindId, kind]
    );
  }
  for (const [id, entityId, role, ws, author, status] of [
    [F_LEAD, LEAD, ROLE_LEAD, CRM, OWNER, "new"],
    [F_LEAD_VIP, LEAD, ROLE_VIP, BRAND, OWNER, null],
    [F_LEAD_CLIENT, LEAD, ROLE_CLIENT, null, OWNER, null],
    [randomUUID(), CONTACT, ROLE_CONTACT, CRM, OWNER, null],
    [randomUUID(), CONTACT_B, ROLE_CONTACT, CRM, OWNER, null],
    [F_ONLY, ONLY_CRM, ROLE_CONTACT, CRM, OWNER, null],
    [randomUUID(), ELSEWHERE, ROLE_CONTACT, OTHER, OWNER, null],
    [F_ACME, ACME, ROLE_CONTACT, CRM, OWNER, null],
    [randomUUID(), TEAM_PERSON, ROLE_CONTACT, CRM, TEAMMATE, null],
  ] as const) {
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, properties)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        id,
        entityId,
        role,
        author,
        ws,
        status,
        JSON.stringify(status ? { leadStage: status } : {}),
      ]
    );
  }
  for (const k of Object.values(KEYS)) {
    // The act-as link a minted key carries (`resolveActorId` checks it on
    // writes): the key's principal acts for its person.
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,$3,true)`,
      [k.id, k.principal, k.person]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        k.principal,
        k.person,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
      ]
    );
  }
  // Every app connection starts "ask first": its agent's writes are proposals.
  await applyAgentPosture({
    db: h.db as never,
    agentUserId: AGENT,
    posture: "ask-first",
    createdBy: OWNER,
  });
}, 120_000);

beforeEach(() => {
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

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerEntitiesRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const send = (
  key: KeyName,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
) => {
  const json = body === undefined ? undefined : JSON.stringify(body);
  return app().request(`/api/hub${path}`, {
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
const attach = (key: KeyName, entityId: string, body: unknown) =>
  send(key, "POST", `/entities/${entityId}/facets`, body);

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const proposalCount = async () =>
  (await q(`select id from proposals`)).rows.length;

/** The live facets of `entityId` for `role`, with their stored space. */
const liveFacets = (entityId: string, role: string) =>
  q<{ id: string; workspace_id: string | null; status: string | null }>(
    `select id, workspace_id, status from entity_facets
      where entity_id = $1 and profile_id = $2 and deleted_at is null`,
    [entityId, role]
  ).then((r) => r.rows);

/** The parent's own fields: an attach never edits them. */
const coreOf = (id: string) =>
  q<{ title: string; workspace_id: string | null; properties: unknown }>(
    `select title, workspace_id, properties from entities where id = $1`,
    [id]
  ).then((r) => r.rows[0]);

// ─── POST /entities/:id/facets — make a contact a lead ─────────────────────

describe("the CRM app attaches a role in CRM onto a pod-wide person in its reach (D1)", () => {
  let proposalId: string;

  it("agent mode: proposed — nothing attached yet, the person's own fields untouched", async () => {
    const before = await coreOf(CONTACT);
    const res = await attach("crm", CONTACT, {
      profileSlug: "lead",
      workspaceId: CRM,
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("proposed");
    proposalId = String(body.proposalId);
    const { rows } = await q<{
      target_type: string;
      proposal_type: string;
      workspace_id: string | null;
      status: string;
    }>(
      `select target_type, proposal_type, workspace_id, status from proposals where id = $1`,
      [proposalId]
    );
    expect(rows[0]).toMatchObject({
      target_type: "facet",
      proposal_type: "attach",
      workspace_id: CRM,
      status: "pending",
    });
    expect(await liveFacets(CONTACT, ROLE_LEAD)).toEqual([]);
    expect(await coreOf(CONTACT)).toEqual(before);
  });

  it("the person approves it: the lead role exists on the pod-wide person, stamped in CRM", async () => {
    const proposal = await (
      h.db as {
        query: {
          proposals: { findFirst: (a: unknown) => Promise<unknown> };
        };
      }
    ).query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
    h.audits.length = 0;
    const result = await applyProposalApproval({
      proposal: proposal as never,
      userId: OWNER,
      input: { proposalId },
      ctx: { authenticated: true, userId: OWNER } as never,
    });
    expect(result.success).toBe(true);
    // The approval hands the write to the materializer through its
    // `.validated` event; replay it as the event hook would.
    const validated = h.audits.find((a) => a.phase === "validated");
    expect(validated, "a .validated event was appended").toBeDefined();
    await handleMaterialize({
      data: {
        eventId: randomUUID(),
        eventType: `${String(validated!.subjectType)}.${String(validated!.action)}.validated`,
        subjectType: String(validated!.subjectType),
        action: String(validated!.action),
        subjectId: String(validated!.subjectId),
        userId: String(validated!.userId),
        workspaceId:
          (validated!.workspaceId as string | undefined) ?? undefined,
        data: validated!.data as Record<string, unknown>,
      },
    } as never);
    const facets = await liveFacets(CONTACT, ROLE_LEAD);
    expect(facets).toHaveLength(1);
    expect(facets[0]!.workspace_id).toBe(CRM);
    expect((await coreOf(CONTACT))!.workspace_id).toBeNull();
  });

  it("person mode: the person's own token applies the attach, stamped in CRM", async () => {
    const before = await coreOf(CONTACT_B);
    const res = await attach("crmPerson", CONTACT_B, {
      profileSlug: "lead",
      workspaceId: CRM,
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("attached");
    const facets = await liveFacets(CONTACT_B, ROLE_LEAD);
    expect(facets.map((f) => f.workspace_id)).toEqual([CRM]);
    expect(await coreOf(CONTACT_B)).toEqual(before);
  });
});

describe("the CRM app cannot attach a role outside CRM, a shared role, or onto a record CRM does not reach", () => {
  it("a role in Brand: 403 from the grant, nothing filed, nothing attached", async () => {
    const before = await proposalCount();
    const res = await attach("crm", CONTACT, {
      profileSlug: "vip",
      workspaceId: BRAND,
    });
    expect(res.status).toBe(403);
    expect(String((await json(res)).error)).toMatch(
      /grant does not allow "facet\.create" in workspace/
    );
    expect(await proposalCount()).toBe(before);
    expect(await liveFacets(CONTACT, ROLE_VIP)).toEqual([]);
  });

  it("a shared role (stored pod-wide, seen in every space it is granted to): 403, and it says why", async () => {
    const before = await proposalCount();
    const res = await attach("crm", CONTACT, {
      profileSlug: "client",
      workspaceId: CRM,
    });
    expect(res.status).toBe(403);
    expect(String((await json(res)).error)).toMatch(/shared role/);
    expect(await proposalCount()).toBe(before);
    expect(await liveFacets(CONTACT, ROLE_CLIENT)).toEqual([]);
  });

  it("a pod-wide person with no role in CRM, or a role elsewhere only: 404 (not in the app's reach)", async () => {
    const before = await proposalCount();
    for (const id of [STRANGER, ELSEWHERE]) {
      const res = await attach("crm", id, {
        profileSlug: "lead",
        workspaceId: CRM,
      });
      expect(res.status, id).toBe(404);
      expect(await liveFacets(id, ROLE_LEAD)).toEqual([]);
    }
    expect(await proposalCount()).toBe(before);
  });

  it("a key reading companies only cannot put a role on a person: 404", async () => {
    const res = await attach("crmCompanies", CONTACT_B, {
      profileSlug: "contact",
      workspaceId: CRM,
    });
    expect(res.status).toBe(404);
  });

  it("a key with no facet.create: 403", async () => {
    const res = await attach("crmReadOnly", CONTACT_B, {
      profileSlug: "contact",
      workspaceId: CRM,
    });
    expect(res.status).toBe(403);
    expect(String((await json(res)).error)).toMatch(
      /grant does not allow "facet\.create"/
    );
  });
});

// ─── PATCH /facets/:id — move a lead's stage, edit its fields ───────────────

describe("the CRM app changes a CRM role on a pod-wide person (D1)", () => {
  it("moving the lead's stage (its lifecycle): proposed, the stage unchanged until approved", async () => {
    const before = await proposalCount();
    const res = await send("crm", "PATCH", `/facets/${F_LEAD}`, {
      status: "engaged",
      expectedStatus: "new",
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("proposed");
    expect(await proposalCount()).toBe(before + 1);
    expect((await liveFacets(LEAD, ROLE_LEAD))[0]!.status).toBe("new");
  });

  it("editing the role's fields: proposed, nothing written", async () => {
    const res = await send("crm", "PATCH", `/facets/${F_LEAD}`, {
      properties: { source: "expo" },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("proposed");
    const { rows } = await q<{ properties: Record<string, unknown> }>(
      `select properties from entity_facets where id = $1`,
      [F_LEAD]
    );
    expect(rows[0]!.properties).toEqual({ leadStage: "new" });
  });

  it("person mode: the field edit applies", async () => {
    const res = await send("crmPerson", "PATCH", `/facets/${F_ACME}`, {
      properties: { source: "referral" },
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("updated");
    const { rows } = await q<{ properties: Record<string, unknown> }>(
      `select properties from entity_facets where id = $1`,
      [F_ACME]
    );
    expect(rows[0]!.properties).toMatchObject({ source: "referral" });
  });

  it("the person's role in Brand, or its shared role: 403, nothing filed", async () => {
    const before = await proposalCount();
    for (const id of [F_LEAD_VIP, F_LEAD_CLIENT]) {
      const res = await send("crm", "PATCH", `/facets/${id}`, {
        properties: { source: "app" },
      });
      expect(res.status, id).toBe(403);
    }
    expect(await proposalCount()).toBe(before);
  });

  it("a key reading companies only cannot change a role on a person: 403", async () => {
    const res = await send("crmCompanies", "PATCH", `/facets/${F_LEAD}`, {
      properties: { source: "app" },
    });
    expect(res.status).toBe(403);
    // Control: the same key changes a CRM role on a company.
    const ok = await send("crmCompanies", "PATCH", `/facets/${F_ACME}`, {
      properties: { source: "app" },
    });
    expect(ok.status).toBe(200);
  });
});

// ─── DELETE /facets/:id ─────────────────────────────────────────────────────

describe("the CRM app takes a CRM role off (D1)", () => {
  it("agent mode: proposed, the role still live", async () => {
    const res = await send("crm", "DELETE", `/facets/${F_LEAD}`);
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("proposed");
    expect(await liveFacets(LEAD, ROLE_LEAD)).toHaveLength(1);
  });

  it("a role in another space (Brand): 403, still live", async () => {
    const res = await send("crm", "DELETE", `/facets/${F_LEAD_VIP}`);
    expect(res.status).toBe(403);
    expect(await liveFacets(LEAD, ROLE_VIP)).toHaveLength(1);
  });

  it("person mode: removing the record's LAST role in CRM is allowed, and the app then no longer reads it", async () => {
    expect(
      (await send("crmPerson", "GET", `/entities/${ONLY_CRM}`)).status
    ).toBe(200);
    const res = await send("crmPerson", "DELETE", `/facets/${F_ONLY}`);
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("detached");
    expect(await liveFacets(ONLY_CRM, ROLE_CONTACT)).toEqual([]);
    expect(
      (await send("crmPerson", "GET", `/entities/${ONLY_CRM}`)).status
    ).toBe(404);
  });
});

// ─── Unchanged: keys not limited to spaces, members ─────────────────────────

describe("unchanged for a key that is not limited to spaces, and for a member", () => {
  it("the owner's `*` agent key: a Brand role and a shared role are proposed, not refused", async () => {
    for (const [slug, ws] of [
      ["vip", BRAND],
      ["client", undefined],
    ] as const) {
      const res = await attach("full", CONTACT, {
        profileSlug: slug,
        ...(ws ? { workspaceId: ws } : {}),
      });
      const body = await json(res);
      expect(res.status, `${slug}: ${JSON.stringify(body)}`).toBe(200);
      expect(body.status).toBe("proposed");
    }
  });

  it("a member of CRM attaches a CRM role on their own pod-wide person", async () => {
    const res = await attach("member", TEAM_PERSON, {
      profileSlug: "lead",
      workspaceId: CRM,
    });
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("attached");
  });

  it("a member cannot attach onto the owner's pod-wide person (the write floor): 404", async () => {
    const res = await attach("member", CONTACT, {
      profileSlug: "lead",
      workspaceId: CRM,
    });
    expect(res.status).toBe(404);
  });
});

describe("the grammar: role writes are facet.create / update / delete; no kind qualifier", () => {
  it("attach folds to create, detach to delete (the actions an app may be granted)", () => {
    expect(grantRequestKey("facet", "attach")).toEqual({
      subject: "facet",
      action: "create",
    });
    expect(grantRequestKey("facet", "detach")).toEqual({
      subject: "facet",
      action: "delete",
    });
    expect(grantRequestKey("facet", "update")).toEqual({
      subject: "facet",
      action: "update",
    });
  });

  it("`facet.<role>.create` is not a permission: only `entity` takes a kind", () => {
    expect(() => parsePermission("facet.lead.create")).toThrow(
      InvalidPermissionError
    );
  });
});
