/**
 * The intent-surface reads on `lifecycle.*` (surfaces W1), against real SQL
 * (PGlite, every table) through the REAL router:
 *  - `board({ workedBy: true })` — who is on each card: an open session whose
 *    subject is the thing, or an in-flight worker targeting it; closed
 *    sessions, settled targets and plain `targets` links are not; live
 *    (an IS turn running) first; capped; absent unless asked.
 *  - `throughput` — things that entered done / lost per bucket, read from
 *    the transition log over the board's visible things; zeros filled.
 *  - `stuck` — the option's `stuckAfterDays` against time in column: a
 *    column count over the WHOLE column (not the listed items), an item mark,
 *    null/false where the option declares no rule.
 *
 * Only `getEffectiveLifecycle` is stubbed (its own suites prove it), plus the
 * worker backlog counts (proven in database `worker-enablement` suites).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const DEAL = "11111111-1111-4111-8111-111111111111";

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
    countWorkerPendingApprovals: async () => 0,
    countWorkerPendingApprovalsBulk: async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, 0])),
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle(profileId: string) {
        if (profileId !== "11111111-1111-4111-8111-111111111111") return null;
        return {
          propertySlug: "commercialStage",
          options: [
            { key: "draft", category: "open", stuckAfterDays: 7 },
            { key: "negotiating", category: "active" },
            { key: "won", category: "done" },
            { key: "lost", category: "lost" },
          ],
          unclassified: [],
        };
      }
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { lifecycleRouter, throughputBucketStart } from "./lifecycle.js";

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
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const caller = () =>
  lifecycleRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
    workspaceId: null,
  } as never);

async function deal(title: string, status: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, status, properties, created_at)
     values ($1,$2,'deal',$3,$4,$5,'{}'::jsonb,now())`,
    [id, USER, DEAL, title, status]
  );
  return id;
}

async function session(o: {
  subject?: string | null;
  status?: string;
  worker?: boolean;
  running?: boolean;
  owner?: string;
  mins: number;
}): Promise<string> {
  const id = randomUUID();
  const room = randomUUID();
  if (o.running) {
    await q(
      `insert into chat_turns (id, channel_id, status, started_at, updated_at) values ($1,$2,'running',now(),now())`,
      [randomUUID(), room]
    );
  }
  await q(
    `insert into focus_sessions (id, user_id, goal, status, origin, subject_entity_id, channel_id, expected_outputs, metadata, created_at, started_at, updated_at)
     values ($1,$2,'g',$3,$4,$5,$6,'[]'::jsonb,$7::jsonb,$8,$8,$8)`,
    [
      id,
      o.owner ?? USER,
      o.status ?? "active",
      o.worker ? "playbook" : "human",
      o.subject ?? null,
      room,
      JSON.stringify(o.worker ? { automationId: randomUUID() } : {}),
      minsAgo(o.mins),
    ]
  );
  return id;
}

async function targets(
  sessionId: string,
  entityId: string,
  meta: Record<string, unknown>
) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values (gen_random_uuid(),'session',$1,'entity',$2,'targets',$3::jsonb,now())`,
    [sessionId, entityId, JSON.stringify(meta)]
  );
}

let A = "";
let B = "";
let C = "";
const S: Record<string, string> = {};

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(
    `insert into users (id, name, email, user_type) values ($1,'Me','me@x.io','human')`,
    [USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1,'deal','Deal','kind','workspace')`,
    [DEAL]
  );
  A = await deal("A", "draft");
  B = await deal("B", "negotiating");
  C = await deal("C", "draft");

  // A: a person's open session (quiet), a newer one working now, and a third
  //    (cap = 2 keeps the live one first, then the newest quiet one).
  S.aQuietOld = await session({ subject: A, mins: 50 });
  S.aLive = await session({ subject: A, running: true, mins: 40 });
  S.aQuietNew = await session({ subject: A, mins: 10 });
  // A: a CLOSED session on it — not being worked.
  S.aClosed = await session({ subject: A, status: "closed", mins: 1 });
  // B: an in-flight worker targeting it; a settled worker target; a plain
  //    targets link (not a worker edge); another user's session on it.
  S.bWorker = await session({ worker: true, mins: 5 });
  await targets(S.bWorker, B, { role: "worker_target" });
  S.bSettled = await session({ worker: true, mins: 4 });
  await targets(S.bSettled, B, { role: "worker_target", result: "moved" });
  S.bPlain = await session({ mins: 3 });
  await targets(S.bPlain, B, {});
  S.bOther = await session({ subject: B, owner: "someone-else", mins: 2 });
});

describe("lifecycle.board — workedBy", () => {
  it("absent unless asked", async () => {
    const board = await caller().board({ profileSlug: "deal" });
    const items = board.columns.flatMap((c) => c.items);
    expect(items.length).toBe(3);
    for (const i of items) expect(i.workedBy).toBeUndefined();
  });

  it("open sessions on the thing and in-flight workers targeting it — live first, capped, floored", async () => {
    const board = await caller().board({ profileSlug: "deal", workedBy: true });
    const byId = new Map(
      board.columns.flatMap((c) => c.items).map((i) => [i.id, i.workedBy])
    );
    expect(byId.get(A)).toEqual([
      { sessionId: S.aLive, kind: "session", live: true },
      { sessionId: S.aQuietNew, kind: "session", live: false },
    ]);
    expect(byId.get(B)).toEqual([
      { sessionId: S.bWorker, kind: "worker", live: false },
    ]);
    expect(byId.get(C)).toEqual([]);
  });

  it("a paged column read carries it too", async () => {
    const board = await caller().board({
      profileSlug: "deal",
      column: "negotiating",
      workedBy: true,
    });
    expect(board.columns[0]!.items[0]!.workedBy).toEqual([
      { sessionId: S.bWorker, kind: "worker", live: false },
    ]);
  });
});

describe("lifecycle.throughput", () => {
  const DAY = 86_400_000;
  async function moved(
    entityId: string,
    o: { to: string; category: string; daysAgo: number; role?: string }
  ) {
    await q(
      `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id)
       values (gen_random_uuid(), $1, 'entity.transition.completed', $2, 'entity', $3::jsonb, $4)`,
      [
        new Date(Date.now() - o.daysAgo * DAY).toISOString(),
        entityId,
        JSON.stringify({
          to: o.to,
          category: o.category,
          role: o.role ?? null,
        }),
        USER,
      ]
    );
  }

  it("entries into done / lost per week, over the board's visible things, zeros filled", async () => {
    const won = await deal("Won", "won");
    const gone = await deal("Gone", "lost");
    const bounced = await deal("Bounced", "won");
    // This week: won + bounced (twice — counts once) into done.
    await moved(won, { to: "won", category: "done", daysAgo: 0 });
    await moved(bounced, { to: "won", category: "done", daysAgo: 0 });
    await moved(bounced, { to: "won", category: "done", daysAgo: 0 });
    // Two weeks ago: gone into lost.
    await moved(gone, { to: "lost", category: "lost", daysAgo: 14 });
    // Not counted: an active move, a ROLE move on a deal, a move older than
    // the window, and a thing the viewer cannot see.
    await moved(won, { to: "negotiating", category: "active", daysAgo: 0 });
    // (The role move is on a thing with NO kind entry this week, so a read
    // that ignored the lifecycle would count it.)
    await moved(gone, {
      to: "signed",
      category: "done",
      daysAgo: 0,
      role: "client",
    });
    // Older than the 4-week window. NB the door only emits the requested
    // buckets, so this row cannot reach the output either way: the `since`
    // bound is a COST bound, not observable here (verified: removing it
    // keeps this suite green).
    await moved(gone, { to: "lost", category: "lost", daysAgo: 60 });
    const hidden = randomUUID();
    await q(
      `insert into entities (id, user_id, type, profile_id, title, status, properties, created_at)
       values ($1,'someone-else','deal',$2,'Hidden','won','{}'::jsonb,now())`,
      [hidden, DEAL]
    );
    await moved(hidden, { to: "won", category: "done", daysAgo: 0 });

    const t = await caller().throughput({
      profileSlug: "deal",
      period: { bucket: "week", count: 4 },
    });
    expect(t.bucket).toBe("week");
    expect(t.buckets).toHaveLength(4);
    const thisWeek = throughputBucketStart(new Date(), "week");
    expect(t.buckets[3]).toEqual({
      bucketStart: thisWeek.toISOString(),
      done: 2,
      lost: 0,
    });
    const twoAgo = throughputBucketStart(
      new Date(Date.now() - 14 * DAY),
      "week"
    );
    expect(t.buckets[1]).toEqual({
      bucketStart: twoAgo.toISOString(),
      done: 0,
      lost: 1,
    });
    expect(t.buckets[0]).toMatchObject({ done: 0, lost: 0 });
    expect(t.buckets[2]).toMatchObject({ done: 0, lost: 0 });
    expect(t.since).toBe(t.buckets[0]!.bucketStart);
  });

  it("weeks start Monday, UTC (date_trunc semantics)", () => {
    // 2026-10-15 is a Thursday.
    expect(
      throughputBucketStart(
        new Date("2026-10-15T23:30:00Z"),
        "week"
      ).toISOString()
    ).toBe("2026-10-12T00:00:00.000Z");
    expect(
      throughputBucketStart(
        new Date("2026-10-12T00:00:00Z"),
        "week"
      ).toISOString()
    ).toBe("2026-10-12T00:00:00.000Z");
    expect(
      throughputBucketStart(
        new Date("2026-10-11T12:00:00Z"),
        "month"
      ).toISOString()
    ).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("lifecycle.board — stuck", () => {
  it("counts the whole column past the option's rule, marks items, and says null where there is no rule", async () => {
    const DAY = 86_400_000;
    const thing = async (
      title: string,
      status: string,
      createdDaysAgo: number
    ) => {
      const id = randomUUID();
      await q(
        `insert into entities (id, user_id, type, profile_id, title, status, properties, created_at)
         values ($1,$2,'deal',$3,$4,$5,'{}'::jsonb,$6)`,
        [
          id,
          USER,
          DEAL,
          title,
          status,
          new Date(Date.now() - createdDaysAgo * DAY).toISOString(),
        ]
      );
      return id;
    };
    // Two drafts never moved, created 20 and 30 days ago → stuck (7 days).
    const old1 = await thing("Old draft 1", "draft", 20);
    await thing("Old draft 2", "draft", 30);
    // Created long ago but ENTERED draft yesterday → not stuck.
    const back = await thing("Back to draft", "draft", 40);
    await q(
      `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id)
       values (gen_random_uuid(), $1, 'entity.transition.completed', $2, 'entity', $3::jsonb, $4)`,
      [
        new Date(Date.now() - DAY).toISOString(),
        back,
        JSON.stringify({ to: "draft", role: null }),
        USER,
      ]
    );
    // An old negotiation: its option has no rule.
    await thing("Old talks", "negotiating", 90);

    // firstN 1: the count must cover the whole column, not the listed item.
    const board = await caller().board({ profileSlug: "deal", firstN: 1 });
    const draft = board.columns.find((c) => c.key === "draft")!;
    expect(draft.stuck).toBe(2);
    expect(draft.items).toHaveLength(1);
    // time_in_column order: the longest-sitting draft first, and it is stuck.
    expect(draft.items[0]!.stuck).toBe(true);
    const talks = board.columns.find((c) => c.key === "negotiating")!;
    expect(talks.stuck).toBeNull();
    expect(talks.items.every((i) => i.stuck === false)).toBe(true);
    expect(board.columns.find((c) => c.key === "won")!.stuck).toBeNull();
    expect(
      board.lifecycle.options.find((o) => o.key === "draft")!.stuckAfterDays
    ).toBe(7);
    // No rule ⇒ the key is ABSENT (the model's optional), never null.
    expect(
      "stuckAfterDays" in board.lifecycle.options.find((o) => o.key === "won")!
    ).toBe(false);

    // The paged column read marks items the same way.
    const page = await caller().board({
      profileSlug: "deal",
      column: "draft",
      limit: 50,
    });
    const marks = new Map(page.columns[0]!.items.map((i) => [i.id, i.stuck]));
    expect(marks.get(old1)).toBe(true);
    expect(marks.get(back)).toBe(false);
    expect(A && marks.get(A)).toBe(false);
  });
});
