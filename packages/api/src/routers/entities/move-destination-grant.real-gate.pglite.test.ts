/**
 * Moving records INTO a space is a write in that space (triage finding TF-1,
 * found on ticket 703be2c7): the key's grant, its workspace binding and the
 * acting agent's own access are checked on the DESTINATION, the same way the
 * gate checks them on the source. An agent is never a member: it moves where
 * its person may write, within its key's grant.
 *
 * Before the fix the gate ran on the source space alone, so a key pinned to
 * space A moved a record from A into any space its person can write.
 *
 * Driven through the one door MCP `synap_move_entities` and Hub
 * `POST /entities/move` share (`moveEntitiesDoor`) → tRPC
 * `entities.moveToWorkspace` → the REAL `checkPermissionOrPropose` (grant
 * rung, membership RBAC, agent ladder, the proposal insert), on PGlite with
 * every @synap/database table. The key's grant and acting agent are entered
 * as the key-auth doors enter them (`runWithGrant`, `runWithActingAgent`).
 * Only delivery side effects (event log, job queue, realtime, audit) are
 * stubbed.
 *
 * Rows, each ruling out a wrong outcome:
 *  - a key whose grant names only A cannot move a record from A into C (its
 *    person is an owner of both): refused, nothing moved, nothing filed;
 *  - a key BOUND to A cannot move into C, nor move a record of C into A:
 *    refused, nothing moved (a bound key moves nothing between spaces);
 *  - an agent whose person is not a member of E cannot move a record into E,
 *    though the agent holds a seat there: refused, nothing moved;
 *  - CONTROL: an agent under a grant naming A and C moves it (the checks
 *    admit what they should);
 *  - CONTROL: the person, signed in (no key, no agent), still moves it.
 *
 * Cannot see: production Postgres; the approval replay of the proposed move
 * (`entity/update` with `toWorkspaceId` replays `moveToWorkspace` as the
 * approver; `proposals/__tests__/workspace-ops-executors.test.ts`).
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
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        // PGlite is ONE connection: the proposal writer's transaction reads
        // through the global `db` while it holds that connection, which
        // deadlocks here. Run the body on the same handle; atomicity is not
        // under test (as entity.delete.real-gate.pglite.test.ts does).
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
      }
      return state.db;
    },
    // The gate's reads inside @synap/database import `db` from its client
    // module, not from the package entry: route that onto the same PGlite.
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

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // The event log appends over its own connection (no PGlite): a no-op here.
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
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  grantOfScope,
  runWithActingAgent,
  runWithGrant,
} from "@synap/database";
import {
  moveEntitiesDoor,
  type WorkspaceOpsActor,
} from "../../services/workspace-ops-doors.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
/** Spaces: the person owns A, B, C; E is not theirs, though the agent has a seat. */
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const E = randomUUID();
let NOTE_PROFILE = "";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function seedNote(title: string, workspaceId = A): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties)
     values ($1, $2, $3, $4, 'note', $5, '{}'::jsonb)`,
    [id, OWNER, workspaceId, NOTE_PROFILE, title]
  );
  return id;
}
const spaceOf = async (id: string) =>
  (
    await q<{ workspace_id: string | null }>(
      `select workspace_id from entities where id = $1`,
      [id]
    )
  ).rows[0]?.workspace_id;
const proposalsOn = async (id: string) =>
  (
    await q<{ status: string; agent_user_id: string | null; data: unknown }>(
      `select status, agent_user_id, data from proposals where target_id = $1`,
      [id]
    )
  ).rows;

const SCOPES = ["mcp.read", "mcp.write"];
const keyActor = (
  over: Partial<WorkspaceOpsActor> = {}
): WorkspaceOpsActor => ({
  userId: OWNER,
  scopes: SCOPES,
  ...over,
});
/** A key whose grant may edit every kind of record, in these spaces only. */
const grantIn = (...workspaceIds: string[]) =>
  grantOfScope({
    permissions: ["entity.*.read", "entity.*.create", "entity.*.update"],
    workspaceIds,
  });

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    OWNER,
    "owner@x.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type)
     values ($1, 'agent@x.test', 'agent', $2, 'claude-code')`,
    [AGENT, OWNER]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1, $2, 'owner')`,
    [randomUUID(), OWNER]
  );
  for (const [ws, name] of [
    [A, "Alpha"],
    [B, "Beta"],
    [C, "Gamma"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1, $2, $3, '{}'::jsonb)`,
      [ws, name, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'Epsilon', $2, '{}'::jsonb)`,
    [E, randomUUID()]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), E, AGENT]
  );
  const { rows } = await q<{ id: string }>(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints)
     values (gen_random_uuid(),'note','Note','kind','system','pod',null,true,'{}'::jsonb) returning id`
  );
  NOTE_PROFILE = rows[0]!.id;
}, 120_000);

describe("moving records into a space checks the destination (TF-1)", () => {
  it("SECURITY: a key whose grant names only A cannot move a record from A into C", async () => {
    const id = await seedNote("Pinned-key note");

    const out = await runWithGrant(grantIn(A), () =>
      moveEntitiesDoor(keyActor(), { entityIds: [id], workspaceId: C })
    );

    expect(out.moved).toEqual([]);
    expect(out.proposed).toEqual([]);
    expect(out.errors).toEqual([
      {
        entityId: id,
        error: expect.stringMatching(
          new RegExp(`grant does not allow .*in workspace ${C}`)
        ),
      },
    ]);
    expect(await spaceOf(id)).toBe(A);
    expect(await proposalsOn(id)).toEqual([]);
  });

  it("SECURITY: a key bound to A cannot move a record into C", async () => {
    const id = await seedNote("Bound-key note");

    await expect(
      moveEntitiesDoor(keyActor({ keyType: "user_pat", keyWorkspaceId: A }), {
        entityIds: [id],
        workspaceId: C,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/confined to workspace/),
    });
    expect(await spaceOf(id)).toBe(A);
  });

  it("SECURITY: a key bound to A cannot pull a record of C into A", async () => {
    const id = await seedNote("A note of Gamma", C);

    await expect(
      moveEntitiesDoor(keyActor({ keyType: "user_pat", keyWorkspaceId: A }), {
        entityIds: [id],
        workspaceId: A,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/every record it moves must be in it/),
    });
    expect(await spaceOf(id)).toBe(C);
  });

  it("SECURITY: an agent whose person is not a member of E cannot move a record into E, its own seat there counts for nothing", async () => {
    const id = await seedNote("Agent note");

    const move = runWithActingAgent(AGENT, () =>
      moveEntitiesDoor(keyActor({ agentUserId: AGENT }), {
        entityIds: [id],
        workspaceId: E,
      })
    );

    await expect(move).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await spaceOf(id)).toBe(A);
    expect(await proposalsOn(id)).toEqual([]);
  });

  it("CONTROL: an agent under a grant naming A and C moves the record", async () => {
    const id = await seedNote("Granted both ways");

    const out = await runWithGrant(grantIn(A, C), () =>
      runWithActingAgent(AGENT, () =>
        moveEntitiesDoor(keyActor({ agentUserId: AGENT }), {
          entityIds: [id],
          workspaceId: C,
        })
      )
    );

    expect(out).toEqual({ moved: [id], proposed: [], errors: [] });
    expect(await spaceOf(id)).toBe(C);
  });

  it("CONTROL: the person signed in (no key, no agent) still moves a record into B", async () => {
    const id = await seedNote("The person's own move");
    const { entitiesRouter } = await import("../entities.js");

    const caller = entitiesRouter.createCaller({
      db: await h.init(),
      authenticated: true,
      userId: OWNER,
      workspaceId: null,
    } as never);
    const out = await caller.moveToWorkspace({
      entityIds: [id],
      workspaceId: B,
    });

    expect(out).toEqual({ moved: [id], proposed: [], errors: [] });
    expect(await spaceOf(id)).toBe(B);
  });
});
