/**
 * SESSIONS WAITING FOR YOUR PERMISSION (decision D-R1), through the reader on
 * PGlite: one row per session a LIVE runner of which says `needs_permission`
 * (0384), on the person's own open work, and nothing else —
 *   - two runners of one session waiting: ONE row (one item per session);
 *   - a runner gone quiet (past the live window): nothing, it says nothing
 *     about now;
 *   - a busy runner, a closed session, someone else's session: nothing;
 *   - every fixture is an agent's own session (origin `agent`, never
 *     accepted), as a coding agent opens it: a draft still counts;
 * and `countNeedsYou` counts the SAME rows in its headline.
 *
 * Negative controls: the reader without its live-window clause lists the
 * quiet session too; with drafts out (triage lens `default`) it lists nothing.
 *
 * SEAM (review 459d5e5b M1): the session ROWS (`attachNextMove`, the path /
 * list / map batch) carry the same runner fact in `unitFacts.runnerWait`, and
 * THE per-session rule over them names exactly the sessions this reader lists
 * — a `stale` one included, which the old `OPEN_SESSION_STATUSES` prefilter
 * left out of the Inbox while the rule counted it. Negative control: without
 * the runner read on the rows, no row needs you and the seam test is red.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
  h.tables = Object.values(actual).filter((v) => is(v, PgTable));
  const schema = await import("@synap/database/schema");
  const pg = drizzle(client, { schema });
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { listSessionsWaitingForPermission } from "../permission-sessions.js";
import { countNeedsYou, unionNeedsYou } from "../needs-you-union.js";
import { attachNextMove } from "../../focus-sessions/session-path-sections.js";
import { focusSessions } from "@synap/database/schema";
import { db } from "@synap/database";
import {
  needsYouItems,
  needsYouReason,
  waitsOnYouAtTerminal,
} from "@synap-core/types/units";

const ME = "user-me";
const OTHER = "user-other";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def = [
      "created_at",
      "updated_at",
      "timestamp",
      "started_at",
    ].includes(c.name)
      ? " default now()"
      : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function session(
  title: string,
  owner = ME,
  status = "active"
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, origin, expected_outputs, metadata, criteria, started_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'agent', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, now(), now(), now())`,
    [id, owner, title, title, status]
  );
  return id;
}

async function runner(
  sessionId: string,
  state: string,
  seenSecondsAgo = 5,
  process = randomUUID()
) {
  await q(
    `insert into session_runners (session_id, client_key, user_id, harness, conversation_id, process_key, state, state_since, state_reported_at, first_seen_at, last_seen_at)
     values ($1, $2, $3, 'claude-code', $4, $5, $6, now() - interval '1 minute', now(), now(), now() - make_interval(secs => $7))`,
    [
      sessionId,
      `key:${randomUUID()}|conv:claude-code:${process}`,
      ME,
      process,
      process,
      state,
      seenSecondsAgo,
    ]
  );
}

let waiting = "";
let twice = "";
let asking = "";
let both = "";
let stale = "";

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  waiting = await session("Run the migration");
  await runner(waiting, "needs_permission");
  await runner(waiting, "busy");
  // Two of its runners wait: still ONE item.
  twice = await session("Two copies wait");
  await runner(twice, "needs_permission");
  await runner(twice, "needs_permission");
  const quiet = await session("Gone quiet");
  await runner(quiet, "needs_permission", 600);
  const busy = await session("At work");
  await runner(busy, "busy");
  const closed = await session("Done", ME, "closed");
  await runner(closed, "needs_permission");
  const theirs = await session("Someone else's", OTHER);
  await runner(theirs, "needs_permission");
  // Cockpit C4: a question at the terminal waits on the person too.
  asking = await session("Asks a question");
  await runner(asking, "needs_answer");
  await runner(asking, "busy");
  // Both terminal waits: ONE row, the more urgent word.
  both = await session("Asks and needs a permission");
  await runner(both, "needs_answer");
  await runner(both, "needs_permission");
  // The reaper marked it stale, yet its agent is live at a dialog: the rule
  // counts it (only an ended session is out).
  stale = await session("Stale but waiting", ME, "stale");
  await runner(stale, "needs_permission");
});

describe("sessions waiting for your permission (D-R1)", () => {
  it("one row per session with a live runner waiting, on the person's own open work", async () => {
    const { sessions, truncated } = await listSessionsWaitingForPermission({
      userId: ME,
    });
    expect(truncated).toBe(false);
    expect(sessions.map((s) => s.title).sort()).toEqual([
      "Asks a question",
      "Asks and needs a permission",
      "Run the migration",
      "Stale but waiting",
      "Two copies wait",
    ]);
    expect(sessions.every((s) => s.since instanceof Date)).toBe(true);
  });

  it("needs_answer counts too (the named default extending D-R1), in its own words; both words fold to the more urgent", async () => {
    const { sessions } = await listSessionsWaitingForPermission({
      userId: ME,
    });
    const word = (id: string) => sessions.find((s) => s.id === id)?.runnerState;
    expect(word(asking)).toBe("needs_answer");
    expect(word(both)).toBe("needs_permission");
    expect(word(waiting)).toBe("needs_permission");
    const rows = unionNeedsYou({
      clusters: [],
      notifications: [],
      owedSlots: [],
      permissionSessions: sessions.filter((s) => s.id === asking),
    });
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "session-permission",
        waitKind: "answer",
        why: "Waiting for your answer",
        needsYouClass: "needs_you",
      }),
    ]);
  });

  it("is counted through the same rows the list draws, in the headline", async () => {
    const { sessions } = await listSessionsWaitingForPermission({
      userId: ME,
    });
    const rows = unionNeedsYou({
      clusters: [],
      notifications: [],
      owedSlots: [],
      permissionSessions: sessions,
    });
    const count = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      notifications: [],
      clusters: [],
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
      permissionSessions: sessions,
    });
    expect(rows.map((r) => r.kind)).toEqual([
      "session-permission",
      "session-permission",
      "session-permission",
      "session-permission",
      "session-permission",
    ]);
    expect(count.permission).toBe(5);
    expect(count.needsYou).toBe(rows.length);
    expect(count.folds.needsYou).toBe(count.needsYou);
  });

  it("narrows to one session when asked", async () => {
    const { sessions } = await listSessionsWaitingForPermission({
      userId: ME,
      sessionId: twice,
    });
    expect(sessions.map((s) => s.id)).toEqual([twice]);
  });

  it("SEAM: the session rows' own rule names exactly the sessions the Inbox lists (one rule, M1)", async () => {
    const { sessions } = await listSessionsWaitingForPermission({
      userId: ME,
    });
    const mine = (await db.select().from(focusSessions)).filter(
      (r) => r.userId === ME
    );
    const rows = await attachNextMove(mine, { userId: ME, database: db });
    // NON-VACUITY: every fixture came back with a runner read, none failed.
    expect(rows).toHaveLength(mine.length);
    expect(rows.every((r) => r.unitFacts.runnerWait !== null)).toBe(true);
    const onRows = rows
      .filter((r) => waitsOnYouAtTerminal(r.unitFacts.runnerWait))
      .map((r) => r.id)
      .sort();
    expect(onRows.length).toBeGreaterThan(0);
    expect(onRows).toEqual(sessions.map((s) => s.id).sort());
    // Each is one item on its own row, and its reason says why.
    for (const r of rows.filter((r) => onRows.includes(r.id))) {
      expect(needsYouReason(r.unitFacts)).toBe("permission");
      const items = needsYouItems(r.unitFacts);
      if (items !== null) expect(items).toBeGreaterThanOrEqual(1);
    }
  });
});
