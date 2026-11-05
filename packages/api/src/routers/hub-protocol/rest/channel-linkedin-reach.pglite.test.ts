/**
 * POST /channels/linkedin-reach/:personId (finding 491ba787) through the REAL
 * hub auth door (its W1 fence + `runWithGrant`), the REAL route, the REAL
 * reach rule and writers (`recordLinkedinReach`, `fillLinkedinProviderId`,
 * `recordProviderId`) and the REAL lookup budget, on PGlite. Stubbed: the key
 * lookup, the guest check, and the provider connector at its boundary
 * (`getProfile`, a fake Unipile).
 *
 * Rows rule out:
 *   - a profile read that answered FIRST_DEGREE and a member id leaving
 *     nothing on the person (the 5 Nov `linkedin_get_profile` run);
 *   - a stored `linkedinProviderId` overwritten, or a stored pending request
 *     flipped to "none" by a cheap profile read;
 *   - a failed read written as a fact (it writes nothing and answers 502);
 *   - a person outside the key's space measured, or a key without
 *     `channel.read` let through.
 *
 * Cannot see: production Postgres, a real minted app token, a live Unipile
 * account.
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
vi.mock("../../../connectors/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMessagingConnector: async () => h.connector,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerChannelConversationsRoutes } from "./channel-conversations.js";
import { registerChannelsRoutes } from "./channels.js";
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
          : c.name === "revision_history"
            ? " default '[]'::jsonb"
            : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID();
const CRM = randomUUID();
const OTHER = randomUUID();
const PERSON_KIND = randomUUID();
const ROLE_LEAD = randomUUID();
const ACCOUNT_ROW = randomUUID();
const ACCOUNT = "acc-1";

/** ERIC: a profile URL only. PAT: a stored pending request and an id. */
const ERIC = randomUUID();
const PAT = randomUUID();
const ELSEWHERE = randomUUID();

interface Key {
  id: string;
  userId: string;
  keyType: string;
  permissions: string[];
  workspaceIds: string[] | null;
}
const KEYS = {
  /** The CRM, signed in as the person. */
  crm: {
    id: randomUUID(),
    userId: OWNER,
    keyType: "app_person",
    permissions: ["entity.*.read", "channel.read"],
    workspaceIds: [CRM],
  },
  /** An app that never got the person's messaging consent. */
  noChannel: {
    id: randomUUID(),
    userId: OWNER,
    keyType: "app_person",
    permissions: ["entity.*.read"],
    workspaceIds: [CRM],
  },
} satisfies Record<string, Key>;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const getProfile = vi.fn();

const ERIC_FIRST_DEGREE = {
  providerId: "ACoAAAQflQYB",
  publicIdentifier: "eric-doyen",
  name: "Eric Doyen",
  networkDistance: "FIRST_DEGREE",
  connection: "connected",
  relationRequest: null,
};

async function propsOf(id: string): Promise<Record<string, unknown>> {
  const r = await q<{ properties: Record<string, unknown> }>(
    `select properties from entities where id=$1`,
    [id]
  );
  return r.rows[0]!.properties;
}

async function setProps(id: string, props: object) {
  await q(`update entities set properties=$2::jsonb where id=$1`, [
    id,
    JSON.stringify(props),
  ]);
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, user_type, name) values ($1,$2,'human','Owner')`,
    [OWNER, "owner@example.test"]
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
       ($2,'lead','Lead','role','workspace','workspace',true,'{}'::jsonb,null)`,
    [PERSON_KIND, ROLE_LEAD]
  );
  for (const [id, title, ws] of [
    [ERIC, "Eric Doyen", CRM],
    [PAT, "Pat Pending", CRM],
    [ELSEWHERE, "Eli Elsewhere", OTHER],
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
  }
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id, display_name, status, metadata, created_at, updated_at)
     values ($1,$2,'linkedin',$3,'Me on LinkedIn','connected','{}'::jsonb,now(),now())`,
    [ACCOUNT_ROW, OWNER, ACCOUNT]
  );
  for (const k of Object.values(KEYS)) {
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,null,true)`,
      [k.id, k.userId]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by, client_id)
       values ($1,$2,$3,$3,$4::text[],$5::uuid[],$3,'crm-app')`,
      [
        randomUUID(),
        k.id,
        k.userId,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
      ]
    );
  }
}, 120_000);

beforeEach(async () => {
  h.connector = { requiresAccount: () => true, getProfile };
  getProfile.mockReset();
  getProfile.mockResolvedValue(ERIC_FIRST_DEGREE);
  await setProps(ERIC, {
    linkedinUrl: "https://www.linkedin.com/in/eric-doyen",
  });
  await setProps(PAT, {
    linkedinProviderId: "ACoPat",
    linkedinConnection: "pending",
    linkedinInvitedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  });
  await q(`delete from entity_identity_signals`);
  await q(`update messaging_accounts set metadata='{}'::jsonb`);
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const key: Key = KEYS[bearer.replace(/^synap_/, "") as KeyName];
    return {
      status: "valid",
      record: {
        id: key.id,
        userId: key.userId,
        linkedUserId: null,
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

const measure = (key: KeyName, personId: string) =>
  app().request(`/api/hub/channels/linkedin-reach/${personId}`, {
    method: "POST",
    headers: { authorization: `Bearer synap_${key}` },
  });

describe("POST /channels/linkedin-reach/:personId", () => {
  it("a 1st-degree profile lands on the person: connected, the member id, its identity signal", async () => {
    const res = await measure("crm", ERIC);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reach: "connected",
      invitedAt: null,
      providerId: "ACoAAAQflQYB",
    });
    // Looked up by the handle of the stored profile URL, with the account.
    expect(getProfile).toHaveBeenCalledWith(ACCOUNT, "eric-doyen");
    const props = await propsOf(ERIC);
    expect(props.linkedinConnection).toBe("connected");
    expect(props.linkedinProviderId).toBe("ACoAAAQflQYB");
    const signals = await q<{ signal_value: string }>(
      `select signal_value from entity_identity_signals where entity_id=$1 and signal_type='external_id'`,
      [ERIC]
    );
    expect(signals.rows.map((r) => r.signal_value)).toEqual([
      "linkedin:ACoAAAQflQYB",
    ]);
    // One lookup spent from the account's daily budget.
    const meta = await q<{ metadata: { profileLookups?: { count: number } } }>(
      `select metadata from messaging_accounts where id=$1`,
      [ACCOUNT_ROW]
    );
    expect(meta.rows[0]!.metadata.profileLookups?.count).toBe(1);
  });

  it("a 'not connected' read keeps a stored pending request and a stored id", async () => {
    getProfile.mockResolvedValue({
      providerId: "ACoPat",
      publicIdentifier: "pat",
      name: "Pat Pending",
      networkDistance: "SECOND_DEGREE",
      connection: "not_connected",
      relationRequest: null,
    });
    const before = await propsOf(PAT);
    const res = await measure("crm", PAT);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reach).toBe("pending");
    expect(getProfile).toHaveBeenCalledWith(ACCOUNT, "ACoPat");
    const after = await propsOf(PAT);
    expect(after.linkedinConnection).toBe("pending");
    expect(after.linkedinInvitedAt).toBe(before.linkedinInvitedAt);
    expect(after.linkedinProviderId).toBe("ACoPat");
  });

  it("a failed read writes nothing and answers the error, never 'not connected'", async () => {
    getProfile.mockRejectedValue(new Error("Unipile getProfile: 503"));
    const res = await measure("crm", ERIC);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("PROVIDER_FAILED");
    const props = await propsOf(ERIC);
    expect(props.linkedinConnection).toBeUndefined();
    expect(props.linkedinProviderId).toBeUndefined();
    const signals = await q(
      `select 1 from entity_identity_signals where entity_id=$1`,
      [ERIC]
    );
    expect(signals.rows).toEqual([]);
  });

  it("SECURITY: a person outside the key's space is not found; LinkedIn is not called", async () => {
    const res = await measure("crm", ELSEWHERE);
    expect(res.status).toBe(404);
    expect(getProfile).not.toHaveBeenCalled();
  });

  it("SECURITY: a key without the person's messaging consent (channel.read) is refused", async () => {
    const res = await measure("noChannel", ERIC);
    expect(res.status).toBe(403);
    expect(getProfile).not.toHaveBeenCalled();
    expect((await propsOf(ERIC)).linkedinConnection).toBeUndefined();
  });
});
