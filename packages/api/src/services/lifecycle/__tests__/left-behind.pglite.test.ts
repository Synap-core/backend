/**
 * THINGS LEFT BEHIND (plan b38e5e64 §5.5) — a thing whose session ENDED while
 * it stayed open or active, with no work on it now — against real SQL
 * (PGlite, every table), through the two doors that surface it:
 *
 *  - `lifecycle.moving`'s `leftBehind` section (the REAL router): a subject
 *    left open after a closed session appears; one the end moved to done
 *    does not; a target left active after a cancelled session appears; a
 *    thing with work still on it (a session on it, or a live target) does
 *    not; a thing the caller cannot read, or whose only ended session the
 *    caller cannot read, does not; a role subject names its FACET's status;
 *    newest-ended first, `limit` rows + the whole `total`, narrowed to a
 *    space; a failed read is `null`, never an empty list, and never fails
 *    the rest of Moving now;
 *  - orient's loose ends (`readLooseEnds`): the calling agent sees only what
 *    ITS OWN ended sessions left behind, each with the call that settles it.
 *
 * Nothing is stubbed but the database handle (and, for the failure case, the
 * read itself).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const FINDING = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const PERSON_KIND = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
  failLeftBehind: false,
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
    countWorkerPendingApprovals: async () => 0,
    countWorkerPendingApprovalsBulk: async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, 0])),
  };
});

vi.mock("../left-behind.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../left-behind.js")>();
  return {
    ...actual,
    readLeftBehind: async (
      ...args: Parameters<typeof actual.readLeftBehind>
    ) => {
      if (h.failLeftBehind) throw new Error("left-behind read down");
      return actual.readLeftBehind(...args);
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { lifecycleRouter } from "../../../routers/lifecycle.js";
import { readLooseEnds } from "../../discover/loose-ends.js";

const USER = "user-1";
const OTHER = "other-user";
const AGENT = "agent-1";
const OTHER_AGENT = "agent-2";
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
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const caller = () =>
  lifecycleRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
    workspaceId: null,
  } as never);

const CATEGORY: Record<string, string> = {
  open: "open",
  fixing: "active",
  fixed: "done",
  wont_fix: "lost",
  new: "open",
  qualified: "active",
  converted: "done",
};

async function space(name: string, owner = USER): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings, created_at, updated_at)
     values ($1,$2,$3,'operational','{}'::jsonb,now(),now())`,
    [id, name, owner]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(),$1,$2,'owner')`,
    [id, owner]
  );
  return id;
}

async function finding(
  ws: string,
  title: string,
  status: string,
  owner = USER
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, profile_id, title, status, status_category, properties, created_at)
     values ($1,$2,$3,'finding',$4,$5,$6,$7,'{}'::jsonb,now())`,
    [id, owner, ws, FINDING, title, status, CATEGORY[status] ?? null]
  );
  return id;
}

async function person(ws: string, title: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, profile_id, title, properties, created_at)
     values ($1,$2,$3,'person',$4,$5,'{}'::jsonb,now())`,
    [id, USER, ws, PERSON_KIND, title]
  );
  return id;
}

async function leadFacet(
  entityId: string,
  ws: string,
  status: string
): Promise<void> {
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, status_category, properties, metadata, created_at, updated_at)
     values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'{}'::jsonb,'{}'::jsonb,now(),now())`,
    [entityId, LEAD, USER, ws, status, CATEGORY[status] ?? null]
  );
}

/** A session; `endedMins` stamps `closed_at` that many minutes ago. */
async function session(o: {
  subject?: string;
  status: string;
  title: string;
  endedMins?: number;
  owner?: string;
  agent?: string;
  workspace?: string;
}): Promise<string> {
  const id = randomUUID();
  const ended = o.endedMins === undefined ? null : minsAgo(o.endedMins);
  await q(
    `insert into focus_sessions (id, user_id, title, goal, status, origin, subject_entity_id, channel_id, expected_outputs, agent_ids, metadata, created_at, started_at, updated_at, closed_at, workspace_id)
     values ($1,$2,$3,'g',$4,$5,$6,$7,'[]'::jsonb,$8,'{}'::jsonb,$9,$9,$10,$11,$12)`,
    [
      id,
      o.owner ?? USER,
      o.title,
      o.status,
      o.agent ? "agent" : "human",
      o.subject ?? null,
      randomUUID(),
      o.agent ? [o.agent] : [],
      minsAgo(600),
      ended ?? minsAgo(1),
      ended,
      o.workspace ?? null,
    ]
  );
  return id;
}

/** `session --targets--> entity`, role worker_target, with an optional result. */
async function target(
  sessionId: string,
  entityId: string,
  result?: string
): Promise<void> {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, user_id, created_at)
     values (gen_random_uuid(),'session',$1,'entity',$2,'targets',$3::jsonb,$4,now())`,
    [
      sessionId,
      entityId,
      JSON.stringify({
        role: "worker_target",
        ...(result ? { result } : {}),
      }),
      USER,
    ]
  );
}

let DEV = "";
let CRM = "";
let HIDDEN = "";
const T: Record<string, string> = {};
const S: Record<string, string> = {};

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(
    `insert into users (id, name, email, user_type) values
       ($1,'Me','me@x.io','human'), ($2,'Other','o@x.io','human'),
       ($3,'Scout','a@x.io','agent'), ($4,'Ranger','b@x.io','agent')`,
    [USER, OTHER, AGENT, OTHER_AGENT]
  );
  await q(
    `insert into profiles (id, slug, display_name, plural, profile_kind, entity_scope, is_active) values
       ($1,'finding','Finding','Findings','kind','workspace',true),
       ($2,'lead','Lead','Leads','role','pod',true),
       ($3,'person','Person','People','kind','pod',true)`,
    [FINDING, LEAD, PERSON_KIND]
  );

  DEV = await space("Dev");
  CRM = await space("CRM");
  HIDDEN = await space("Hidden", OTHER);

  // 1. A subject left OPEN after its session closed: left behind.
  T.leftOpen = await finding(DEV, "Left open", "open");
  S.leftOpen = await session({
    subject: T.leftOpen,
    status: "closed",
    title: "Fix the login bug",
    endedMins: 30,
  });
  // 2. A subject the end moved to DONE: not left behind.
  T.moved = await finding(DEV, "Fixed by its session", "fixed");
  await session({
    subject: T.moved,
    status: "closed",
    title: "Fix the export",
    endedMins: 20,
  });
  // 3. A TARGET left ACTIVE after a cancelled batch (skipped at the close).
  T.target = await finding(DEV, "Target left fixing", "fixing");
  S.batch = await session({
    status: "cancelled",
    title: "Triage batch",
    endedMins: 10,
  });
  await target(S.batch, T.target, "skipped");
  // 4a. Ended work, but ANOTHER session is on it now: not left behind.
  T.reworked = await finding(DEV, "Being reworked", "open");
  await session({
    subject: T.reworked,
    status: "failed",
    title: "First try",
    endedMins: 40,
  });
  await session({ subject: T.reworked, status: "active", title: "Second try" });
  // 4b. Ended work, and a LIVE batch targets it (no result yet): not left behind.
  T.liveTarget = await finding(DEV, "In a live batch", "open");
  await session({
    subject: T.liveTarget,
    status: "closed",
    title: "Old pass",
    endedMins: 50,
  });
  const live = await session({ status: "active", title: "Live batch" });
  await target(live, T.liveTarget);
  // 4c. Someone ELSE is working it (a session the caller cannot read): still
  //     not left behind — the in-progress half is not floored.
  T.othersWork = await finding(DEV, "Someone else on it", "open");
  await session({
    subject: T.othersWork,
    status: "closed",
    title: "My pass",
    endedMins: 45,
  });
  await session({
    subject: T.othersWork,
    status: "active",
    title: "Their pass",
    owner: OTHER,
  });
  // 5a. A thing the caller cannot read (another user's space), even though
  //     the caller's own session ended on it.
  T.hidden = await finding(HIDDEN, "Hidden", "open", OTHER);
  await session({
    subject: T.hidden,
    status: "closed",
    title: "Peek",
    endedMins: 5,
  });
  // 5b. A visible thing whose only ended session the caller cannot read.
  T.othersEnded = await finding(DEV, "Their ended work", "open");
  await session({
    subject: T.othersEnded,
    status: "closed",
    title: "Their work",
    owner: OTHER,
    endedMins: 6,
  });
  // 6. A ROLE subject: a person (no lifecycle of their own) whose lead facet
  //    stayed qualified (active).
  T.alice = await person(CRM, "Alice");
  await leadFacet(T.alice, CRM, "qualified");
  await session({
    subject: T.alice,
    status: "closed",
    title: "Qualify Alice",
    endedMins: 60,
  });
  // 7. Loose ends: two agents, each with an ended session on its own thing.
  T.mine = await finding(DEV, "Agent left this", "open");
  S.mine = await session({
    subject: T.mine,
    status: "closed",
    title: "Agent work",
    agent: AGENT,
    endedMins: 70,
  });
  T.theirs = await finding(DEV, "Other agent left this", "open");
  await session({
    subject: T.theirs,
    status: "closed",
    title: "Other agent work",
    agent: OTHER_AGENT,
    endedMins: 80,
  });
});

describe("lifecycle.moving — things left behind", () => {
  it("lists what ended work left open or active, newest-ended first, with the session", async () => {
    const { leftBehind } = await caller().moving();
    expect(leftBehind).not.toBeNull();
    expect(leftBehind!.items.map((i) => i.entityId)).toEqual([
      T.target,
      T.leftOpen,
      T.alice,
      T.mine,
      T.theirs,
    ]);
    expect(leftBehind!.total).toBe(5);
    const by = new Map(leftBehind!.items.map((i) => [i.entityId, i]));
    expect(by.get(T.leftOpen)).toMatchObject({
      title: "Left open",
      profileSlug: "finding",
      workspaceId: DEV,
      status: "open",
      category: "open",
      endedSession: {
        id: S.leftOpen,
        label: "Fix the login bug",
        status: "closed",
      },
    });
    expect(
      Date.parse(by.get(T.leftOpen)!.endedSession.closedAt)
    ).toBeGreaterThan(Date.now() - 31 * 60_000);
    expect(by.get(T.target)).toMatchObject({
      status: "fixing",
      category: "active",
      endedSession: { id: S.batch, status: "cancelled" },
    });
  });

  it("a thing the end moved to done, or with work on it now, is not left behind", async () => {
    const ids = (await caller().moving()).leftBehind!.items.map(
      (i) => i.entityId
    );
    expect(ids).not.toContain(T.moved);
    expect(ids).not.toContain(T.reworked);
    expect(ids).not.toContain(T.liveTarget);
    expect(ids).not.toContain(T.othersWork);
  });

  it("a thing the caller cannot read, or whose ended work it cannot read, is not listed", async () => {
    const ids = (await caller().moving()).leftBehind!.items.map(
      (i) => i.entityId
    );
    expect(ids).not.toContain(T.hidden);
    expect(ids).not.toContain(T.othersEnded);
  });

  it("a role subject names its FACET's status, kind and space", async () => {
    const item = (await caller().moving()).leftBehind!.items.find(
      (i) => i.entityId === T.alice
    );
    expect(item).toMatchObject({
      profileSlug: "lead",
      workspaceId: CRM,
      status: "qualified",
      category: "active",
    });
  });

  it("caps at limit with the whole total, and narrows to a space", async () => {
    const one = await caller().moving({ limit: 1 });
    expect(one.leftBehind).toMatchObject({ total: 5 });
    expect(one.leftBehind!.items.map((i) => i.entityId)).toEqual([T.target]);
    const crm = await caller().moving({ workspaceId: CRM, limit: 30 });
    expect(crm.leftBehind).toMatchObject({ total: 1 });
    expect(crm.leftBehind!.items.map((i) => i.entityId)).toEqual([T.alice]);
  });

  it("a failed read is null, never an empty list, and the rest of Moving now still reads", async () => {
    h.failLeftBehind = true;
    try {
      const moving = await caller().moving();
      expect(moving.leftBehind).toBeNull();
      // The things with work on them are still there.
      expect(moving.items.map((i) => i.entityId)).toContain(T.reworked);
    } finally {
      h.failLeftBehind = false;
    }
  });
});

describe("loose ends — what the agent's own ended sessions left behind", () => {
  it("lists only the calling agent's own, each with the call that settles it", async () => {
    const r = await readLooseEnds({ userId: USER, agentUserId: AGENT });
    expect(r.leftBehind).toMatchObject({ count: 1 });
    const items = (r.leftBehind as { items: Array<Record<string, unknown>> })
      .items;
    expect(items.map((i) => i.entityId)).toEqual([T.mine]);
    expect(items[0]).toMatchObject({
      sessionId: S.mine,
      sessionTitle: "Agent work",
      sessionStatus: "closed",
      status: "open",
      category: "open",
    });
    expect(String(items[0]!.close)).toContain(T.mine);

    const other = await readLooseEnds({
      userId: USER,
      agentUserId: OTHER_AGENT,
    });
    expect(
      (other.leftBehind as { items: Array<{ entityId: string }> }).items.map(
        (i) => i.entityId
      )
    ).toEqual([T.theirs]);
  });

  it("a failed read is unavailable, never an empty list", async () => {
    h.failLeftBehind = true;
    try {
      const r = await readLooseEnds({ userId: USER, agentUserId: AGENT });
      expect(r.leftBehind).toEqual({ status: "unavailable" });
    } finally {
      h.failLeftBehind = false;
    }
  });
});
