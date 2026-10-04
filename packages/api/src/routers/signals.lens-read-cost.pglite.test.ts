/**
 * The LENS READ on PGlite — the review-round fixes (REV-lens-code F1 F2 F5 F6
 * F7), each driven through the REAL router and the REAL doors, with a fixture
 * that DISCRIMINATES the old behaviour from the new:
 *
 *  F1  Blocking is capped by drawn ROW, server-side. Project PF1: a session
 *      owing 3 things + 4 sessions owing one → 5 rows with NO caps sent (the
 *      old signal slice drew 3 rows, or cut the card's items).
 *  F2  Happened spends its page on RECORD CHANGES only. 15 governance-phase /
 *      connector events newer than 3 record changes: the old read filled the
 *      default cap (10) with lines the client then dropped.
 *  F5  Happening measures liveness inside the working window — same answer.
 *  F6  Notifications narrow by container IN SQL, before the scan limit. 120
 *      pod-level unread rows newer than project PN's own: the old pod-floor
 *      read never saw PN's rows and reported every narrow page truncated.
 *  F7  The status banner at a narrow scope reads health on its own (it used
 *      the pod-floor page, so an older health row vanished), and a failed
 *      health read is `statusUnreadable`, never a calm `null`.
 *
 * `events.read` goes through the REAL `EventRepository` (raw SQL), pointed at
 * the same PGlite. Stubbed: `listSessionsAwaitingReview`, `listActivity`,
 * `listLandedOutputs` — their own suites pin them.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const EventRepository = actual.EventRepository as new (sql: unknown) => {
    searchEvents: unknown;
  };
  const repo = new EventRepository({
    unsafe: async (q: string, params: unknown[]) =>
      (await client.query(q, params)).rows,
  });
  return { ...actual, db: drizzle(client), getEventRepository: () => repo };
});

vi.mock("../services/projects/project-needs-you.js", () => ({
  listSessionsAwaitingReview: async () => ({ sessions: [], truncated: false }),
}));
vi.mock("../services/activity/list-activity.js", () => ({
  listActivity: async () => ({ items: [], nextCursor: null }),
}));
vi.mock("../services/outputs/landed-outputs.js", () => ({
  LANDED_OUTPUTS_MAX_LIMIT: 100,
  listLandedOutputs: async () => ({
    items: [],
    pending: { count: 0, samples: [] },
    nextCursor: null,
    truncated: false,
  }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  notifications,
  messages,
  channels,
  channelMembers,
  users,
  workspaces,
  workspaceMembers,
  podMembers,
  projectMembers,
  proposals,
  projects,
  events,
  chatTurns,
  automationRuns,
  automationStepRuns,
} from "@synap/database";
import { needsYouRows } from "@synap-core/types/needs-you";
import { signalsRouter } from "./signals.js";
import { NOTIFICATION_REGISTRY_MAP } from "../notifications/registry.js";
import { loadSessionLiveness } from "../services/runs/session-liveness.js";

const USER = "user-1";
const PF1 = randomUUID(); // F1: the cap
const A = randomUUID(); // owes 3
const B = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const PN = randomUUID(); // F6/F7: narrow notifications
const SN = randomUUID();
const ROOMN = randomUUID();
const MSGN = randomUUID();
const PL = randomUUID(); // F5: liveness
const LIVE = randomUUID();
const QUIET = randomUUID();
const ROOM_LIVE = randomUUID();
const ROOM_QUIET = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${["created_at", "updated_at", "timestamp", "started_at"].includes(c.name) ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function session(
  id: string,
  opts: {
    projectId?: string;
    channelId?: string;
    ago: number;
    owes?: boolean;
  }
) {
  const at = new Date(Date.now() - opts.ago * 60_000).toISOString();
  const slots =
    opts.owes === false
      ? []
      : [
          {
            kind: "document",
            label: `Deliverable ${id.slice(0, 4)}`,
            status: "pending",
            owner: "human",
            owedSince: at,
          },
        ];
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, origin, project_id, channel_id, expected_outputs, agent_ids, metadata, criteria, created_at, updated_at, started_at)
     values ($1, $2, $3, $8, 'active', 'human', $4, $5, $6::jsonb, '{}', '{}'::jsonb, '[]'::jsonb, $7, $9, $10)`,
    [
      id,
      USER,
      `Session ${id.slice(0, 4)}`,
      opts.projectId ?? null,
      opts.channelId ?? null,
      JSON.stringify(slots),
      at,
      `Session ${id.slice(0, 4)}`,
      at,
      at,
    ]
  );
}

async function proposal(sessionId: string, projectId: string, name: string) {
  await q(
    `insert into proposals (id, proposal_type, target_type, target_id, data, status, session_id, project_id, created_by, created_at, updated_at)
     values ($1, 'create', 'entity', null, $2::jsonb, 'pending', $3, $4, $5, now() - interval '1 minute', now())`,
    [randomUUID(), JSON.stringify({ name }), sessionId, projectId, USER]
  );
}

async function notify(
  type: string,
  category: string,
  sourceType: string,
  sourceId: string | null,
  title: string,
  minutesAgo: number
) {
  await q(
    `insert into notifications (id, user_id, type, category, priority, title, body, source_type, source_id, actions, status, created_at)
     values ($1, $2, $3, $4, 'high', $5, '', $6, $7, '[]'::jsonb, 'unread', now() - ($8 || ' minutes')::interval)`,
    [
      randomUUID(),
      USER,
      type,
      category,
      title,
      sourceType,
      sourceId,
      String(minutesAgo),
    ]
  );
}

async function event(type: string, minutesAgo: number) {
  await q(
    `insert into events (id, user_id, type, subject_type, subject_id, data, source, timestamp)
     values ($1, $2, $3, 'entity', $4, $5::jsonb, 'sync', now() - ($6 || ' minutes')::interval)`,
    [
      randomUUID(),
      USER,
      type,
      randomUUID(),
      JSON.stringify({ profileSlug: "contact" }),
      String(minutesAgo),
    ]
  );
}

const caller = () =>
  signalsRouter.createCaller({
    db: null,
    authenticated: true,
    userId: USER,
  } as never);

/** The page exactly as relay / the session page ask for it: NO caps. */
const page = (scope: { projectId?: string; sessionId?: string }) =>
  caller()
    .list({ lens: "page", ...scope })
    .then((r) => r.page!);

beforeAll(async () => {
  for (const t of [
    focusSessions,
    notifications,
    messages,
    channels,
    channelMembers,
    users,
    workspaces,
    workspaceMembers,
    podMembers,
    projectMembers,
    proposals,
    projects,
    events,
    chatTurns,
    automationRuns,
    automationStepRuns,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into users (id, name, user_type) values ($1, 'Me', 'human')`,
    [USER]
  );

  // F1 — A owes 3 (slot + 2 distinct-shape decisions) and is the NEWEST
  // block, so a signal slice of 5 would spend 3 slots on it.
  await session(A, { projectId: PF1, ago: 2 });
  await proposal(A, PF1, "Acme");
  await proposal(A, PF1, "Globex");
  for (const [i, id] of B.entries()) {
    await session(id, { projectId: PF1, ago: 30 + i });
  }

  // F6/F7 — PN's own rows are OLDER than 120 pod-level unread rows.
  await session(SN, { projectId: PN, channelId: ROOMN, ago: 300 });
  await q(
    `insert into messages (id, channel_id, author_type, content, timestamp) values ($1, $2, 'ai_agent', 'An idea', now() - interval '300 minutes')`,
    [MSGN, ROOMN]
  );
  await notify("session.unblocked", "ai", "system", SN, "SN unblocked", 240);
  await notify(
    "ai.proactive.suggestion",
    "ai",
    "proactive_message",
    MSGN,
    "Try this in SN",
    240
  );
  await notify(
    "system.intelligence_degraded",
    "system",
    "system",
    null,
    "Intelligence Hub is degraded",
    250
  );
  for (let i = 0; i < 120; i++) {
    await notify(
      "connector.sync.failed",
      "data",
      "connector",
      null,
      `Sync failed ${i}`,
      i + 1
    );
  }

  // F2 — 3 record changes, then 15 newer events that render no line.
  for (const m of [60, 61, 62]) await event("entities.create.completed", m);
  for (let i = 0; i < 5; i++) {
    await event("entities.create.requested", i + 1);
    await event("entities.create.validated", i + 1);
    await event("external_message.received", i + 1);
  }

  // F5 — LIVE got an agent note 1 min ago; QUIET's last one is 2 h old, and
  // it has a lot of older history.
  await session(LIVE, {
    projectId: PL,
    channelId: ROOM_LIVE,
    ago: 600,
    owes: false,
  });
  await session(QUIET, {
    projectId: PL,
    channelId: ROOM_QUIET,
    ago: 600,
    owes: false,
  });
  await q(
    `insert into messages (id, channel_id, author_type, content, timestamp) values (gen_random_uuid(), $1, 'ai_agent', 'working', now() - interval '1 minute')`,
    [ROOM_LIVE]
  );
  await q(
    `insert into messages (id, channel_id, author_type, content, timestamp)
     select gen_random_uuid(), $1, 'ai_agent', 'old', now() - (g || ' minutes')::interval
       from generate_series(120, 400) g`,
    [ROOM_QUIET]
  );
}, 120_000);

describe("F1 — Blocking is capped by drawn ROW on the server", () => {
  it("a session owing 3 things + 4 other blocks → 5 rows, the card whole, with no caps sent", async () => {
    const p = await page({ projectId: PF1 });
    const rows = needsYouRows(p.blocking.rows);
    const drawn = [...rows.recent, ...rows.older];
    expect(drawn).toHaveLength(5);
    const card = drawn.find((r) => r.kind === "session" && r.sessionId === A);
    expect(card?.kind === "session" ? card.items : []).toHaveLength(3);
    expect(p.blocking.rows).toHaveLength(7);
    expect(p.blocking.total).toBe(7);
    expect(p.blocking.hasMore).toBe(false);
  });

  it("a 6th block: still 5 rows (never a split card), and hasMore", async () => {
    const extra = randomUUID();
    await session(extra, { projectId: PF1, ago: 90 });
    const p = await page({ projectId: PF1 });
    const rows = needsYouRows(p.blocking.rows);
    expect([...rows.recent, ...rows.older]).toHaveLength(5);
    expect(
      p.blocking.rows.filter((s) => s.groupKey === `session:${A}`)
    ).toHaveLength(3);
    expect(p.blocking.total).toBe(8);
    expect(p.blocking.hasMore).toBe(true);
    await q(`delete from focus_sessions where id = $1`, [extra]);
  });
});

describe("F2 — Happened spends its page on lines that render", () => {
  it("the page's Happened holds the 3 record changes, not 10 governance / connector events", async () => {
    const p = await page({});
    const kinds = p.happened.rows.map((r) => r.kind);
    expect(kinds).toEqual(["event", "event", "event"]);
    for (const r of p.happened.rows) {
      expect(r.event).toMatchObject({
        action: "create",
        objectKind: "contact",
        origin: "sync",
      });
    }
    expect(p.happened.hasMore).toBe(false);
  });

  it("the history lens filters in SQL BEFORE its limit", async () => {
    const r = await caller().list({ lens: "history", limit: 5 });
    expect(r.signals).toHaveLength(3);
    expect(r.signals.every((s) => s.event?.action === "create")).toBe(true);
  });
});

describe("F5 — Happening measures inside the working window", () => {
  it("the session active a minute ago is working; the one with only old history is not", async () => {
    const p = await page({ projectId: PL });
    expect(p.happening.rows.map((r) => r.target?.id)).toEqual([LIVE]);
    expect(p.happening.unreadable).toEqual([]);
  });
});

describe("F5 — the liveness read is BOUNDED by `since`", () => {
  it("with since = now − window, a session with only old activity measures lastAt null; unbounded it reads the old time", async () => {
    const row = { id: QUIET, channelId: ROOM_QUIET, expectedOutputs: [] };
    const reader = { userId: USER, roster: true };
    const since = new Date(Date.now() - 5 * 60_000);
    const bounded = await loadSessionLiveness(reader, [row], { since });
    const unbounded = await loadSessionLiveness(reader, [row]);
    expect(bounded.get(QUIET)).toMatchObject({
      turnInFlight: false,
      lastAt: null,
    });
    expect(unbounded.get(QUIET)?.lastAt).toBeInstanceOf(Date);
  });
});

describe("F6 — narrow notifications are read in SQL before the limit", () => {
  it("a project's older notification and room suggestion survive 120 newer pod-level rows", async () => {
    const p = await page({ projectId: PN });
    expect(p.blocking.rows.map((r) => r.title)).toContain("SN unblocked");
    expect(p.proposed.rows.map((r) => r.title)).toContain("Try this in SN");
    // The pod's newest-100 cap is not this scope's truncation.
    expect(p.blocking.truncated).toBe(false);
    expect(p.proposed.truncated).toBe(false);
    // Nothing from outside the container leaks in.
    expect(p.blocking.rows.some((r) => r.title.startsWith("Sync failed"))).toBe(
      false
    );
  });

  it("the same rows at session scope", async () => {
    const p = await page({ sessionId: SN });
    expect(p.blocking.rows.map((r) => r.title)).toContain("SN unblocked");
  });

  it("the pod floor still reads the newest page (and says it is truncated)", async () => {
    const p = await page({});
    expect(p.blocking.truncated).toBe(true);
  });
});

describe("F7 — health at a narrow scope", () => {
  it("every status-role notification type is `system` (the narrow banner reads that category)", () => {
    const status = [...NOTIFICATION_REGISTRY_MAP.values()].filter(
      (d) => d.needsYou === "status"
    );
    expect(status.length).toBeGreaterThanOrEqual(2);
    for (const d of status) expect(d.category).toBe("system");
  });

  it("the banner reaches a project page even when the health row is older than the pod's newest 100", async () => {
    const p = await page({ projectId: PN });
    expect(p.status?.issues.map((i) => i.type)).toEqual([
      "system.intelligence_degraded",
    ]);
    expect(p.statusUnreadable).toBe(false);
  });

  it("a FAILED health read is statusUnreadable, never a calm null (last: breaks the table)", async () => {
    await h.client!.exec(
      `alter table notifications rename to notifications_gone`
    );
    try {
      const p = await page({ projectId: PN });
      expect(p.status).toBeNull();
      expect(p.statusUnreadable).toBe(true);
      expect(p.blocking.unreadable).toContain("notifications");
    } finally {
      await h.client!.exec(
        `alter table notifications_gone rename to notifications`
      );
    }
  });
});
