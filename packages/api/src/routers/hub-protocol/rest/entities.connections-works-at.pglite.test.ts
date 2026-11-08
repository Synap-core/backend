/**
 * CRM G17: a company's people, read by a pod app through `GET /entities/:id/
 * connections?workspaceId=S` with a key granted space S. On the founder's pod
 * Jean-Luc (a pod-wide person with no role, filed for the CRM space) `works_at`
 * Attitude Sport (a pod-wide company wearing the `lead` role in CRM); the edge
 * between two pod-wide records carries no space, and the door returned nobody
 * ("Nobody at Attitude Sport yet").
 *
 * The door now returns a pod-wide `works_at` edge, with its neighbour, when
 * either end wears a role in a granted space (stamped there, or a shared role
 * granted to it) and the key reads both ends (grant-read.ts
 * `worksAtRoleLinkWhere`); and a workspace lens no longer drops a pod-wide
 * neighbour the caller reads there (relations.ts
 * `entityConnectionVisibilityWhere` → the entity read floor).
 *
 * Through the REAL hub auth door (its W1 fence + `runWithGrant`), the REAL
 * route → tRPC `relations.getConnections`, the grant read seam compiled and
 * run as SQL on PGlite. Only the key lookup and the guest check are stubbed;
 * the key's grant is a real `grants` row.
 *
 * Rows rule out: an edge whose ends wear no role in S (both read through their
 * home space) coming back, an end the app does not read (no role, no home)
 * coming back, another edge type between the same records, and a company whose
 * role is in another space. The full-access control shows the floor alone
 * returns the edges the CRM key must not.
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
  getApiKeyStatus: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerEntitiesRoutes } from "./entities.js";
import type { HubHono, HubVariables } from "./_shared.js";

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
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID(); // the person who connected the app
const AGENT = randomUUID(); // the app's own agent (the key principal)
const CRM = randomUUID();
const OTHER = randomUUID();
const PERSON_KIND = randomUUID();
const COMPANY_KIND = randomUUID();
const ROLE_LEAD = randomUUID(); // stamped per space
const ROLE_CLIENT = randomUUID(); // shared, granted to CRM (facet stored NULL)

// Companies (all pod-wide).
const ATTITUDE = randomUUID(); // LEAD stamped in CRM          (the pod's case)
const PODCO = randomUUID(); // CLIENT, shared role granted to CRM
const HOMEDCO = randomUUID(); // no role, filed for CRM (home) → read, not roled
const OTHERCO = randomUUID(); // LEAD in OTHER only
// People (all pod-wide, no role).
const JEANLUC = randomUUID(); // home CRM, works_at ATTITUDE  → returned
const PAULINE = randomUUID(); // home CRM, works_at PODCO     → returned
const UNHOMED = randomUUID(); // no home, works_at ATTITUDE  → not (unread end)
const HOMED = randomUUID(); // home CRM, works_at HOMEDCO     → not (no role)
const OTTO = randomUUID(); // home CRM, works_at OTHERCO      → not (role elsewhere)
const REL_RELATED = randomUUID(); // JEANLUC related_to ATTITUDE → not (type)

const READ_ONLY = ["hub-protocol.read"];
const KEYS = {
  /** The CRM app as it asks today (site-crm site.config.ts). */
  crm: {
    id: randomUUID(),
    permissions: [
      "entity.person.read",
      "entity.company.read",
      "facet.read",
      "relation.read",
    ],
    workspaceIds: [CRM] as string[] | null,
  },
  /** The owner, unbounded: the floor alone. */
  full: {
    id: randomUUID(),
    permissions: ["*"],
    workspaceIds: null as string[] | null,
  },
};
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
       ($3,'lead','Lead','role','workspace','workspace',true,'{}'::jsonb,null),
       ($4,'client','Client','role','shared','pod',true,'{}'::jsonb,null)`,
    [PERSON_KIND, COMPANY_KIND, ROLE_LEAD, ROLE_CLIENT]
  );
  await q(
    `insert into profile_workspace_access (profile_id, workspace_id) values ($1,$2)`,
    [ROLE_CLIENT, CRM]
  );
  for (const [id, kind, kindId, title, home] of [
    [ATTITUDE, "company", COMPANY_KIND, "Attitude Sport", null],
    [PODCO, "company", COMPANY_KIND, "Podco", null],
    [HOMEDCO, "company", COMPANY_KIND, "Homedco", CRM],
    [OTHERCO, "company", COMPANY_KIND, "Otherco", null],
    [JEANLUC, "person", PERSON_KIND, "Jean-Luc", CRM],
    [PAULINE, "person", PERSON_KIND, "Pauline", CRM],
    [UNHOMED, "person", PERSON_KIND, "Una Unhomed", null],
    [HOMED, "person", PERSON_KIND, "Hugo Homed", CRM],
    [OTTO, "person", PERSON_KIND, "Otto", CRM],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, home_workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,null,$3,$4,$5,$6,'{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, home, kindId, kind, title]
    );
  }
  for (const [entityId, role, ws] of [
    [ATTITUDE, ROLE_LEAD, CRM],
    [PODCO, ROLE_CLIENT, null],
    [OTHERCO, ROLE_LEAD, OTHER],
  ] as const) {
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties)
       values ($1,$2,$3,$4,$5,'{}'::jsonb)`,
      [randomUUID(), entityId, role, OWNER, ws]
    );
  }
  // Every edge pod-wide (workspace_id null): both ends are pod-wide records.
  for (const [id, source, target, type] of [
    [randomUUID(), JEANLUC, ATTITUDE, "works_at"],
    [randomUUID(), PAULINE, PODCO, "works_at"],
    [randomUUID(), UNHOMED, ATTITUDE, "works_at"],
    [randomUUID(), HOMED, HOMEDCO, "works_at"],
    [randomUUID(), OTTO, OTHERCO, "works_at"],
    [REL_RELATED, JEANLUC, ATTITUDE, "related_to"],
  ] as const) {
    await q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type)
       values ($1,$2,null,$3,$4,$5)`,
      [id, OWNER, source, target, type]
    );
  }
  for (const k of Object.values(KEYS)) {
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
}, 120_000);

beforeEach(() => {
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const key = KEYS[bearer.replace(/^synap_/, "") as KeyName];
    return {
      status: "valid",
      record: {
        id: key.id,
        userId: AGENT,
        linkedUserId: OWNER,
        parentKeyId: null,
        scope: READ_ONLY,
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

interface Conn {
  entityId: string;
  entity: { id: string } | null;
  source: string;
  relationId?: string;
  relationType?: string;
  direction: string;
}

/** The graph connections of `id`, as the CRM reads them (lens = CRM). */
async function graphOf(key: KeyName, id: string): Promise<Conn[]> {
  const res = await app().request(
    `/api/hub/entities/${id}/connections?workspaceId=${CRM}&limit=100`,
    { headers: { authorization: `Bearer synap_${key}` } }
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { connections: Conn[] };
  return body.connections.filter((c) => c.source === "graph");
}
const neighbours = (conns: Conn[]) => conns.map((c) => c.entityId).sort();

describe("GET /entities/:id/connections?workspaceId=CRM — a pod-wide works_at edge reaches the app", () => {
  it("the company wearing a role stamped in CRM: its person comes back, edge and record (the Attitude Sport case)", async () => {
    const conns = await graphOf("crm", ATTITUDE);
    const jeanLuc = conns.find((c) => c.entityId === JEANLUC);
    expect(jeanLuc).toMatchObject({
      relationType: "works_at",
      direction: "incoming",
      entity: { id: JEANLUC },
    });
  });

  it("the other way round: the person's page shows the company", async () => {
    const conns = await graphOf("crm", JEANLUC);
    expect(
      conns.find(
        (c) => c.entityId === ATTITUDE && c.relationType === "works_at"
      )
    ).toMatchObject({ direction: "outgoing", entity: { id: ATTITUDE } });
  });

  it("a company wearing a SHARED role granted to CRM (facet stored pod-wide): its person comes back", async () => {
    expect(neighbours(await graphOf("crm", PODCO))).toEqual([PAULINE]);
    expect(neighbours(await graphOf("crm", PAULINE))).toEqual([PODCO]);
  });
});

describe("SECURITY: nothing else reaches the app", () => {
  it("only Jean-Luc's works_at edge: not the person the app does not read, not another edge type", async () => {
    const conns = await graphOf("crm", ATTITUDE);
    expect(neighbours(conns)).toEqual([JEANLUC]);
    expect(conns.map((c) => c.relationId)).not.toContain(REL_RELATED);
    expect(JSON.stringify(conns)).not.toContain("Una Unhomed");
  });

  it("an edge whose ends wear no role in CRM (both read through their home) is NOT returned", async () => {
    expect(await graphOf("crm", HOMEDCO)).toEqual([]);
    expect(await graphOf("crm", HOMED)).toEqual([]);
  });

  it("asked about the person the app does not read (by id): the edge to the lead company is NOT returned", async () => {
    // The neighbour (ATTITUDE) is one the app reads, so only the edge rule's
    // "both ends read" keeps this out: it would say who works where.
    expect(await graphOf("crm", UNHOMED)).toEqual([]);
  });

  it("the person of a company whose role is in another space: no edge", async () => {
    expect(await graphOf("crm", OTTO)).toEqual([]);
  });

  it("control: the owner's full key reads every one of those edges (the grant is what keeps them out)", async () => {
    expect(neighbours(await graphOf("full", ATTITUDE))).toEqual(
      [JEANLUC, JEANLUC, UNHOMED].sort()
    );
    expect(neighbours(await graphOf("full", HOMEDCO))).toEqual([HOMED]);
    expect(neighbours(await graphOf("full", OTTO))).toEqual([OTHERCO]);
  });
});
