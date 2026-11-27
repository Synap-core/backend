/**
 * Session interactions on PGlite — the REAL SQL of `readSessionInteractions`
 * against tables generated from the Drizzle definitions.
 *
 * Fixture rows are chosen where naive rules DISAGREE:
 *   - a run whose triggering event was back-stamped with its OWN session (the
 *     playbook-run back-stamp) — "any trigger event with a session" would draw
 *     a self-loop;
 *   - the producer's own create event on its output — "any event on a produced
 *     entity" would report A updated A;
 *   - a writer whose producer is OFF the page — a one-sided page filter would
 *     report a line the map cannot draw;
 *   - a malformed `automationRunId` — a uuid cast would throw the whole read;
 *   - an UPPERCASE run id and trigger event id — a bare `::uuid` cast or a
 *     case-insensitive pattern would match them; `pk::text = <text>` never
 *     did (Postgres prints a uuid lowercase), so they must not match now;
 *   - the triggered join's PLAN: `automation_runs` and `events` are probed by
 *     their primary key (`uuidFromTextSql`), never `pk::text = <text>`, which
 *     hides the key index and plans a Seq Scan (the defect this pins).
 *
 * NOT covered: `attachSessionInteractions`' unavailable branch (a thrown read);
 * TimescaleDB chunking (PGlite has none: `events` is one plain table here).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  /** Every statement drizzle sends, so a test can EXPLAIN the real SQL. */
  seen: [] as Array<{ sql: string; params?: unknown[] }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  const query = client.query.bind(client);
  (client as unknown as { query: unknown }).query = (
    sql: string,
    params?: unknown[],
    opts?: unknown
  ) => {
    h.seen.push({ sql, params });
    return query(sql, params, opts as never);
  };
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  db,
  focusSessions,
  events,
  links,
  automationRuns,
} from "@synap/database";
import { readSessionInteractions } from "./session-interactions.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const S = {
  writer: randomUUID(), // writes the event that fires runs; produces an entity
  run: randomUUID(), // automation run fired by writer's event
  pbRun: randomUUID(), // playbook run fired via chain-context stamp
  selfRun: randomUUID(), // run whose trigger event carries its OWN session
  editor: randomUUID(), // writes to writer's output
  broken: randomUUID(), // malformed automationRunId
  upperRun: randomUUID(), // automationRunId = the run's id in UPPERCASE
  upperEvent: randomUUID(), // chain-context triggerEventId in UPPERCASE
  offPageProducer: randomUUID(), // produced something editor touched; not on page
};
const ENTITY = randomUUID();
const OFF_ENTITY = randomUUID();

async function session(id: string, metadata: Record<string, unknown> = {}) {
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, started_at, created_at, updated_at)
     values ($1, 'user-1', 'g', 'active', $2::jsonb, now(), now(), now())`,
    [id, JSON.stringify(metadata)]
  );
}

async function event(opts: {
  sessionId: string | null;
  subjectId: string;
  subjectType?: string;
  minutesAgo?: number;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id, session_id)
     values ($1, now() - make_interval(mins => $2::int), 'entities.update', $3, $4, '{}'::jsonb, 'user-1', $5)`,
    [
      id,
      opts.minutesAgo ?? 0,
      opts.subjectId,
      opts.subjectType ?? "entity",
      opts.sessionId,
    ]
  );
  return id;
}

const produced = (sessionId: string, entityId: string) =>
  q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'session', $2, 'entity', $3, 'produced', '{}'::jsonb, now())`,
    [randomUUID(), sessionId, entityId]
  );

beforeAll(async () => {
  for (const t of [focusSessions, events, links, automationRuns]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  // `events`' key is (id, timestamp) (a hypertable needs its time column in
  // it); the column-level DDL above cannot see a composite key.
  await h.client!.exec(`alter table events add primary key (id, timestamp);`);

  // writer's write fires an automation run (automation_runs.trigger_event_id)…
  const fired = await event({
    sessionId: S.writer,
    subjectId: ENTITY,
    minutesAgo: 30,
  });
  const runRow = randomUUID();
  await q(
    `insert into automation_runs (id, trigger_event_id) values ($1, $2)`,
    [runRow, fired]
  );
  await session(S.writer);
  await session(S.run, { automationRunId: runRow });
  // …and a playbook run via the nested chain-context stamp.
  await session(S.pbRun, { automationChainContext: { triggerEventId: fired } });

  // A run whose trigger event was back-stamped with ITSELF — no self-loop.
  const selfEvent = await event({
    sessionId: S.selfRun,
    subjectId: randomUUID(),
  });
  await session(S.selfRun, {
    automationChainContext: { triggerEventId: selfEvent },
  });

  // Malformed metadata must be a non-match, never a cast error.
  await session(S.broken, { automationRunId: "not-a-uuid" });
  // Uppercase ids: `pk::text = <text>` never matched them, so neither may the
  // uuid probe (a bare `::uuid` cast would).
  await session(S.upperRun, { automationRunId: runRow.toUpperCase() });
  await session(S.upperEvent, {
    automationChainContext: { triggerEventId: fired.toUpperCase() },
  });

  // writer PRODUCED the entity (its own create event above is excluded);
  // editor wrote to it twice.
  await produced(S.writer, ENTITY);
  await session(S.editor);
  await event({ sessionId: S.editor, subjectId: ENTITY, minutesAgo: 10 });
  await event({ sessionId: S.editor, subjectId: ENTITY, minutesAgo: 5 });

  // editor also touched an entity whose producer is OFF the page.
  await session(S.offPageProducer);
  await produced(S.offPageProducer, OFF_ENTITY);
  await event({ sessionId: S.editor, subjectId: OFF_ENTITY });

  // Enough runs and events that a sequential probe costs more than a key one.
  await h.client!.exec(`
    insert into automation_runs (id) select gen_random_uuid() from generate_series(1, 5000);
    insert into events (id, timestamp, type)
      select gen_random_uuid(), now() - make_interval(mins => g), 'entities.update'
      from generate_series(1, 5000) g;
    analyze automation_runs; analyze events; analyze focus_sessions;
  `);
});

const PAGE = [
  S.writer,
  S.run,
  S.pbRun,
  S.selfRun,
  S.editor,
  S.broken,
  S.upperRun,
  S.upperEvent,
];

describe("readSessionInteractions (PGlite)", () => {
  it("derives triggered (both run stamps) and updated, with no self-loops and nothing off the page", async () => {
    const out = await readSessionInteractions(PAGE, db);
    const pairs = out
      .map((i) => `${i.type}:${i.fromSessionId}->${i.toSessionId}:${i.count}`)
      .sort();
    expect(pairs).toEqual(
      [
        `triggered:${S.writer}->${S.run}:1`,
        `triggered:${S.writer}->${S.pbRun}:1`,
        `updated:${S.writer}->${S.editor}:2`,
      ].sort()
    );
    const upd = out.find((i) => i.type === "updated")!;
    expect(upd.lastAt).toEqual(expect.any(String));
  });

  it("reports the off-page producer's line only once that producer is on the page", async () => {
    const out = await readSessionInteractions([...PAGE, S.offPageProducer], db);
    expect(
      out.some(
        (i) =>
          i.type === "updated" &&
          i.fromSessionId === S.offPageProducer &&
          i.toSessionId === S.editor
      )
    ).toBe(true);
  });

  it("probes automation_runs and events by their primary key", async () => {
    h.seen.length = 0;
    await readSessionInteractions(PAGE, db);
    // The triggered query is the one statement that reads automation_runs.
    const triggered = h.seen.filter((s) => /"automation_runs"/.test(s.sql));
    expect(triggered).toHaveLength(1);
    const plan = (
      await h.client!.query<Record<string, unknown>>(
        `explain ${triggered[0]!.sql}`,
        triggered[0]!.params
      )
    ).rows
      .map((r) => String(r["QUERY PLAN"]))
      .join("\n");
    // Non-vacuity: the plan reaches both tables.
    expect(plan).toMatch(/ on automation_runs/);
    expect(plan).toMatch(/ on events/);
    expect(plan).toMatch(/Index (Only )?Scan using automation_runs_pkey/);
    expect(plan).toMatch(/Index (Only )?Scan using events_pkey/);
    expect(plan).not.toMatch(/Seq Scan on (automation_runs|events)/);
  });

  it("reads nothing for a page of fewer than two sessions", async () => {
    expect(await readSessionInteractions([S.writer], db)).toEqual([]);
  });
});
