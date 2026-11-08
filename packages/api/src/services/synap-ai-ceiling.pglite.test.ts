/**
 * Synap AI's standing grant (`resolveSynapAiCeiling`) on a real Postgres, so the join and every filter are tested:
 * only the OPERATOR's PERSONAL agent is Synap AI; its ceiling is the live grants with client_id "synap-ai" on an
 * active key; revoked, expired, other-client, other-principal and inactive-key rows are not in it; a paused agent
 * is refused; nothing configured is `none` (today's behaviour). `narrowedByApp` is the exact meet, never wider.
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
  const mocked = { ...actual };
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
  narrowedByApp,
  resolveSynapAiCeiling,
  SYNAP_AI_CLIENT_ID,
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

async function addKey(userId: string, active = true): Promise<string> {
  const id = randomUUID();
  await q(`insert into api_keys (id, user_id, is_active) values ($1, $2, $3)`, [
    id,
    userId,
    active,
  ]);
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
    clientId: SYNAP_AI_CLIENT_ID as string | null,
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
    ["a revoked grant", { revoked: true }, true],
    ["an expired grant", { expires: "2020-01-01T00:00:00Z" }, true],
    [
      "a grant of another client (the agent's other keys)",
      { clientId: "app_other" },
      true,
    ],
    ["a grant of a bare key (no client)", { clientId: null }, true],
    ["a grant held for another principal", { principal: PERSONA }, true],
    ["a grant on an INACTIVE key", {}, false],
  ] as const)("%s is not in the ceiling", async (_name, over, keyActive) => {
    await reset();
    const key = await addKey(SYNAP_AI, keyActive);
    await addGrant(key, over as never);
    expect(await resolveSynapAiCeiling(OPERATOR, SYNAP_AI)).toEqual({
      status: "none",
    });
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
