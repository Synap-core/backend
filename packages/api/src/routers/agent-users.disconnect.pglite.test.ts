/**
 * `agentUsers.disconnect` — revoke every hub key an agent holds, in one door,
 * on PGlite with the REAL router, the REAL owner/pod-admin check (on the
 * loaded agent row) and real `api_keys` rows. Asserts the ROWS, not a return
 * value alone: a door that reported a count and revoked nothing is the defect.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        users: actual.users as never,
        workspaces: actual.workspaces as never,
        workspaceMembers: actual.workspaceMembers as never,
        apiKeys: actual.apiKeys as never,
      },
    }),
  };
});
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/audit-log.js", () => ({
  auditLog: async (opts: Record<string, unknown>) => {
    h.audits.push(opts);
    return null;
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  users,
  apiKeys,
  workspaces,
  workspaceMembers,
  podMembers,
  projectMembers,
} from "@synap/database/schema";
import { agentUsersRouter } from "./agent-users.js";
import { apiKeyService } from "../services/api-keys.js";
import type { Context } from "../types/context.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    const base = raw.replace(/\[\]$/, "").replace(/\(.*\)/, "");
    const type = BASIC.test(base) ? base : "text";
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const ADMIN = "user-admin";
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const POD_ADMIN_WS = randomUUID();

function caller(userId: string, agentUserId?: string) {
  return agentUsersRouter.createCaller({
    authenticated: true,
    userId,
    ...(agentUserId ? { agentUserId } : {}),
  } as unknown as Context);
}

async function key(userId: string, active: boolean) {
  const id = randomUUID();
  await q(
    `insert into api_keys (id, user_id, is_active, revoked_at) values ($1, $2, $3, null)`,
    [id, userId, active]
  );
  return id;
}
const keyRow = (id: string) =>
  q<{
    is_active: boolean;
    revoked_at: string | null;
    revoked_by: string | null;
  }>(`select is_active, revoked_at, revoked_by from api_keys where id = $1`, [
    id,
  ]).then((r) => r.rows[0]!);

beforeAll(async () => {
  // pod_members / project_members: the user floor (`userVisibleWhere`) reads them.
  for (const t of [users, apiKeys, workspaces, workspaceMembers, podMembers, projectMembers])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values
       ($1, 'o@x', 'human', null), ($2, 's@x', 'human', null), ($3, 'a@x', 'human', null),
       ($4, 'agent@x', 'agent', $1), ($5, 'agent2@x', 'agent', $2)`,
    [OWNER, STRANGER, ADMIN, AGENT, OTHER_AGENT]
  );
  await q(
    `insert into workspaces (id, name, system_slug) values ($1, 'Pod admin', 'pod-admin')`,
    [POD_ADMIN_WS]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'admin')`,
    [randomUUID(), POD_ADMIN_WS, ADMIN]
  );
}, 120_000);

beforeEach(async () => {
  await q(`delete from api_keys`);
  h.audits.length = 0;
});

describe("agentUsers.disconnect", () => {
  it("the OWNER disconnects: every live key (active AND pending) is revoked in the table; other agents untouched", async () => {
    const active = await key(AGENT, true);
    const pending = await key(AGENT, false);
    const other = await key(OTHER_AGENT, true);

    const res = await caller(OWNER).disconnect({ agentUserId: AGENT });

    expect(res).toEqual({ revokedCount: 2 });
    for (const id of [active, pending]) {
      const row = await keyRow(id);
      expect(row.is_active).toBe(false);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_by).toBe(OWNER);
    }
    expect((await keyRow(other)).revoked_at).toBeNull();
    // The agent stays: disconnect is not remove.
    const agent = await q(`select id from users where id = $1`, [AGENT]);
    expect(agent.rows).toHaveLength(1);
    // Activity: one event, subject = the agent.
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      subjectId: AGENT,
      userId: OWNER,
      data: expect.objectContaining({ revokedCount: 2, disconnected: true }),
    });
  });

  it("a pod admin may disconnect someone else's agent", async () => {
    const k = await key(AGENT, true);
    expect(await caller(ADMIN).disconnect({ agentUserId: AGENT })).toEqual({
      revokedCount: 1,
    });
    expect((await keyRow(k)).revoked_at).not.toBeNull();
  });

  it("a non-owner, non-admin is refused and NOTHING is revoked", async () => {
    const k = await key(AGENT, true);
    await expect(
      caller(STRANGER).disconnect({ agentUserId: AGENT })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await keyRow(k)).revoked_at).toBeNull();
    expect(h.audits).toHaveLength(0);
  });

  it("an AGENT key is refused — even the owner's own agent acting for them", async () => {
    const k = await key(AGENT, true);
    await expect(
      caller(OWNER, OTHER_AGENT).disconnect({ agentUserId: AGENT })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await keyRow(k)).revoked_at).toBeNull();
  });

  it("an already-revoked key is not re-stamped; an unknown agent is NOT_FOUND", async () => {
    await q(
      `insert into api_keys (id, user_id, is_active, revoked_at, revoked_by) values ($1, $2, false, now() - interval '1 day', 'earlier')`,
      [randomUUID(), AGENT]
    );
    expect(await caller(OWNER).disconnect({ agentUserId: AGENT })).toEqual({
      revokedCount: 0,
    });
    await expect(
      caller(OWNER).disconnect({ agentUserId: randomUUID() })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("agentUsers.list — built-in agents are marked, from created_via (never a name)", () => {
  it("system / intelligence-service / twin rows carry builtIn:true; cli and ui do not", async () => {
    const rows = [
      ["b-sys", "system", false],
      ["b-is", "intelligence-service", false],
      ["b-twin", null, true],
      ["byoa-cli", "cli", false],
      ["byoa-ui", "ui", false],
      ["legacy", null, false],
    ] as const;
    const ids = new Map<string, string>();
    for (const [name, via, personal] of rows) {
      const id = randomUUID();
      ids.set(name, id);
      await q(
        `insert into users (id, email, name, user_type, created_via, is_personal_agent) values ($1, $2, $3, 'agent', $4, $5)`,
        [id, `${name}@x`, name, via, personal]
      );
    }
    const listed = await caller(OWNER).list({ workspaceId: null });
    const byId = new Map(
      (
        listed as Array<{ id: string; builtIn: boolean; origin: string | null }>
      ).map((r) => [r.id, r])
    );
    // Non-vacuity: every seeded agent reached the wire.
    for (const id of ids.values()) expect(byId.has(id), id).toBe(true);
    expect(byId.get(ids.get("b-sys")!)).toMatchObject({
      builtIn: true,
      origin: "system",
    });
    expect(byId.get(ids.get("b-is")!)).toMatchObject({
      builtIn: true,
      origin: "intelligence-service",
    });
    expect(byId.get(ids.get("b-twin")!)).toMatchObject({
      builtIn: true,
      origin: null,
    });
    expect(byId.get(ids.get("byoa-cli")!)).toMatchObject({
      builtIn: false,
      origin: "cli",
    });
    expect(byId.get(ids.get("byoa-ui")!)).toMatchObject({
      builtIn: false,
      origin: "ui",
    });
    expect(byId.get(ids.get("legacy")!)).toMatchObject({
      builtIn: false,
      origin: null,
    });
  });
});

/** A HUB key (the only kind presence reads), optionally revoked. */
async function hubKey(userId: string, state: "active" | "pending" | "revoked") {
  const id = randomUUID();
  await q(
    `insert into api_keys (id, user_id, key_type, is_active, revoked_at) values ($1, $2, 'hub_inbound', $3, ${state === "revoked" ? "now()" : "null"})`,
    [id, userId, state === "active"]
  );
  return id;
}
type ListRow = {
  id: string;
  builtIn: boolean;
  viewerCanDisconnect: boolean;
  approveUrl: string | null;
  pendingKeyIds?: unknown;
};
const listed = async (userId: string) =>
  new Map(
    ((await caller(userId).list({ workspaceId: [] })) as ListRow[]).map((r) => [
      r.id,
      r,
    ])
  );

describe("agentUsers.list — built-in needs a pod origin AND no key ever (W4 A2)", () => {
  it("an IS agent that holds a hub key is listed, not folded as built-in", async () => {
    const keyed = randomUUID();
    const keyless = randomUUID();
    const cut = randomUUID();
    for (const id of [keyed, keyless, cut])
      await q(
        `insert into users (id, email, name, user_type, created_via, is_personal_agent) values ($1, $2, 'IS', 'agent', 'intelligence-service', false)`,
        [id, `${id}@x`]
      );
    await hubKey(keyed, "active");
    await hubKey(cut, "revoked");
    const byId = await listed(OWNER);
    expect(byId.get(keyed)).toMatchObject({ builtIn: false });
    expect(byId.get(cut)).toMatchObject({ builtIn: false });
    expect(byId.get(keyless)).toMatchObject({ builtIn: true });
  });
});

describe("agentUsers.list — viewer verbs (W4 A4)", () => {
  const prevUrl = process.env.PUBLIC_URL;
  beforeEach(() => {
    process.env.PUBLIC_URL = "https://pod.example.synap.live";
  });
  afterEach(() => {
    if (prevUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = prevUrl;
  });

  it("Disconnect + Approve are offered to the owner and a pod admin, never a stranger", async () => {
    const pending = await hubKey(AGENT, "pending");
    const owner = (await listed(OWNER)).get(AGENT)!;
    expect(owner).toMatchObject({
      viewerCanDisconnect: true,
      approveUrl: `https://pod-admin.example.synap.live/approve-agents?keys=${pending}`,
    });
    // The key ids stay server-side: the URL is the door.
    expect(owner.pendingKeyIds).toBeUndefined();
    expect((await listed(ADMIN)).get(AGENT)).toMatchObject({
      viewerCanDisconnect: true,
    });
    expect((await listed(STRANGER)).get(AGENT)).toMatchObject({
      viewerCanDisconnect: false,
      approveUrl: null,
    });
  });

  it("no pending key ⇒ no approve door", async () => {
    await hubKey(AGENT, "active");
    expect((await listed(OWNER)).get(AGENT)?.approveUrl).toBeNull();
  });
});

describe("agentUsers.list — the floor is one row per agent (W4 A1)", () => {
  it("an agent in two of the caller's workspaces is ONE row", async () => {
    const [w1, w2, agent] = [randomUUID(), randomUUID(), randomUUID()];
    await q(`insert into workspaces (id, name) values ($1, 'W1'), ($2, 'W2')`, [
      w1,
      w2,
    ]);
    await q(
      `insert into users (id, email, name, user_type, created_by_user_id) values ($1, $2, 'Two-space agent', 'agent', $3)`,
      [agent, `${agent}@x`, OWNER]
    );
    for (const [ws, user, role] of [
      [w1, OWNER, "owner"],
      [w2, OWNER, "owner"],
      [w1, agent, "editor"],
      [w2, agent, "editor"],
    ])
      await q(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
        [randomUUID(), ws, user, role]
      );
    const rows = (await caller(OWNER).list({ workspaceId: [] })) as ListRow[];
    expect(rows.filter((r) => r.id === agent)).toHaveLength(1);
  });
});

describe("agentUsers.disconnect — a revoked key stops validating NOW (W4 A3)", () => {
  it("clears the verification cache AFTER the keys are revoked", async () => {
    const k = await hubKey(AGENT, "active");
    // The spy reads the key row AT THE MOMENT the cache is cleared (PGlite runs
    // queries in order): cleared before the UPDATE would see it unrevoked.
    let atClear: Promise<{ revoked_at: string | null }> | null = null;
    const spy = vi
      .spyOn(apiKeyService, "invalidateVerificationCache")
      .mockImplementation(() => {
        atClear = keyRow(k);
      });
    await caller(OWNER).disconnect({ agentUserId: AGENT });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(atClear).not.toBeNull();
    expect((await atClear!).revoked_at).not.toBeNull();
    spy.mockRestore();
  });
});
