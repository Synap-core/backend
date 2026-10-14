/**
 * `focusSessions.list` / `browse` — the `subject` filter (surfaces W1.1), on
 * PGlite through the REAL router, so `sessionSubjectWhere` runs as real SQL
 * inside the ONE session WHERE.
 *
 * Fixture (all USER's, one workspace):
 *   lead L1, L2, deleted lead LX · note N1 · note C1 carrying the `client` role
 *   S_SUBJ     work session, subject L1
 *   S_WORKER   run session targeting L2 as a worker (`worker_target` link)
 *   S_TARGETS  session with a plain `targets` link to L1 (NOT a worker edge)
 *   S_NOTE     subject N1
 *   S_FACET    subject C1 (the client-role thing)
 *   S_GONE     subject LX (a deleted lead)
 *   S_NONE     no subject
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { is } = await import("drizzle-orm");
  const { PgTable } = await import("drizzle-orm/pg-core");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const tables = Object.entries(actual).filter(([, v]) => is(v, PgTable));
  h.tables = tables.map(([, v]) => v);
  const pg = drizzle(client, { schema: Object.fromEntries(tables) as never });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    getParentSessionIds: async () => new Map<string, string>(),
    getParentSessionId: async () => null,
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessionsRouter } from "./focus-sessions.js";

const USER = "user-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.primary && type === "uuid" ? " default gen_random_uuid()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const ago = (mins: number) =>
  new Date(Date.now() - mins * 60_000).toISOString();

const W1 = randomUUID();
const LEAD = randomUUID();
const NOTE = randomUUID();
const CLIENT = randomUUID();
const L1 = randomUUID();
const L2 = randomUUID();
const LX = randomUUID();
const N1 = randomUUID();
const C1 = randomUUID();
const S_SUBJ = randomUUID();
const S_WORKER = randomUUID();
const S_TARGETS = randomUUID();
const S_NOTE = randomUUID();
const S_FACET = randomUUID();
const S_GONE = randomUUID();
const S_NONE = randomUUID();

async function thing(id: string, profileId: string, deleted = false) {
  await q(
    `insert into entities (id, user_id, workspace_id, type, profile_id, title, properties, created_at, deleted_at)
     values ($1,$2,$3,'x',$4,'t','{}'::jsonb,now(),$5)`,
    [id, USER, W1, profileId, deleted ? new Date().toISOString() : null]
  );
}

async function session(
  id: string,
  o: { subject: string | null; run?: boolean; mins: number }
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, playbook_id, subject_entity_id, goal, status, expected_outputs, metadata, origin, created_at, started_at, updated_at)
     values ($1,$2,$3,$4,$5,'g','active','[]'::jsonb,$6::jsonb,$7,$8,$8,$8)`,
    [
      id,
      USER,
      W1,
      o.run ? randomUUID() : null,
      o.subject,
      JSON.stringify(o.run ? { automationId: randomUUID() } : {}),
      o.run ? "playbook" : "human",
      ago(o.mins),
    ]
  );
}

async function targets(sessionId: string, entityId: string, role?: string) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values (gen_random_uuid(),'session',$1,'entity',$2,'targets',$3::jsonb,now())`,
    [sessionId, entityId, JSON.stringify(role ? { role } : {})]
  );
}

const caller = () =>
  focusSessionsRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
  } as never);
const setOf = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id));

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(`insert into workspaces (id, name) values ($1,'Builder')`, [W1]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id) values ($1,$2,$3)`,
    [randomUUID(), W1, USER]
  );
  await q(
    `insert into users (id, name, email, user_type) values ($1,'Antoine','a@x.io','human')`,
    [USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values
      ($1,'lead','Lead','kind','workspace'),
      ($2,'note','Note','kind','workspace'),
      ($3,'client','Client','role','workspace')`,
    [LEAD, NOTE, CLIENT]
  );
  await thing(L1, LEAD);
  await thing(L2, LEAD);
  await thing(LX, LEAD, true);
  await thing(N1, NOTE);
  await thing(C1, NOTE);
  await q(
    `insert into entity_facets (id, entity_id, profile_id, created_at) values (gen_random_uuid(),$1,$2,now())`,
    [C1, CLIENT]
  );

  await session(S_SUBJ, { subject: L1, mins: 10 });
  await session(S_WORKER, { subject: null, run: true, mins: 9 });
  await targets(S_WORKER, L2, "worker_target");
  await session(S_TARGETS, { subject: null, mins: 8 });
  await targets(S_TARGETS, L1);
  await session(S_NOTE, { subject: N1, mins: 7 });
  await session(S_FACET, { subject: C1, mins: 6 });
  await session(S_GONE, { subject: LX, mins: 5 });
  await session(S_NONE, { subject: null, mins: 4 });
});

describe("focusSessions.list — subject", () => {
  it("a kind: sessions whose subject is one of its live things, plus the worker sessions targeting one", async () => {
    const rows = await caller().list({
      subject: { profileSlug: "lead" },
      kind: "all",
      limit: 50,
    });
    expect(setOf(rows)).toEqual(new Set([S_SUBJ, S_WORKER]));
    // Non-vacuity: unfiltered, every fixture session lists.
    expect(setOf(await caller().list({ kind: "all", limit: 50 }))).toEqual(
      new Set([S_SUBJ, S_WORKER, S_TARGETS, S_NOTE, S_FACET, S_GONE, S_NONE])
    );
  });

  it("the worker session is run-kind: the default work population leaves it out", async () => {
    const rows = await caller().list({
      subject: { profileSlug: "lead" },
      limit: 50,
    });
    expect(setOf(rows)).toEqual(new Set([S_SUBJ]));
  });

  it("a role: sessions on things that carry it (the board's rule), not on the thing's kind", async () => {
    const role = await caller().list({
      subject: { profileSlug: "client" },
      kind: "all",
      limit: 50,
    });
    expect(setOf(role)).toEqual(new Set([S_FACET]));
    const kind = await caller().list({
      subject: { profileSlug: "note" },
      kind: "all",
      limit: 50,
    });
    expect(setOf(kind)).toEqual(new Set([S_NOTE, S_FACET]));
  });

  it("entity ids: the subject anchor OR the worker edge — a plain `targets` link is not one", async () => {
    expect(
      setOf(
        await caller().list({
          subject: { entityIds: [L2] },
          kind: "all",
          limit: 50,
        })
      )
    ).toEqual(new Set([S_WORKER]));
    expect(
      setOf(
        await caller().list({
          subject: { entityIds: [L1] },
          kind: "all",
          limit: 50,
        })
      )
    ).toEqual(new Set([S_SUBJ]));
  });

  it("an unknown slug throws NOT_FOUND — never an empty list", async () => {
    await expect(
      caller().list({ subject: { profileSlug: "nope" }, kind: "all" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("browse reads the same predicate", async () => {
    const page = await caller().browse({
      subject: { profileSlug: "lead" },
      kind: "all",
    });
    expect(setOf(page.items)).toEqual(new Set([S_SUBJ, S_WORKER]));
  });
});
