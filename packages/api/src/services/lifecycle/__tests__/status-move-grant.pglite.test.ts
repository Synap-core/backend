/**
 * Founder decision 1 (2026-10-26, pod decision 452726d6): a status move is an
 * ordinary update. A key whose grant allows `update` on a record may move its
 * status — through the ONE status door, which still decides each move.
 *
 * Driven through the REAL doors on PGlite, inside the key's request scope as
 * the key-auth doors enter it (`runWithGrant` + the acting agent): `moveStatus`
 * and `entities.updateFacet` / `entities.update` / `entities.detachFacet`, the
 * REAL gate (`checkPermissionOrPropose`: grant rung 0, the agent ladder, the
 * pod default `@reversible` row 0282 and the `ask-first` posture written by
 * THE posture writer `applyAgentPosture`).
 *
 * Part 1 — a key whose grant has only `entity.task.update`:
 *  - a plain agent moves the status (main: refused, the grant named only
 *    `transition`);
 *  - an `ask-first` agent still gets a PROPOSAL (who may ask, not auto-approval);
 *  - a stale `expectedStatus` is still a CONFLICT, nothing written;
 *  - a `humanOnly` option still PROPOSES for an agent, and is applied for a
 *    person's own act;
 *  - a grant minted naming `entity.task.transition` keeps moving it; a read
 *    grant does not.
 *
 * Part 2 — role stages: writes follow the read reach (founder "option 1",
 * 2026-10-23). A key pinned to CRM, granted `facet.update` + `entity.person.update`
 * there, may move the `lead` stage of a POD-WIDE person (the lead role is
 * granted to CRM; its facet is stored pod-wide), and nothing else:
 *  - not the stage of a role granted elsewhere (`partner`, Marketing);
 *  - not the person's own (kind) fields;
 *  - not attach/detach (D2 kept: they re-share the person);
 *  - not a lead facet on a person stored in another space (rv-security B-1);
 *  - not with the same permissions pinned to Marketing instead.
 *
 * NOT COVERED: the hub HTTP door and the S7 tRPC fence (their own suites);
 * proposals' approval replay (entity-transition executor suite).
 *
 * Stubbed, and why (as own-organise-real-doors.pglite.test.ts): post-commit
 * delivery only, and `getAgentFocusProjectId` (PGlite is one connection).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
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
        // PGlite is ONE connection: a transaction reading the module `db`
        // deadlocks. Run the body on the same handle; atomicity is not under
        // test (as own-organise-real-doors.pglite.test.ts).
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
  await h.init();
  const sql = Object.assign(
    () => {
      throw new Error("tagged sql is not available in this suite");
    },
    {
      unsafe: async (text: string, params: unknown[] = []) =>
        (await h.client!.query(text, params)).rows,
    }
  );
  const EventRepository = actual.EventRepository as new (s: unknown) => {
    append: (e: unknown) => Promise<unknown>;
  };
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    eventRepository: new EventRepository(sql),
    sql,
    registerIdentitySignals: async () => undefined,
  };
});
vi.mock("../../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  dispatchLifecycleTransition: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: vi.fn(async () => undefined),
}));
vi.mock("../../focus-sessions/ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  applyAgentPosture,
  grantOfScope,
  runWithActingAgent,
  runWithCallingKey,
  runWithDerivedSession,
  runWithGrant,
} from "@synap/database";
import type { GrantScope } from "@synap/governance-policy/grants";
import { entitiesRouter } from "../../../routers/entities.js";
import { moveStatus } from "../move-status.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const migration = (f: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../../database/migrations/${f}`, import.meta.url)
    ),
    "utf-8"
  );

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const AGENT = randomUUID(); // no posture: the pod default decides
const ASK = randomUUID(); // the `ask-first` posture (an app's agent)
const KEY = randomUUID();
const CRM = randomUUID();
const MKT = randomUUID();
const TASK_PROFILE = randomUUID();
const PERSON_PROFILE = randomUUID();
const LEAD = randomUUID(); // role granted to CRM (its owning space)
const PARTNER = randomUUID(); // role granted to Marketing only
const STATUS_DEF = randomUUID();
const STAGE_DEF = randomUUID();
const SCORE_DEF = randomUUID();

let WORK = "";

/** Inside the key's request: its grant, its agent, its session. */
const asKey = <T>(scope: GrantScope, agent: string, fn: () => Promise<T>) =>
  runWithGrant(grantOfScope(scope), () =>
    runWithActingAgent(agent, () =>
      runWithCallingKey(KEY, () => runWithDerivedSession(WORK, fn))
    )
  );

const entitiesAs = (agent: string) =>
  entitiesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: USER,
    agentUserId: agent,
    workspaceId: null,
    sessionId: WORK,
  } as never);

const GRANT_DENIED = {
  code: "FORBIDDEN",
  message: expect.stringMatching(/grant does not allow/),
};

async function seedTask(status = "todo"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, status, status_category, properties, created_at, updated_at)
     values ($1, $2, 'task', $3, 'A task', null, $4, 'open', $5::jsonb, now(), now())`,
    [id, USER, TASK_PROFILE, status, JSON.stringify({ status })]
  );
  return id;
}

async function seedPerson(workspaceId: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, properties, created_at, updated_at)
     values ($1, $2, 'person', $3, 'Ada', $4, '{}'::jsonb, now(), now())`,
    [id, USER, PERSON_PROFILE, workspaceId]
  );
  return id;
}

/** A role facet, stored pod-wide (a shared role's facet always is). */
async function seedFacet(entityId: string, roleId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, status_category, properties, metadata, created_at, updated_at)
     values ($1, $2, $3, $4, null, 'new', 'open', '{"stage":"new"}'::jsonb, '{}'::jsonb, now(), now())`,
    [id, entityId, roleId, USER]
  );
  return id;
}

const taskStatus = async (id: string) =>
  (
    await q<{ status: string }>(`select status from entities where id = $1`, [
      id,
    ])
  ).rows[0]?.status;

const facetRow = async (id: string) =>
  (
    await q<{
      status: string;
      properties: Record<string, unknown>;
      deleted_at: unknown;
    }>(
      `select status, properties, deleted_at from entity_facets where id = $1`,
      [id]
    )
  ).rows[0];

const moveTask = (
  taskId: string,
  to: string,
  expectedFrom: string,
  agent = AGENT
) =>
  moveStatus({
    entityId: taskId,
    to,
    expectedFrom,
    actor: { kind: "agent", userId: USER, agentUserId: agent },
    sessionId: WORK,
  });

/** Part 1: unpinned, `update` on the kind only. */
const UPDATE_ONLY: GrantScope = {
  permissions: ["entity.task.read", "entity.task.update"],
};
/** Part 2: pinned to CRM, what a CRM app asks to work its leads. */
const CRM_KEY: GrantScope = {
  permissions: [
    "entity.person.read",
    "entity.person.update",
    "facet.read",
    "facet.update",
  ],
  workspaceIds: [CRM],
};

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one these doors read.
      }
    }
  }
  await q(
    `insert into users (id, name, email, user_type) values ($1, 'Founder', 'f@x', 'human')`,
    [USER]
  );
  for (const [id, email] of [
    [AGENT, "a@x"],
    [ASK, "ask@x"],
  ]) {
    await q(
      `insert into users (id, name, email, user_type, agent_type, agent_metadata, created_by_user_id)
       values ($1, 'Agent', $2, 'agent', 'claude-code', '{}'::jsonb, $3)`,
      [id, email, USER]
    );
  }
  for (const [ws, name] of [
    [CRM, "CRM"],
    [MKT, "Marketing"],
  ]) {
    await q(`insert into workspaces (id, owner_id, name) values ($1, $2, $3)`, [
      ws,
      USER,
      name,
    ]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
      [ws, USER]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, created_at, updated_at)
     values ($1, 'task', 'Task', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now()),
            ($2, 'person', 'Person', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now()),
            ($3, 'lead', 'Lead', 'role', 'shared', 'pod', $5, true, '{}'::jsonb, now(), now()),
            ($4, 'partner', 'Partner', 'role', 'shared', 'pod', $6, true, '{}'::jsonb, now(), now())`,
    [TASK_PROFILE, PERSON_PROFILE, LEAD, PARTNER, CRM, MKT]
  );
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'status', 'enum', $2::jsonb, now(), now()),
            ($3, 'stage', 'enum', $4::jsonb, now(), now()),
            ($5, 'score', 'number', '{}'::jsonb, now(), now())`,
    [
      STATUS_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "todo", label: "To do", category: "open" },
          { key: "doing", label: "Doing", category: "active" },
          // Not terminal: isolates the humanOnly floor from the done/lost one.
          {
            key: "signed_off",
            label: "Signed off",
            category: "active",
            humanOnly: true,
          },
          { key: "done", label: "Done", category: "done" },
        ],
      }),
      STAGE_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "new", label: "New", category: "open" },
          { key: "qualified", label: "Qualified", category: "active" },
          { key: "won", label: "Won", category: "done" },
        ],
      }),
      SCORE_DEF,
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle)
     values ($1, $2, true), ($3, $4, true), ($5, $4, true), ($3, $6, false)`,
    [TASK_PROFILE, STATUS_DEF, LEAD, STAGE_DEF, PARTNER, SCORE_DEF]
  );
  await applyAgentPosture({
    db: h.db as never,
    agentUserId: ASK,
    posture: "ask-first",
    createdBy: USER,
  });
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from proposals; delete from events; delete from focus_sessions; delete from governance_rules where target_pattern = '@reversible';"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
  WORK = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Work', 'Work the board', 'active', 'agent',
             '[]'::jsonb, '[]'::jsonb, $3::jsonb, '{}', now(), now(), now())`,
    [WORK, USER, JSON.stringify({ clientKey: `key:${KEY}` })]
  );
});

describe("Part 1 — a status move is an update (grant: entity.task.update only)", () => {
  it("a plain agent moves the status", async () => {
    const task = await seedTask();
    const res = await asKey(UPDATE_ONLY, AGENT, () =>
      moveTask(task, "doing", "todo")
    );
    expect(res.status, JSON.stringify(res)).toBe("moved");
    expect(await taskStatus(task)).toBe("doing");
  });

  it("an ask-first agent still gets a proposal, nothing written", async () => {
    const task = await seedTask();
    const res = await asKey(UPDATE_ONLY, ASK, () =>
      moveTask(task, "doing", "todo", ASK)
    );
    expect(res.status, JSON.stringify(res)).toBe("proposed");
    expect(await taskStatus(task)).toBe("todo");
  });

  it("a stale expectedStatus is still a conflict, nothing written", async () => {
    const task = await seedTask();
    const res = await asKey(UPDATE_ONLY, AGENT, () =>
      moveTask(task, "doing", "doing")
    );
    expect(res).toMatchObject({
      status: "conflict",
      expectedFrom: "doing",
      actual: "todo",
    });
    expect(await taskStatus(task)).toBe("todo");
  });

  it("a humanOnly option proposes for an agent; a person's own act applies it", async () => {
    const task = await seedTask();
    const res = await asKey(UPDATE_ONLY, AGENT, () =>
      moveTask(task, "signed_off", "todo")
    );
    expect(res.status, JSON.stringify(res)).toBe("proposed");
    expect(await taskStatus(task)).toBe("todo");

    const own = await moveStatus({
      entityId: task,
      to: "signed_off",
      expectedFrom: "todo",
      actor: { kind: "human", userId: USER },
    });
    expect(own.status, JSON.stringify(own)).toBe("moved");
    expect(await taskStatus(task)).toBe("signed_off");
  });

  it("a grant minted naming transition keeps moving it; a read grant does not", async () => {
    const task = await seedTask();
    const named = await asKey(
      { permissions: ["entity.task.read", "entity.task.transition"] },
      AGENT,
      () => moveTask(task, "doing", "todo")
    );
    expect(named.status, JSON.stringify(named)).toBe("moved");

    const readOnly = await asKey(
      { permissions: ["entity.task.read"] },
      AGENT,
      () => moveTask(task, "todo", "doing")
    );
    expect(readOnly).toMatchObject({
      status: "denied",
      reason: expect.stringMatching(
        /grant does not allow "entity\.task\.update"/
      ),
    });
    expect(await taskStatus(task)).toBe("doing");
  });
});

describe("Part 2 — a CRM key works the lead stage of a pod-wide person", () => {
  it("moves the lead stage (the role is granted to CRM)", async () => {
    const person = await seedPerson(null);
    const lead = await seedFacet(person, LEAD);
    const res = await asKey(CRM_KEY, AGENT, () =>
      entitiesAs(AGENT).updateFacet({
        facetId: lead,
        status: "qualified",
        expectedStatus: "new",
      } as never)
    );
    expect(res).toMatchObject({
      status: "updated",
      statusMove: { status: "moved" },
    });
    expect((await facetRow(lead))?.status).toBe("qualified");
  });

  it("updates the lead facet's own fields", async () => {
    const person = await seedPerson(null);
    const lead = await seedFacet(person, LEAD);
    const res = await asKey(CRM_KEY, AGENT, () =>
      entitiesAs(AGENT).updateFacet({
        facetId: lead,
        properties: { score: 7 },
      } as never)
    );
    expect(res.status, JSON.stringify(res)).toBe("updated");
    expect((await facetRow(lead))?.properties).toMatchObject({ score: 7 });
  });

  it("does not move the stage of a role granted elsewhere (partner, Marketing)", async () => {
    const person = await seedPerson(null);
    const partner = await seedFacet(person, PARTNER);
    await expect(
      asKey(CRM_KEY, AGENT, () =>
        entitiesAs(AGENT).updateFacet({
          facetId: partner,
          status: "qualified",
          expectedStatus: "new",
        } as never)
      )
    ).rejects.toMatchObject(GRANT_DENIED);
    expect((await facetRow(partner))?.status).toBe("new");
  });

  it("does not write the person's own fields (kind writes stay pod scope)", async () => {
    const person = await seedPerson(null);
    await seedFacet(person, LEAD);
    await expect(
      asKey(CRM_KEY, AGENT, () =>
        entitiesAs(AGENT).update({ id: person, title: "Renamed" } as never)
      )
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q<{ title: string }>(
      `select title from entities where id = $1`,
      [person]
    );
    expect(rows[0]?.title).toBe("Ada");
  });

  it("does not detach the lead role (attach/detach re-share the person: D2)", async () => {
    const person = await seedPerson(null);
    const lead = await seedFacet(person, LEAD);
    await expect(
      asKey(CRM_KEY, AGENT, () =>
        entitiesAs(AGENT).detachFacet({ facetId: lead } as never)
      )
    ).rejects.toMatchObject(GRANT_DENIED);
    expect((await facetRow(lead))?.deleted_at).toBeNull();
  });

  it("does not move a lead stage on a person stored in another space", async () => {
    const person = await seedPerson(MKT);
    const lead = await seedFacet(person, LEAD);
    await expect(
      asKey(CRM_KEY, AGENT, () =>
        entitiesAs(AGENT).updateFacet({
          facetId: lead,
          status: "qualified",
          expectedStatus: "new",
        } as never)
      )
    ).rejects.toMatchObject(GRANT_DENIED);
    expect((await facetRow(lead))?.status).toBe("new");
  });

  it("the same permissions pinned to Marketing do not move the lead stage", async () => {
    const person = await seedPerson(null);
    const lead = await seedFacet(person, LEAD);
    await expect(
      asKey({ ...CRM_KEY, workspaceIds: [MKT] }, AGENT, () =>
        entitiesAs(AGENT).updateFacet({
          facetId: lead,
          status: "qualified",
          expectedStatus: "new",
        } as never)
      )
    ).rejects.toMatchObject(GRANT_DENIED);
    expect((await facetRow(lead))?.status).toBe("new");
  });

  it("the status door's own request still needs update on the entity's kind", async () => {
    const person = await seedPerson(null);
    const lead = await seedFacet(person, LEAD);
    await expect(
      asKey(
        { ...CRM_KEY, permissions: ["entity.person.read", "facet.update"] },
        AGENT,
        () =>
          entitiesAs(AGENT).updateFacet({
            facetId: lead,
            status: "qualified",
            expectedStatus: "new",
          } as never)
      )
    ).rejects.toMatchObject(GRANT_DENIED);
    expect((await facetRow(lead))?.status).toBe("new");
  });
});
