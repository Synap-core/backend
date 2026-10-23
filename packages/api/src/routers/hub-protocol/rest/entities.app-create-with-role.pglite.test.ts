/**
 * Verifies a claim in the SDK docs (review rv-model M3, marked SUSPECTED):
 * inline `facets` on `POST /entities` from a pod app granted space S.
 *
 *   POST /entities { workspaceId: CRM, profileSlug: "person", title,
 *                    facets: [{ slug: "lead" }] }
 *
 *  - agent mode (the app's agent asks first): the create is PROPOSED with its
 *    facets; when the person approves it, the person exists — stored IN CRM
 *    (an explicit workspaceId is honored for a pod-scope kind: rv-model S3) —
 *    and the `lead` facet is attached, stamped in CRM. The approval runs as the
 *    person (no key grant), so it attaches whatever the key could do.
 *  - person mode (the person's own token): the create APPLIES, then the inline
 *    attach runs through the governed attach door UNDER THE KEY'S GRANT. With
 *    `entity.person.create` alone it is refused, so the receipt is `partial`
 *    (the attach's outcome `error`). With `facet.create` too it is `applied`
 *    once facet/attach folds onto create (D1); before D1 no grant could allow
 *    the attach (`facet.attach` is not grantable), so it was `partial` too.
 *
 * Same harness as entities.app-role-write.pglite.test.ts (real hub auth door,
 * real routes, real governed doors and approval door on PGlite; the key's
 * grant a real `grants` row).
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

const OWNER = randomUUID();
const AGENT = randomUUID(); // the app's agent (asks first)
const CRM = randomUUID();
const PERSON_KIND = randomUUID();
const ROLE_LEAD = randomUUID();

interface Key {
  id: string;
  permissions: string[];
  principal: string;
}
const CREATE = ["entity.*.read", "entity.person.create"];
const KEYS = {
  /** The CRM app's agent: may create people in CRM. */
  agent: { id: randomUUID(), permissions: CREATE, principal: AGENT },
  /** The person's own token, same grant. */
  person: { id: randomUUID(), permissions: CREATE, principal: OWNER },
  /** The person's own token, also granted role writes in CRM. */
  personRoles: {
    id: randomUUID(),
    permissions: [...CREATE, "facet.read", "facet.create"],
    principal: OWNER,
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
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), OWNER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'CRM',$2,'{}'::jsonb)`,
    [CRM, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), CRM, OWNER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id) values
       ($1,'person','Person','kind','system','pod',true,'{}'::jsonb,null),
       ($2,'lead','Lead','role','workspace','workspace',true,'{}'::jsonb,null)`,
    [PERSON_KIND, ROLE_LEAD]
  );
  for (const k of Object.values(KEYS)) {
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,$3,true)`,
      [k.id, k.principal, OWNER]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        k.principal,
        OWNER,
        `{${k.permissions.join(",")}}`,
        `{${CRM}}`,
      ]
    );
  }
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
  registerEntitiesRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

async function create(key: KeyName, title: string) {
  const json = JSON.stringify({
    workspaceId: CRM,
    profileSlug: "person",
    title,
    facets: [{ slug: "lead" }],
  });
  const res = await app().request(`/api/hub/entities`, {
    method: "POST",
    headers: {
      authorization: `Bearer synap_${key}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
    },
    body: json,
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

const byTitle = (title: string) =>
  q<{ id: string; workspace_id: string | null }>(
    `select id, workspace_id from entities where title = $1 and deleted_at is null`,
    [title]
  ).then((r) => r.rows);
const leadFacets = (entityId: string) =>
  q<{ workspace_id: string | null }>(
    `select workspace_id from entity_facets where entity_id = $1 and profile_id = $2 and deleted_at is null`,
    [entityId, ROLE_LEAD]
  ).then((r) => r.rows);

describe("agent mode: POST /entities with inline facets is proposed; the approval attaches them", () => {
  let proposalId: string;

  it("proposed: nothing created yet", async () => {
    const { res, body } = await create("agent", "Ada Lovelace");
    // A proposed create answers 202 (PROPOSED_HTTP_STATUS).
    expect(res.status, JSON.stringify(body)).toBe(202);
    expect(body.status).toBe("proposed");
    proposalId = String(body.proposalId);
    expect(await byTitle("Ada Lovelace")).toEqual([]);
  });

  it("the person approves it: Ada exists, stored in CRM, with the lead facet stamped in CRM", async () => {
    const proposal = await (
      h.db as {
        query: {
          proposals: { findFirst: (a: unknown) => Promise<unknown> };
        };
      }
    ).query.proposals.findFirst({ where: eq(schema.proposals.id, proposalId) });
    const result = await applyProposalApproval({
      proposal: proposal as never,
      userId: OWNER,
      input: { proposalId },
      ctx: { authenticated: true, userId: OWNER } as never,
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    const rows = await byTitle("Ada Lovelace");
    expect(rows).toHaveLength(1);
    // An explicit workspaceId is honored for a pod-scope kind (rv-model S3).
    expect(rows[0]!.workspace_id).toBe(CRM);
    expect(await leadFacets(rows[0]!.id)).toEqual([{ workspace_id: CRM }]);
  });
});

describe("person mode: the create applies; the inline attach runs under the key's grant", () => {
  it("with entity.person.create only: created, receipt partial, the attach refused by the grant", async () => {
    const { res, body } = await create("person", "Grace Hopper");
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("created");
    const receipt = body.writeReceipt as { state: string };
    expect(receipt.state).toBe("partial");
    const facets = body.facets as Array<{ outcome: string; error?: string }>;
    expect(facets).toHaveLength(1);
    expect(facets[0]!.outcome).toBe("error");
    expect(facets[0]!.error).toMatch(
      /grant does not allow "facet\.(attach|create)"/
    );
    const rows = await byTitle("Grace Hopper");
    expect(rows).toHaveLength(1);
    expect(await leadFacets(rows[0]!.id)).toEqual([]);
  });

  it("with facet.create too: applied, the lead facet stamped in CRM (D1; partial before D1)", async () => {
    const { res, body } = await create("personRoles", "Katherine Johnson");
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("created");
    expect((body.writeReceipt as { state: string }).state).toBe("applied");
    const rows = await byTitle("Katherine Johnson");
    expect(await leadFacets(rows[0]!.id)).toEqual([{ workspace_id: CRM }]);
  });
});
