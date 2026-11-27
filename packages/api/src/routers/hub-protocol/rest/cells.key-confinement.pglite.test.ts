/**
 * The Hub REST cell writes judge the calling KEY, and a pod-wide cell needs a
 * pod admin (surfaces review H3 and M1, 27 Nov 2026).
 *
 * Driven through the REAL routes (key auth simulated as the hub auth door
 * sets it: `keyWorkspaceId`, `runWithGrant`, `runWithActingAgent`), the REAL
 * gate, floors and `cell/define` approve executor, on PGlite with every
 * @synap/database table.
 *
 * Rows, each ruling out a wrong outcome:
 *  - H3: a key bound to space WS, whose person writes in WS2 too, defining,
 *    installing or retiring a cell in WS2: 403, nothing written or filed
 *    (rules out "the person's floor is the only check"); defining or retiring
 *    POD-WIDE (no workspaceId): 403 (rules out "pod-wide escapes the
 *    binding"); defining in its own space: 201 (rules out "every bound key is
 *    refused");
 *  - M1: a member who is not a pod admin defining a pod-wide cell: 403,
 *    nothing written (rules out "define is laxer than retire"); their agent:
 *    403 before anything is filed; a pod admin: 201; a pod admin's agent's
 *    pod-wide define approved by a non-admin: refused, nothing written; by
 *    the pod admin: defined.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    fetches: [] as string[],
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        // PGlite is ONE connection: run a transaction body on the same handle.
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  const db = await h.init();
  return { ...actual, db, getDb: async () => db, eventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => randomUUID() }),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock(
  "../../../services/capabilities/official-catalog-trust.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    admitOfficialDefinition: vi.fn(async () => ({ admitted: true })),
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import {
  grantOfScope,
  runWithActingAgent,
  runWithGrant,
  type KeyGrant,
} from "@synap/database";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import {
  proposalExecRegistry,
  type ProposalExecutorArgs,
} from "../../proposals/execution-registry.js";
import { registerCellExecutors } from "../../proposals/executors/cell.js";
import { registerCellsRoutes } from "./cells.js";
import type { HubHono, HubVariables } from "./_shared.js";

const ADMIN = randomUUID(); // pod admin, owner of WS
const MEMBER = randomUUID(); // editor in WS, not a pod admin
const AGENT = randomUUID(); // MEMBER's agent
const ADMIN_AGENT = randomUUID(); // ADMIN's agent
const POD_ADMIN_WS = randomUUID();
const WS = randomUUID();
const WS2 = randomUUID(); // MEMBER writes here too: a key bound to WS must not

/** The AI preset every new agent starts with. */
const AI_PRESET: KeyGrant = grantOfScope({
  permissions: [
    ...GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!.grant
      .permissions,
  ],
});

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** One call, as the hub auth door runs it for a key (or a session). */
function call(
  method: string,
  path: string,
  opts: {
    asUser: string;
    grant?: KeyGrant;
    agentUserId?: string;
    /** What the hub auth door sets for a key bound to one space. */
    keyWorkspaceId?: string;
    body?: unknown;
  }
) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", opts.asUser);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (opts.agentUserId) c.set("agentUserId", opts.agentUserId);
    if (opts.keyWorkspaceId) c.set("keyWorkspaceId", opts.keyWorkspaceId);
    await runWithActingAgent(opts.agentUserId, () =>
      opts.grant ? runWithGrant(opts.grant, () => next()) : next()
    );
  });
  registerCellsRoutes(app);
  return app.request(path, {
    method,
    ...(opts.body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(opts.body),
        }
      : {}),
  });
}

async function proposalsFor(action: string) {
  const { rows } = await q<Record<string, unknown>>(
    `select id, status, agent_user_id, target_type, target_id, proposal_type, workspace_id, data from proposals where target_type = 'cell' and proposal_type = $1 order by created_at`,
    [action]
  );
  return rows;
}

function approve(key: string, row: Record<string, unknown>, asUser: string) {
  const ex = proposalExecRegistry.resolveExact(key)!;
  return ex.execute({
    proposal: {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      proposalType: row.proposal_type,
      workspaceId: row.workspace_id ?? null,
      agentUserId: row.agent_user_id,
      sessionId: null,
      projectId: null,
      sourceMessageId: null,
      data: row.data,
    },
    payload: row.data,
    userId: asUser,
    input: { proposalId: row.id },
    ctx: {},
    deps: {
      reportProposalOutcome: () => {},
      emitProposalReviewed: () => {},
    },
  } as unknown as ProposalExecutorArgs);
}

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await h.client!.exec(
    `create unique index widget_def_type_key_workspace_uniq on widget_definitions (type_key, workspace_id)`
  );
  await q(
    `insert into users (id, email, user_type) values ($1, $2, 'human'), ($3, $4, 'human')`,
    [ADMIN, "admin-kc@x.test", MEMBER, "member-kc@x.test"]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, 'agent', $3), ($4, $5, 'agent', $6)`,
    [
      AGENT,
      "agent-kc@x.test",
      MEMBER,
      ADMIN_AGENT,
      "admin-agent-kc@x.test",
      ADMIN,
    ]
  );
  await q(
    `insert into workspaces (id, owner_id, name, system_slug) values ($1, $2, 'Pod admin', 'pod-admin'), ($3, $2, 'Space', null), ($4, $2, 'Space two', null)`,
    [POD_ADMIN_WS, ADMIN, WS, WS2]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       (gen_random_uuid(), $1, $2, 'owner'),
       (gen_random_uuid(), $3, $2, 'owner'),
       (gen_random_uuid(), $3, $4, 'editor'),
       (gen_random_uuid(), $5, $2, 'owner'),
       (gen_random_uuid(), $5, $4, 'editor')`,
    [POD_ADMIN_WS, ADMIN, WS, MEMBER, WS2]
  );
  proposalExecRegistry._reset();
  registerCellExecutors();
}, 120_000);

const SOURCE = "export default () => null";
const cellCount = async () =>
  (await q<{ n: number }>(`select count(*)::int as n from widget_definitions`))
    .rows[0]!.n;
const errorOf = async (res: Response) =>
  ((await res.json()) as { error?: string }).error ?? "";

describe("H3: a key bound to one space writes cells in that space only", () => {
  it("defining in another space its person writes in: 403, nothing written", async () => {
    const before = await cellCount();
    const res = await call("POST", "/cells/define", {
      asUser: MEMBER,
      keyWorkspaceId: WS,
      body: { name: "Off space", rendererSource: SOURCE, workspaceId: WS2 },
    });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain("confined to workspace");
    expect(await cellCount()).toBe(before);
  });

  it("defining pod-wide (no workspaceId): 403, nothing written", async () => {
    const before = await cellCount();
    const res = await call("POST", "/cells/define", {
      asUser: ADMIN,
      keyWorkspaceId: WS,
      body: { name: "Pod wide by key", rendererSource: SOURCE },
    });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain("pod-wide");
    expect(await cellCount()).toBe(before);
  });

  it("defining in its own space: 201", async () => {
    const res = await call("POST", "/cells/define", {
      asUser: MEMBER,
      keyWorkspaceId: WS,
      body: { name: "Own space", rendererSource: SOURCE, workspaceId: WS },
    });
    expect(res.status).toBe(201);
    const { rows } = await q(
      `select 1 from widget_definitions where type_key = 'generated:own-space' and workspace_id = $1`,
      [WS]
    );
    expect(rows).toHaveLength(1);
  });

  it("installing in another space: 403, nothing fetched, nothing filed", async () => {
    const proposalsBefore = (await proposalsFor("install")).length;
    const res = await call("POST", "/cells/install", {
      asUser: MEMBER,
      agentUserId: AGENT,
      keyWorkspaceId: WS,
      body: { packageSlug: "pkg", cellKey: "gauge", workspaceId: WS2 },
    });
    expect(res.status).toBe(403);
    expect(h.fetches).toEqual([]);
    expect((await proposalsFor("install")).length).toBe(proposalsBefore);
  });

  it("retiring in another space: 403, still active; pod-wide: 403, still active", async () => {
    await q(
      `insert into widget_definitions (type_key, workspace_id, name, renderer_type, renderer_source, is_active)
       values ('cell:pkg:ws2', $1, 'ws2', 'frame', $2, true), ('cell:pkg:podw', null, 'podw', 'frame', $2, true)`,
      [WS2, SOURCE]
    );
    const other = await call(
      "DELETE",
      `/cells/cell:pkg:ws2?workspaceId=${WS2}`,
      {
        asUser: MEMBER,
        keyWorkspaceId: WS,
      }
    );
    expect(other.status).toBe(403);
    const podWide = await call("DELETE", "/cells/cell:pkg:podw", {
      asUser: ADMIN,
      keyWorkspaceId: WS,
    });
    expect(podWide.status).toBe(403);
    const { rows } = await q<{ is_active: boolean }>(
      `select is_active from widget_definitions where type_key in ('cell:pkg:ws2', 'cell:pkg:podw')`
    );
    expect(rows.map((r) => r.is_active)).toEqual([true, true]);
  });
});

describe("M1: a pod-wide cell is defined by a pod admin only", () => {
  it("a member who is not a pod admin: 403, nothing written", async () => {
    const before = await cellCount();
    const res = await call("POST", "/cells/define", {
      asUser: MEMBER,
      body: { name: "Member pod wide", rendererSource: SOURCE },
    });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain("pod admin");
    expect(await cellCount()).toBe(before);
  });

  it("their agent: 403 before anything is filed", async () => {
    const before = (await proposalsFor("define")).length;
    const res = await call("POST", "/cells/define", {
      asUser: MEMBER,
      agentUserId: AGENT,
      grant: AI_PRESET,
      body: { name: "Agent pod wide", rendererSource: SOURCE },
    });
    expect(res.status).toBe(403);
    expect((await proposalsFor("define")).length).toBe(before);
  });

  it("a pod admin: 201, pod-wide", async () => {
    const res = await call("POST", "/cells/define", {
      asUser: ADMIN,
      body: { name: "Admin pod wide", rendererSource: SOURCE },
    });
    expect(res.status).toBe(201);
    const { rows } = await q(
      `select 1 from widget_definitions where type_key = 'generated:admin-pod-wide' and workspace_id is null`
    );
    expect(rows).toHaveLength(1);
  });

  it("a pod admin's agent: proposed; approved by a non-admin, refused; by the pod admin, defined", async () => {
    const res = await call("POST", "/cells/define", {
      asUser: ADMIN,
      agentUserId: ADMIN_AGENT,
      grant: AI_PRESET,
      body: { name: "Approved pod wide", rendererSource: SOURCE },
    });
    expect(res.status).toBe(202);
    const row = (await proposalsFor("define")).find(
      (r) =>
        (r.data as { name?: string } | null)?.name === "Approved pod wide" ||
        JSON.stringify(r.data).includes("Approved pod wide")
    )!;
    expect(row).toBeDefined();
    await expect(approve("cell/define", row, MEMBER)).rejects.toThrow(
      /pod admin/
    );
    const look = `select 1 from widget_definitions where type_key = 'generated:approved-pod-wide' and workspace_id is null`;
    expect((await q(look)).rows).toHaveLength(0);
    await approve("cell/define", row, ADMIN);
    expect((await q(look)).rows).toHaveLength(1);
  });
});
