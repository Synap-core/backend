/**
 * The Hub REST cell doors go through the governance gate (Surfaces P0-fix):
 * `POST /cells/install` and `DELETE /cells/:typeKey` wrote with no gate, and
 * the delete with no `workspaceId` retired a POD-WIDE cell type with no access
 * check at all.
 *
 * Driven through the REAL routes (key auth simulated as the hub auth door does
 * it: `runWithGrant` + `runWithActingAgent`), the REAL
 * `checkPermissionOrPropose`, the REAL access floors (`canWrite`,
 * `isPodAdmin`) and the REAL approve executors, on PGlite with every
 * @synap/database table. Faked: the Control Plane marketplace (`fetch`), the
 * signed-index admission, the realtime event.
 *
 * Rows, each ruling out a wrong outcome:
 *  - an agent's retire of a pod-wide cell → 202 proposed, the cell still
 *    active (rules out "an agent key retires directly"); with the AI preset
 *    grant too (rules out "the new door is refused by every agent key");
 *  - a person who is not a pod admin retiring a pod-wide cell → 403, still
 *    active (rules out "no access check on the pod-wide row");
 *  - approving the agent's retire as a non-admin → refused, still active;
 *    as a pod admin → retired once;
 *  - a pod admin retires a pod-wide cell directly, no proposal;
 *  - a retire of a cell that does not exist → 404, no proposal;
 *  - an agent's install → 202 proposed, nothing fetched, nothing written;
 *    approving it installs the cell in the reviewed space; a person installs
 *    directly;
 *  - TRUST (Surfaces P6a): both person-approved installs stamp
 *    `trust_level = 'installed'` (rules out "nothing writes installed", so an
 *    installed cell's writes would still propose); an agent's define,
 *    approved, stays `generated` and keeps its declared reads (rules out "an
 *    approval of agent code makes it trusted"); a later non-install write
 *    over an installed row demotes it to `generated`.
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
import { defineCell } from "../../../services/cells/define-cell.js";
import type { HubHono, HubVariables } from "./_shared.js";

const ADMIN = randomUUID(); // pod admin, owner of WS
const MEMBER = randomUUID(); // editor in WS, not a pod admin
const AGENT = randomUUID(); // MEMBER's agent
const ADMIN_AGENT = randomUUID(); // ADMIN's agent
const POD_ADMIN_WS = randomUUID();
const WS = randomUUID();

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
    body?: unknown;
  }
) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", opts.asUser);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (opts.agentUserId) c.set("agentUserId", opts.agentUserId);
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

async function seedCell(typeKey: string, workspaceId: string | null) {
  await q(
    `insert into widget_definitions (type_key, workspace_id, name, renderer_type, renderer_source, is_active)
     values ($1, $2, $1, 'frame', 'export default () => null', true)`,
    [typeKey, workspaceId]
  );
}
const trustOf = async (typeKey: string, workspaceId: string | null) =>
  (
    await q<{ trust_level: string }>(
      `select trust_level from widget_definitions where type_key = $1 and workspace_id is not distinct from $2`,
      [typeKey, workspaceId]
    )
  ).rows[0]?.trust_level;
const isActive = async (typeKey: string, workspaceId: string | null) =>
  (
    await q<{ is_active: boolean }>(
      `select is_active from widget_definitions where type_key = $1 and workspace_id is not distinct from $2`,
      [typeKey, workspaceId]
    )
  ).rows[0]?.is_active;

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  // The DDL helper creates no indexes: defineCell's upsert needs its unique
  // (type_key, workspace_id) index to resolve ON CONFLICT.
  await h.client!.exec(
    `create unique index widget_def_type_key_workspace_uniq on widget_definitions (type_key, workspace_id)`
  );
  await q(
    `insert into users (id, email, user_type) values ($1, $2, 'human'), ($3, $4, 'human')`,
    [ADMIN, "admin-cg@x.test", MEMBER, "member-cg@x.test"]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, 'agent', $3), ($4, $5, 'agent', $6)`,
    [
      AGENT,
      "agent-cg@x.test",
      MEMBER,
      ADMIN_AGENT,
      "admin-agent-cg@x.test",
      ADMIN,
    ]
  );
  await q(
    `insert into workspaces (id, owner_id, name, system_slug) values ($1, $2, 'Pod admin', 'pod-admin'), ($3, $2, 'Space', null)`,
    [POD_ADMIN_WS, ADMIN, WS]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       (gen_random_uuid(), $1, $2, 'owner'),
       (gen_random_uuid(), $3, $2, 'owner'),
       (gen_random_uuid(), $3, $4, 'editor')`,
    [POD_ADMIN_WS, ADMIN, WS, MEMBER]
  );
  proposalExecRegistry._reset();
  registerCellExecutors();
}, 120_000);

describe("DELETE /cells/:typeKey — a pod-wide cell type", () => {
  it("an agent: 202 proposed, the cell still active", async () => {
    await seedCell("cell:pkg:pod-wide", null);
    const res = await call("DELETE", "/cells/cell:pkg:pod-wide", {
      asUser: ADMIN,
      agentUserId: ADMIN_AGENT,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "proposed",
      proposalId: expect.any(String),
    });
    const rows = await proposalsFor("retire");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.proposalId,
      status: "pending",
      agent_user_id: ADMIN_AGENT,
      workspace_id: null,
    });
    expect(await isActive("cell:pkg:pod-wide", null)).toBe(true);
  });

  it("an agent on the AI preset grant: also 202 proposed (the grant folds retire onto define)", async () => {
    const before = (await proposalsFor("retire")).length;
    await seedCell("cell:pkg:pod-wide-2", null);
    const res = await call("DELETE", "/cells/cell:pkg:pod-wide-2", {
      asUser: ADMIN,
      agentUserId: ADMIN_AGENT,
      grant: AI_PRESET,
    });
    expect(res.status).toBe(202);
    expect((await proposalsFor("retire")).length).toBe(before + 1);
    expect(await isActive("cell:pkg:pod-wide-2", null)).toBe(true);
  });

  it("a person who is not a pod admin: 403, still active, no proposal", async () => {
    const before = (await proposalsFor("retire")).length;
    const res = await call("DELETE", "/cells/cell:pkg:pod-wide", {
      asUser: MEMBER,
    });
    expect(res.status).toBe(403);
    expect(await isActive("cell:pkg:pod-wide", null)).toBe(true);
    expect((await proposalsFor("retire")).length).toBe(before);
  });

  it("that person's agent: 403 too (the floor holds the person behind the key)", async () => {
    const res = await call("DELETE", "/cells/cell:pkg:pod-wide", {
      asUser: MEMBER,
      agentUserId: AGENT,
    });
    expect(res.status).toBe(403);
    expect(await isActive("cell:pkg:pod-wide", null)).toBe(true);
  });

  it("approving the agent's retire as a non-admin: refused, still active", async () => {
    const [row] = await proposalsFor("retire");
    await expect(approve("cell/retire", row!, MEMBER)).rejects.toThrow(
      /pod admin/
    );
    expect(await isActive("cell:pkg:pod-wide", null)).toBe(true);
  });

  it("approving it as a pod admin: retired once; a second approval does nothing", async () => {
    const [row] = await proposalsFor("retire");
    await approve("cell/retire", row!, ADMIN);
    expect(await isActive("cell:pkg:pod-wide", null)).toBe(false);
    const [after] = await proposalsFor("retire");
    expect(after!.status).toBe("approved");
    expect(await approve("cell/retire", after!, ADMIN)).toMatchObject({
      alreadyApproved: true,
    });
  });

  it("a pod admin: retired directly, no proposal", async () => {
    const before = (await proposalsFor("retire")).length;
    await seedCell("cell:pkg:pod-wide-3", null);
    const res = await call("DELETE", "/cells/cell:pkg:pod-wide-3", {
      asUser: ADMIN,
    });
    expect(res.status).toBe(200);
    expect(await isActive("cell:pkg:pod-wide-3", null)).toBe(false);
    expect((await proposalsFor("retire")).length).toBe(before);
  });

  it("a cell that does not exist: 404, no proposal", async () => {
    const before = (await proposalsFor("retire")).length;
    const res = await call("DELETE", "/cells/cell:pkg:nope", {
      asUser: ADMIN,
      agentUserId: ADMIN_AGENT,
    });
    expect(res.status).toBe(404);
    expect((await proposalsFor("retire")).length).toBe(before);
  });
});

describe("DELETE /cells/:typeKey?workspaceId — a space's cell type", () => {
  it("an agent of a member who can write there: 202 proposed, still active", async () => {
    await seedCell("cell:pkg:in-space", WS);
    const res = await call(
      "DELETE",
      `/cells/cell:pkg:in-space?workspaceId=${WS}`,
      { asUser: MEMBER, agentUserId: AGENT }
    );
    expect(res.status).toBe(202);
    expect(await isActive("cell:pkg:in-space", WS)).toBe(true);
  });

  it("the member themself: retired directly", async () => {
    const res = await call(
      "DELETE",
      `/cells/cell:pkg:in-space?workspaceId=${WS}`,
      { asUser: MEMBER }
    );
    expect(res.status).toBe(200);
    expect(await isActive("cell:pkg:in-space", WS)).toBe(false);
  });
});

describe("POST /cells/install — an agent's install is a proposal", () => {
  const body = { packageSlug: "pkg", cellKey: "gauge", workspaceId: WS };

  beforeAll(() => {
    process.env.CONTROL_PLANE_URL = "https://cp.example.test";
    vi.stubGlobal("fetch", async (url: string) => {
      // Only the marketplace counts: the realtime bridge posts here too.
      if (!String(url).startsWith("https://cp.example.test/")) {
        return new Response("{}", { status: 200 });
      }
      h.fetches.push(String(url));
      return new Response(
        JSON.stringify({
          cells: [
            {
              key: "pkg:gauge",
              name: "Gauge",
              code: "export default () => null",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
  });

  it("an agent: 202 proposed, nothing fetched, nothing written", async () => {
    const res = await call("POST", "/cells/install", {
      asUser: MEMBER,
      agentUserId: AGENT,
      grant: AI_PRESET,
      body,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "proposed" });
    const rows = await proposalsFor("install");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending",
      agent_user_id: AGENT,
      workspace_id: WS,
    });
    expect(h.fetches).toEqual([]);
    expect(await isActive("cell:pkg:gauge", WS)).toBeUndefined();
  });

  it("approving it as the member: installed in the reviewed space", async () => {
    const [row] = await proposalsFor("install");
    await approve("cell/install", row!, MEMBER);
    expect(await isActive("cell:pkg:gauge", WS)).toBe(true);
    // A person approved installing it: its frame's writes are trusted.
    expect(await trustOf("cell:pkg:gauge", WS)).toBe("installed");
    expect(h.fetches).toHaveLength(1);
    const [after] = await proposalsFor("install");
    expect(after!.status).toBe("approved");
  });

  it("a person: installed directly, no proposal", async () => {
    const before = (await proposalsFor("install")).length;
    await q(`delete from widget_definitions where type_key = 'cell:pkg:gauge'`);
    const res = await call("POST", "/cells/install", {
      asUser: MEMBER,
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      typeKey: "cell:pkg:gauge",
    });
    expect(await isActive("cell:pkg:gauge", WS)).toBe(true);
    expect(await trustOf("cell:pkg:gauge", WS)).toBe("installed");
    expect((await proposalsFor("install")).length).toBe(before);
  });
});

describe("trust: only a person's install stamps installed", () => {
  const reads = [{ op: "entities.list", params: { profileSlug: "deal" } }];

  it("an agent's define, approved, stays generated and keeps its declared reads", async () => {
    const res = await call("POST", "/cells/define", {
      asUser: MEMBER,
      agentUserId: AGENT,
      grant: AI_PRESET,
      body: {
        name: "Agent gauge",
        rendererSource: "export default () => null",
        workspaceId: WS,
        reads,
      },
    });
    expect(res.status).toBe(202);
    const rows = await proposalsFor("define");
    expect(rows).toHaveLength(1);
    await approve("cell/define", rows[0]!, MEMBER);
    const { rows: cell } = await q<{ trust_level: string; reads: unknown }>(
      `select trust_level, reads from widget_definitions where type_key = 'generated:agent-gauge' and workspace_id = $1`,
      [WS]
    );
    expect(cell[0]).toEqual({ trust_level: "generated", reads });
  });

  it("a declaration outside the ceiling is refused before anything is filed", async () => {
    const before = (await proposalsFor("define")).length;
    const res = await call("POST", "/cells/define", {
      asUser: MEMBER,
      agentUserId: AGENT,
      grant: AI_PRESET,
      body: {
        name: "Greedy gauge",
        rendererSource: "export default () => null",
        workspaceId: WS,
        reads: [{ op: "users.list" }],
      },
    });
    expect(res.status).toBe(400);
    expect((await proposalsFor("define")).length).toBe(before);
  });

  it("a write over an installed row by another door demotes it to generated", async () => {
    expect(await trustOf("cell:pkg:gauge", WS)).toBe("installed");
    await defineCell({
      name: "Gauge",
      rendererSource: "export default () => null; // v2",
      typeKey: "cell:pkg:gauge",
      workspaceId: WS,
      userId: MEMBER,
    });
    expect(await trustOf("cell:pkg:gauge", WS)).toBe("generated");
  });
});
