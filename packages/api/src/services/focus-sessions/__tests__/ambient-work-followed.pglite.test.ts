/**
 * AN AMBIENT WRITE FOLLOWS THE PERSON, NOT THE KIND.
 *
 * Both ambient-attribution resolvers narrowed to `sessionKindWhere("work")`,
 * for a good reason: the 08:00 crons mint open `run` sessions that are newer
 * than the person's real work most mornings, and filing an agent's unaddressed
 * write into a cron run is the mis-grouping ambient attach exists to prevent.
 *
 * Then `followPlaybookId` shipped, which writes `playbookId` onto a LIVE
 * session and flips its kind to `run` — by design. The person's own session
 * silently left the population, `resolveWorkSession` fell to `none`, and the
 * next agent write auto-opened a fresh receipt beside the work it belonged to.
 * Nothing failed; the work just split in two.
 *
 * ── WHY THIS RUNS REAL SQL ────────────────────────────────────────────────
 * `session-kind.test.ts` asserts the SQL at the COMPILED level and says so: it
 * proves the predicate still references each signal, not what Postgres returns
 * for a row. The defect here is entirely about which rows come back, so a
 * compiled-text assertion could not have caught it and cannot guard it. The
 * rows below are inserted and read through the predicate itself.
 *
 * ── THE DISCRIMINATING PAIR ───────────────────────────────────────────────
 * A FOLLOWED session and an AUTOMATION RUN. Both carry a `playbookId`; both
 * read `run`. The old predicate excluded both, the naive fix ("drop the
 * narrowing") admits both, and only this pair tells the two apart. A row that
 * is plainly `work` and a receipt agree under every candidate rule — they are
 * coverage, not detection.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, {
    schema: { focusSessions: actual.focusSessions as never },
  });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database";
import { listUnclaimedOpenWorkSessions } from "../resolve-work-session.js";

const USER = "user-ambient-1";
const OTHER = "user-ambient-2";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    const def =
      c.name === "status"
        ? " default 'active'"
        : c.name === "metadata"
          ? " default '{}'::jsonb"
          : c.name.endsWith("_at")
            ? " default now()"
            : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** Insert one session row; `started_at` orders the result. */
async function insert(row: {
  id: string;
  userId?: string;
  status?: string;
  origin?: string | null;
  playbookId?: string | null;
  metadata?: Record<string, unknown>;
  startedAt: string;
}) {
  await q(
    `insert into focus_sessions
       (id, user_id, goal, status, origin, playbook_id, metadata, started_at, created_at, updated_at)
     values ($1, $2, 'g', $3, $4, $5, $6::jsonb, $7, now(), now())`,
    [
      row.id,
      row.userId ?? USER,
      row.status ?? "active",
      row.origin ?? null,
      row.playbookId ?? null,
      JSON.stringify(row.metadata ?? {}),
      row.startedAt,
    ]
  );
}

const ids = async () =>
  (await listUnclaimedOpenWorkSessions(USER, 20)).map((r) => r.id).sort();

beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
});

beforeEach(async () => {
  await q(`delete from focus_sessions`);
});

describe("ambient attribution: which session an unaddressed write is filed under", () => {
  it("DISCRIMINATING: admits a followed session, still excludes an automation run", async () => {
    const followed = randomUUID();
    const cronRun = randomUUID();
    // The person opened this and then attached a playbook to it. It reads
    // `run` in every lens — and it is still where their writes belong.
    await insert({
      id: followed,
      origin: "human",
      playbookId: randomUUID(),
      metadata: { followedVia: "attach", followedAt: "2026-09-20T10:00:00Z" },
      startedAt: "2026-09-20T10:00:00Z",
    });
    // The 08:00 cron minted this. Newer is not the question; whose it is, is.
    await insert({
      id: cronRun,
      origin: "automation",
      playbookId: randomUUID(),
      metadata: { automationId: randomUUID(), automationRunId: randomUUID() },
      startedAt: "2026-09-20T11:00:00Z",
    });

    expect(await ids()).toEqual([followed]);
  });

  it("a playbook-minted run is excluded even without automation metadata", async () => {
    // `origin: "playbook"` alone is a run signal. The attach mark is what
    // separates the populations, not the presence of a playbookId.
    await insert({
      id: randomUUID(),
      origin: "playbook",
      playbookId: randomUUID(),
      startedAt: "2026-09-20T10:00:00Z",
    });
    expect(await ids()).toEqual([]);
  });

  it("an attach mark cannot smuggle a machine-minted row in", async () => {
    // Belt and braces: `followedVia` is stamped at exactly one place today, so
    // this row cannot occur — but the predicate must not rely on that.
    await insert({
      id: randomUUID(),
      origin: "automation",
      playbookId: randomUUID(),
      metadata: { followedVia: "attach", automationId: randomUUID() },
      startedAt: "2026-09-20T10:00:00Z",
    });
    expect(await ids()).toEqual([]);
  });

  it("still holds the rules it always held", async () => {
    const plainWork = randomUUID();
    await insert({
      id: plainWork,
      origin: "human",
      startedAt: "2026-09-20T09:00:00Z",
    });
    // A receipt: an agent's writes packaged without a session.
    await insert({
      id: randomUUID(),
      origin: "agent",
      metadata: { kind: "agent-proposal-package" },
      startedAt: "2026-09-20T12:00:00Z",
    });
    // Claimed by a client — rung 2's business, not rung 3's.
    await insert({
      id: randomUUID(),
      origin: "human",
      metadata: { clientKey: "key:abc" },
      startedAt: "2026-09-20T12:00:00Z",
    });
    // A future appointment, and another person's session.
    await insert({
      id: randomUUID(),
      origin: "playbook",
      status: "scheduled",
      startedAt: "2026-09-21T09:00:00Z",
    });
    await insert({
      id: randomUUID(),
      userId: OTHER,
      origin: "human",
      startedAt: "2026-09-20T12:00:00Z",
    });
    // Closed.
    await insert({
      id: randomUUID(),
      origin: "human",
      status: "closed",
      startedAt: "2026-09-20T12:00:00Z",
    });

    expect(await ids()).toEqual([plainWork]);
  });
});
