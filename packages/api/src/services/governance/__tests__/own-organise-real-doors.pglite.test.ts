/**
 * FB1020 B3 end to end, through the doors an agent and a person really use
 * (dogfood ea47d64e, 2026-10-23).
 *
 * MEASURED DEFECT: an agent's own fresh task — created through MCP, applied
 * on its receipt — could neither be filed into the project the person named
 * nor closed on its own: both proposed (`PROJECT_FILING`,
 * `LIFECYCLE_TERMINAL`), while the same move on its own session applied.
 * Every entity create emits TWO `entity.create.completed` rows: the door's
 * attributed log row and the repository's echo (`BaseRepository
 * .emitCompleted`), which named nobody, and "untouched by a person since"
 * (`isOwnFreshWork`) read that echo as a person's write. The earlier B3
 * suites hand-seeded only the attributed row, so none of them could see it.
 *
 * Driven here with nothing hand-seeded on the events spine: the REAL
 * `entities.create` (inside the agent key's request scope, as the key-auth
 * doors enter it), the REAL gate (`checkPermissionOrPropose`, its resolver,
 * engine and the seeded `@own-organise` row 0346b), the REAL filing door
 * (`fileEntitiesGoverned`), the REAL status door (`moveStatus`) and a person's
 * REAL edit door (`entities.update`). Both event writers land in PGlite: the
 * repository singleton (`eventRepository`) and the log writer (`auditLog`'s
 * fresh `EventRepository(sql)`).
 *
 * Rows that rule out a wrong rule:
 *  - own fresh task → filed and closed directly, each on an applied receipt
 *    (the defect: both proposed);
 *  - a person edits it in between → filing and closing propose (rules out
 *    "ignore every unnamed event": a person's edit must still count);
 *  - B3's "the named session's project": with NO project focus, naming a
 *    session whose project is the target files directly; the same filing with
 *    no session proposes (rules out a door that drops the session).
 *
 * Stubbed, and why: `getAgentFocusProjectId` (PGlite runs one connection and
 * the real read deadlocks inside the proposal transaction — same value the
 * reader would return); post-commit delivery only (side-effect fan-out,
 * lifecycle dispatch, realtime, notifications, identity signals, the AI
 * decision feed).
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
    focus: null as string | null,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        for (const m of ["query", "exec"] as const) {
          const orig = (client as any)[m].bind(client);
          (client as any)[m] = async (sql: string, ...rest: unknown[]) => {
            process.stderr.write(`[sql:${m}] ${String(sql).replace(/\s+/g, " ").slice(0, 160)}\n`);
            return orig(sql, ...rest);
          };
        }
        const origTx = (client as any).transaction.bind(client);
        (client as any).transaction = async (fn: any) => {
          process.stderr.write(`[sql:tx] BEGIN\n`);
          try { return await origTx(fn); } finally { process.stderr.write("[sql:tx] END\n"); }
        };
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
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
  // Both event writers speak `sql.unsafe(text, params)` (postgres.js); routed
  // onto PGlite so every row the doors write lands in `events`, where
  // `isOwnFreshWork` reads them.
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
    // The repository echo's writer — REAL, so the echo lands like in prod.
    eventRepository: new EventRepository(sql),
    sql,
    registerIdentitySignals: async () => undefined,
  };
});
vi.mock("../../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => {
    process.stderr.write(`[focus-mock] ${h.focus}\n`);
    return h.focus;
  },
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
  runWithActingAgent,
  runWithCallingKey,
  runWithDerivedSession,
} from "@synap/database";
import { entitiesRouter } from "../../../routers/entities.js";
import { fileEntitiesGoverned } from "../../projects/file-entities.js";
import { moveStatus } from "../../lifecycle/move-status.js";

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
const AGENT = randomUUID();
const KEY = randomUUID();
const TASK_PROFILE = randomUUID();
const STATUS_DEF = randomUUID();

/** The agent's work session — the one the MCP door derives for its writes. */
let WORK = "";

/**
 * Inside the agent key's request, as the key-auth doors enter it, with the
 * session the MCP door DERIVED (guessed, not named) for this conversation.
 * Every agent write carries a session, as on the live pod: without one the
 * gate mints a receipt session inside the proposal transaction, which reads
 * the module `db` and deadlocks PGlite's single connection (never Postgres).
 */
const asAgent = <T>(fn: () => Promise<T>, derived = WORK) =>
  runWithActingAgent(AGENT, () =>
    runWithCallingKey(KEY, () => runWithDerivedSession(derived, fn))
  );

const agentEntities = () =>
  entitiesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: USER,
    agentUserId: AGENT,
    workspaceId: null,
    sessionId: WORK,
  } as never);

const personEntities = () =>
  entitiesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: USER,
    workspaceId: null,
  } as never);

async function seedProject(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, 'Synap', 'active', now(), now())`,
    [id, USER]
  );
  return id;
}

/** An agent session bound to THIS key, in `projectId` (null = none). */
async function seedSession(projectId: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, project_id, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Probe', 'Probe the organise doors', 'active', 'agent', $3,
             '[]'::jsonb, '[]'::jsonb, $4::jsonb, '{}', now(), now(), now())`,
    [id, USER, projectId, JSON.stringify({ clientKey: `key:${KEY}` })]
  );
  return id;
}

/** The agent creates a task through the real create door. */
async function agentCreatesTask(): Promise<string> {
  const res = (await asAgent(() =>
    agentEntities().create({
      profileSlug: "task",
      title: `DOGFOOD probe task ${randomUUID().slice(0, 8)}`,
      properties: { status: "todo" },
      source: "agent",
      agentUserId: AGENT,
    } as never)
  )) as { status?: string; entity?: { id?: string } | null; id?: string };
  const id = res.entity?.id ?? res.id;
  // The create itself applies on its receipt (the precondition of B3).
  expect(res.status, JSON.stringify(res)).not.toBe("proposed");
  expect(id).toBeTruthy();
  return id!;
}

const fileAsAgent = (projectId: string, taskId: string) =>
  asAgent(() =>
    fileEntitiesGoverned({
      userId: USER,
      agentUserId: AGENT,
      projectId,
      entityIds: [taskId],
      sessionId: WORK,
    })
  );

const closeAsAgent = (taskId: string) =>
  asAgent(() =>
    moveStatus({
      entityId: taskId,
      to: "done",
      expectedFrom: "todo",
      actor: { kind: "agent", userId: USER, agentUserId: AGENT },
      sessionId: WORK,
    })
  );

const filedInto = async (projectId: string) =>
  (
    await q<{ source_entity_id: string }>(
      `select source_entity_id from relations where type = 'belongs_to_project' and target_entity_id = $1`,
      [projectId]
    )
  ).rows.map((r) => r.source_entity_id);

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(`select status from entities where id = $1`, [
      id,
    ])
  ).rows[0]?.status;

const pendingCount = async () =>
  (
    await q<{ n: number }>(
      `select count(*)::int as n from proposals where status = 'pending'`
    )
  ).rows[0]!.n;

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
  await q(
    `insert into users (id, name, email, user_type, agent_type, agent_metadata, created_by_user_id)
     values ($1, 'Claude Code', 'a@x', 'agent', 'claude-code', $2::jsonb, $3)`,
    [AGENT, JSON.stringify({ agentType: "claude-code" }), USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, created_at, updated_at)
     values ($1, 'task', 'Task', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now())`,
    [TASK_PROFILE]
  );
  await q(
    `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
     values ($1, 'status', 'enum', $2::jsonb, now(), now())`,
    [
      STATUS_DEF,
      JSON.stringify({
        enumOptions: [
          { key: "todo", label: "To do", category: "open" },
          { key: "done", label: "Done", category: "done" },
        ],
      }),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle)
     values ($1, $2, true)`,
    [TASK_PROFILE, STATUS_DEF]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from projects; delete from proposals; delete from governance_rules; delete from events; delete from entities; delete from relations; delete from focus_sessions;"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
  await h.client!.exec(migration("0346b_governance_own_organise_default.sql"));
  h.focus = null;
  WORK = await seedSession(null);
});

describe("ea47d64e: an agent organises its OWN fresh task through the real doors", () => {
  it.only("files it into the project the person named and closes it, nothing waiting", async () => {
    const taskId = await agentCreatesTask();
    // The person names the project AFTER the create (the live order:
    // create, then set_project_focus, then file).
    const projectId = await seedProject();
    h.focus = projectId;

    const dbg = await asAgent(async () => {
      const dbmod = await import("@synap/database");
      const { ownWorkOrganiseForFiling } = await import("../own-organise.js");
      const key = dbmod.getRequestApiKeyId();
      const agent = dbmod.getActingAgentUserId();
      const own = await dbmod.isOwnFreshWork(dbmod.db as never, {
        agentUserId: AGENT,
        apiKeyId: KEY,
        subjectType: "entity",
        subjectIds: [taskId],
      });
      const proof = await ownWorkOrganiseForFiling({
        agentUserId: AGENT,
        projectId,
        entityIds: [taskId],
        sessionId: WORK,
      });
      const ev = await q(`select type, is_agent, agent_user_id, proposal_id, source from events where subject_id = $1`, [taskId]);
      const pr = await q(`select id, status, api_key_id, proposal_type from proposals`);
      return { key, agent, own, proof, ev: ev.rows, pr: pr.rows };
    });
    process.stderr.write(`[DBG] ${JSON.stringify(dbg)}\n`);
    const filing = await fileAsAgent(projectId, taskId);
    expect(filing.status).toBe("filed");
    expect(await filedInto(projectId)).toEqual([taskId]);

    const close = await closeAsAgent(taskId);
    expect(close.status).toBe("moved");
    expect(await statusOf(taskId)).toBe("done");

    // Applied, each on its receipt; nothing waits for the person.
    expect(await pendingCount()).toBe(0);
    const receipts = await q<{ proposal_type: string }>(
      `select proposal_type from proposals where status = 'auto_approved'`
    );
    expect(receipts.rows.map((r) => r.proposal_type)).toEqual(
      expect.arrayContaining(["file_entities", "transition"])
    );
  });

  it("a person edits it in between: filing and closing propose, nothing written", async () => {
    const taskId = await agentCreatesTask();
    const projectId = await seedProject();
    h.focus = projectId;

    await personEntities().update({ id: taskId, title: "Mine now" });

    const filing = await fileAsAgent(projectId, taskId);
    expect(filing.status).toBe("proposed");
    expect(await filedInto(projectId)).toEqual([]);

    const close = await closeAsAgent(taskId);
    expect(close.status).toBe("proposed");
    expect(await statusOf(taskId)).toBe("todo");
  });
});

describe("ea47d64e: the project of the session the agent NAMES is a project the person named", () => {
  const projectsCaller = async (sessionId: string) => {
    const { projectsRouter } = await import("../../../routers/projects.js");
    return projectsRouter.createCaller({
      db: h.db,
      authenticated: true,
      userId: USER,
      agentUserId: AGENT,
      workspaceId: null,
      sessionId,
    } as never);
  };

  it("no focus, the agent NAMES a session in the project: filed directly through the tRPC/MCP door", async () => {
    const taskId = await agentCreatesTask();
    const projectId = await seedProject();
    const named = await seedSession(projectId);

    const res = await asAgent(async () =>
      (await projectsCaller(named)).fileEntities({
        projectId,
        entityIds: [taskId],
      })
    );
    expect(res.status).toBe("filed");
    expect(await filedInto(projectId)).toEqual([taskId]);
  });

  it("CONTROL: the SAME session, guessed by the door instead of named — the filing proposes", async () => {
    const taskId = await agentCreatesTask();
    const projectId = await seedProject();
    const guessed = await seedSession(projectId);

    const res = await asAgent(
      async () =>
        (await projectsCaller(guessed)).fileEntities({
          projectId,
          entityIds: [taskId],
        }),
      guessed
    );
    expect(res.status).toBe("proposed");
    expect(await filedInto(projectId)).toEqual([]);
  });
});
