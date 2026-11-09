/**
 * Synap AI's standing grant on a real Postgres, so the joins and every filter are tested: only the OPERATOR's PERSONAL
 * agent is Synap AI; its ceiling is the live grants on its pod-held key (service / instance "synap-ai"), as the Keys page
 * writes them (no client id); revoked or expired grants, other keys, revoked or expired keys, another principal are not in
 * it; a paused agent is refused; nothing configured is `none`. `ensureSynapAiKey` makes the key once; `synapAiGate` is the
 * door's question. `narrowedByApp` is the exact meet, never wider.
 *
 * ENGINE: PGlite; the tables are created from their drizzle definitions (enums as text, constraints dropped).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return {
    db: undefined as unknown,
    client: undefined as
      | undefined
      | {
          exec: (s: string) => Promise<unknown>;
          query: (s: string, p?: unknown[]) => Promise<unknown>;
        },
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    eventRepository: { append: async () => undefined },
    // ensureSynapAiKey builds its own repository: its event append must not reach a real store.
    EventRepository: class {
      async append() {
        return undefined;
      }
    },
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { apiKeys, grants, users } from "@synap/database/schema";
import {
  ensureSynapAiKey,
  narrowedByApp,
  resolveSynapAiCeiling,
  SYNAP_AI_CLIENT_ID,
  SYNAP_AI_KEY_INSTANCE,
  synapAiGate,
} from "./synap-ai-ceiling.js";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault)
      def = " default now()";
    else if (c.primary && type === "uuid") def = " default gen_random_uuid()";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

const OPERATOR = "operator-human";
const STRANGER = "stranger-human";
const SYNAP_AI = randomUUID(); // OPERATOR's personal agent
const PERSONA = randomUUID(); // an agent of OPERATOR that is not the personal one
const STRANGERS_AI = randomUUID(); // a personal agent of someone else
const WS_A = randomUUID();
const WS_B = randomUUID();

const q = (sql: string, params: unknown[] = []) =>
  holder.client!.query(sql, params);

async function addKey(
  userId: string,
  over: Partial<{
    active: boolean;
    keyType: string;
    instance: string | null;
    revoked: boolean;
    expires: string | null;
  }> = {}
): Promise<string> {
  const o = {
    active: true,
    keyType: "service",
    instance: SYNAP_AI_KEY_INSTANCE as string | null,
    revoked: false,
    expires: null as string | null,
    ...over,
  };
  const id = randomUUID();
  await q(
    `insert into api_keys (id, user_id, is_active, key_type, instance_id, revoked_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      userId,
      o.active,
      o.keyType,
      o.instance,
      o.revoked ? new Date().toISOString() : null,
      o.expires,
    ]
  );
  return id;
}
async function addGrant(
  keyId: string,
  over: Partial<{
    principal: string;
    clientId: string | null;
    permissions: string[];
    workspaceIds: string[] | null;
    revoked: boolean;
    expires: string | null;
  }> = {}
) {
  const o = {
    principal: SYNAP_AI,
    clientId: null as string | null,
    permissions: ["entity.read"],
    workspaceIds: [WS_A] as string[] | null,
    revoked: false,
    expires: null as string | null,
    ...over,
  };
  await q(
    `insert into grants (api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, client_id, created_by, revoked_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $3, $7, $8)`,
    [
      keyId,
      o.principal,
      OPERATOR,
      o.permissions,
      o.workspaceIds,
      o.clientId,
      o.revoked ? new Date().toISOString() : null,
      o.expires,
    ]
  );
}
async function reset() {
  await q(`delete from grants`);
  await q(`delete from api_keys`);
  await q(`update users set agent_paused_at = null`);
}

beforeAll(async () => {
  const client = new PGlite();
  holder.client = client as never;
  for (const t of [users, apiKeys, grants])
    await client.exec(ddlFor(t as unknown as PgTable));
  holder.db = drizzle(client);
  const agent = (id: string, by: string, personal: boolean) =>
    q(
      `insert into users (id, email, user_type, created_by_user_id, is_personal_agent) values ($1, $2, 'agent', $3, $4)`,
      [id, `${id}@agent`, by, personal]
    );
  await q(
    `insert into users (id, email, user_type) values ($1, 'op@x', 'human'), ($2, 'st@x', 'human')`,
    [OPERATOR, STRANGER]
  );
  await agent(SYNAP_AI, OPERATOR, true);
  await agent(PERSONA, OPERATOR, false);
  await agent(STRANGERS_AI, STRANGER, true);
});

describe("resolveSynapAiCeiling", () => {
  it("nothing configured: none (today's behaviour), not a refusal", async () => {
    await reset();
    expect(await resolveSynapAiCeiling(OPERATOR, SYNAP_AI)).toEqual({
      status: "none",
    });
  });

  it("the live grants of an active key with client_id synap-ai are the ceiling (non-vacuity: every field arrives)", async () => {
    await reset();
    const key = await addKey(SYNAP_AI);
    await addGrant(key, {
      permissions: ["entity.read", "document.read"],
      workspaceIds: [WS_A],
    });
    await addGrant(key, { permissions: ["project.read"], workspaceIds: null });
    const r = await resolveSynapAiCeiling(OPERATOR, SYNAP_AI);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.grant.clientId).toBe(SYNAP_AI_CLIENT_ID);
    expect(r.grant.scopes).toEqual(
      expect.arrayContaining([
        {
          permissions: ["entity.read", "document.read"],
          workspaceIds: [WS_A],
          projectIds: null,
          entityIds: null,
        },
        {
          permissions: ["project.read"],
          workspaceIds: null,
          projectIds: null,
          entityIds: null,
        },
      ])
    );
    expect(r.grant.scopes).toHaveLength(2);
  });

  it.each([
    ["a revoked grant", "grant", { revoked: true }],
    ["an expired grant", "grant", { expires: "2020-01-01T00:00:00Z" }],
    ["a grant held for another principal", "grant", { principal: PERSONA }],
    ["a grant on an INACTIVE key", "key", { active: false }],
    ["a grant on a REVOKED key", "key", { revoked: true }],
    ["a grant on an EXPIRED key", "key", { expires: "2020-01-01T00:00:00Z" }],
    [
      "a grant on the agent's OTHER key (another instance)",
      "key",
      { instance: "laptop" },
    ],
    [
      "a grant on a key of another type (a hub key)",
      "key",
      { keyType: "hub_inbound" },
    ],
  ] as const)("%s is not in the ceiling", async (_name, on, over) => {
    await reset();
    const key = await addKey(SYNAP_AI, on === "key" ? (over as never) : {});
    await addGrant(key, on === "grant" ? (over as never) : {});
    expect(await resolveSynapAiCeiling(OPERATOR, SYNAP_AI)).toEqual({
      status: "none",
    });
  });

  it("a grant with a client id still counts: the Keys page sets none, the ceiling does not depend on it", async () => {
    await reset();
    const key = await addKey(SYNAP_AI);
    await addGrant(key, { clientId: "anything" });
    expect((await resolveSynapAiCeiling(OPERATOR, SYNAP_AI)).status).toBe("ok");
  });

  it("a grant that is still live (future expiry) IS in it", async () => {
    await reset();
    const key = await addKey(SYNAP_AI);
    await addGrant(key, { expires: "2999-01-01T00:00:00Z" });
    expect((await resolveSynapAiCeiling(OPERATOR, SYNAP_AI)).status).toBe("ok");
  });

  it("a grant with no permission is nothing: none", async () => {
    await reset();
    const key = await addKey(SYNAP_AI);
    await addGrant(key, { permissions: [] });
    expect(await resolveSynapAiCeiling(OPERATOR, SYNAP_AI)).toEqual({
      status: "none",
    });
  });

  it("another agent is not Synap AI: a non-personal agent, a stranger's personal agent, a human, an unknown id", async () => {
    await reset();
    const key = await addKey(PERSONA);
    await addGrant(key, { principal: PERSONA });
    for (const id of [PERSONA, STRANGERS_AI, OPERATOR, randomUUID()]) {
      expect(await resolveSynapAiCeiling(OPERATOR, id), id).toEqual({
        status: "not-applicable",
      });
    }
    // The operator's own personal agent, named by someone else's turn, is not theirs to use.
    expect(await resolveSynapAiCeiling(STRANGER, SYNAP_AI)).toEqual({
      status: "not-applicable",
    });
  });

  it("a paused Synap AI is refused, even with a ceiling", async () => {
    await reset();
    const key = await addKey(SYNAP_AI);
    await addGrant(key);
    await q(`update users set agent_paused_at = now() where id = $1`, [
      SYNAP_AI,
    ]);
    expect(await resolveSynapAiCeiling(OPERATOR, SYNAP_AI)).toEqual({
      status: "refused",
      reason: "paused",
    });
  });
});

describe("ensureSynapAiKey", () => {
  it("makes the agent's pod-held key once: linked to the person, nothing can authenticate with it", async () => {
    await reset();
    const first = await ensureSynapAiKey(OPERATOR);
    expect(first.agentUserId).toBe(SYNAP_AI);
    const rows = (await q(
      `select user_id, linked_user_id, key_type, instance_id, is_active, scope, key_name from api_keys where id = $1`,
      [first.keyId]
    )) as { rows: Record<string, unknown>[] };
    expect(rows.rows[0]).toMatchObject({
      user_id: SYNAP_AI,
      linked_user_id: OPERATOR,
      key_type: "service",
      instance_id: SYNAP_AI_KEY_INSTANCE,
      is_active: true,
      key_name: "Synap AI",
    });
    expect(rows.rows[0]!.scope).toEqual([]);
    expect((await ensureSynapAiKey(OPERATOR)).keyId).toBe(first.keyId);
    const count = (await q(
      `select count(*)::int as n from api_keys where user_id = $1`,
      [SYNAP_AI]
    )) as { rows: { n: number }[] };
    expect(count.rows[0]!.n).toBe(1);
  });

  it("a person with no personal agent yet gets one, and its key", async () => {
    await reset();
    await q(
      `insert into users (id, email, user_type) values ('fresh-human', 'fresh@x', 'human') on conflict do nothing`
    );
    const made = await ensureSynapAiKey("fresh-human");
    expect(made.agentUserId).not.toBe(SYNAP_AI);
    const agent = (await q(
      `select created_by_user_id, is_personal_agent from users where id = $1`,
      [made.agentUserId]
    )) as { rows: Record<string, unknown>[] };
    expect(agent.rows[0]).toMatchObject({
      created_by_user_id: "fresh-human",
      is_personal_agent: true,
    });
  });

  it("a revoked key is replaced by a new one (the person's revoke is not a dead end)", async () => {
    await reset();
    const old = await ensureSynapAiKey(OPERATOR);
    await q(
      `update api_keys set is_active = false, revoked_at = now() where id = $1`,
      [old.keyId]
    );
    const next = await ensureSynapAiKey(OPERATOR);
    expect(next.keyId).not.toBe(old.keyId);
  });
});

describe("synapAiGate: may an app's chat turn run for this person", () => {
  const POD = "https://pod.test.synap.live";
  beforeAll(() => {
    process.env.POD_ADMIN_URL = "https://pod-admin.test.synap.live";
  });

  it("not connected: refused with the Keys page, and the key the person will edit now exists", async () => {
    await reset();
    const r = await synapAiGate(OPERATOR, POD);
    expect(r).toEqual({
      open: false,
      status: 409,
      body: expect.objectContaining({
        code: "SYNAP_AI_NOT_CONNECTED",
        connectUrl: "https://pod-admin.test.synap.live/keys",
      }),
    });
    const keys = (await q(
      `select count(*)::int as n from api_keys where user_id = $1 and instance_id = $2 and is_active`,
      [SYNAP_AI, SYNAP_AI_KEY_INSTANCE]
    )) as { rows: { n: number }[] };
    expect(keys.rows[0]!.n).toBe(1);
  });

  it("a key with no grant yet is still not connected (the person has not said what it may read)", async () => {
    await reset();
    await addKey(SYNAP_AI);
    expect((await synapAiGate(OPERATOR, POD)).open).toBe(false);
  });

  it("connected (the person set a grant on its key): open", async () => {
    await reset();
    const key = await addKey(SYNAP_AI);
    await addGrant(key, { permissions: ["entity.read", "document.read"] });
    expect(await synapAiGate(OPERATOR, POD)).toEqual({ open: true });
  });

  it("paused: refused, even with a grant", async () => {
    await reset();
    const key = await addKey(SYNAP_AI);
    await addGrant(key);
    await q(`update users set agent_paused_at = now() where id = $1`, [
      SYNAP_AI,
    ]);
    const r = await synapAiGate(OPERATOR, POD);
    expect(r).toMatchObject({ open: false, body: { code: "SYNAP_AI_PAUSED" } });
  });
});

describe("narrowedByApp", () => {
  const ceiling = {
    scopes: [
      {
        permissions: ["entity.read", "document.read"],
        workspaceIds: [WS_A, WS_B],
        projectIds: null,
        entityIds: null,
      },
    ],
    clientId: SYNAP_AI_CLIENT_ID,
  };

  it("no app: the ceiling itself", () => {
    expect(narrowedByApp(ceiling, null)).toBe(ceiling);
  });

  it("an app narrows: the meet, never wider than either, and the app is the client", () => {
    const app = {
      scopes: [
        {
          permissions: ["entity.read", "playbook.run"],
          workspaceIds: [WS_A],
          projectIds: null,
          entityIds: null,
        },
      ],
      clientId: "app_chat",
    };
    const g = narrowedByApp(ceiling, app);
    expect(g.clientId).toBe("app_chat");
    expect(g.scopes).toEqual([
      {
        permissions: ["entity.read"],
        workspaceIds: [WS_A],
        projectIds: null,
        entityIds: null,
      },
    ]);
  });

  it("no overlap: may touch nothing (a scope with no permission), never the ceiling", () => {
    const app = {
      scopes: [
        {
          permissions: ["playbook.run"],
          workspaceIds: [WS_A],
          projectIds: null,
          entityIds: null,
        },
      ],
      clientId: "app_chat",
    };
    const g = narrowedByApp(ceiling, app);
    expect(g.scopes.every((s) => s.permissions.length === 0)).toBe(true);
  });

  it("an app pinned to a space the ceiling does not reach: nothing", () => {
    const app = {
      scopes: [
        {
          permissions: ["entity.read"],
          workspaceIds: [randomUUID()],
          projectIds: null,
          entityIds: null,
        },
      ],
      clientId: "app_chat",
    };
    expect(
      narrowedByApp(ceiling, app).scopes.every(
        (s) => s.permissions.length === 0
      )
    ).toBe(true);
  });
});
