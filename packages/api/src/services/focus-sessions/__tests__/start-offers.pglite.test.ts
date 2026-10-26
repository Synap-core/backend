/**
 * F5/F6 (plan v5, lane be-context) — the START OFFERS on PGlite: the
 * project's open goals (when the start named none) and the open sessions on
 * close work, suggestions only.
 *
 * Real: `readStartOffers`, `listOpenGoalRows` (project_tracks VisibilityRule),
 * `sessionReadableWhere`, `sessionKindWhere`, `tokenSetOverlap`. Only the goal
 * reader is wrapped, so one flag can force a FAILED read and prove it is
 * `unavailable` while the session offer still answers.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    failGoals: false,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
  };
  return state;
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});

vi.mock("../../discover/open-goals.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = actual.listOpenGoalRows as (...a: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    listOpenGoalRows: async (...a: unknown[]) => {
      if (h.failGoals) throw new Error("goals read exploded");
      return real(...a);
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  projects,
  projectTracks,
  projectMembers,
  workspaces,
  workspaceMembers,
  podMembers,
  users,
  channels,
  channelMembers,
} from "@synap/database";
import { readStartOffers } from "../start-offers.js";

const USER = "user-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = t.endsWith("[]") && !base.endsWith("[]") ? `${base}[]` : base;
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const P = randomUUID();
const G = { map: randomUUID(), crm: randomUUID(), done: randomUUID() };
const S = {
  fresh: randomUUID(), // the session just started
  twin: randomUUID(), // open, close words → offered
  far: randomUUID(), // open, unrelated words → not offered
  receipt: randomUUID(), // close words but a receipt → never
  closed: randomUUID(), // close words but closed → never
  inGoal: randomUUID(), // filed into the map goal
};

async function goal(id: string, name: string, status: string) {
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, created_at, updated_at)
     values ($1, $2, $3, $4, '{}'::jsonb, '1', null, $5, now(), now())`,
    [id, P, USER, name, status]
  );
}
async function session(
  id: string,
  title: string,
  opts: { status?: string; trackId?: string; metadata?: unknown } = {}
) {
  await q(
    `insert into focus_sessions (id, user_id, project_id, track_id, title, goal, status, expected_outputs, metadata, origin, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, $5, $5, $6, '[]'::jsonb, $7::jsonb, 'agent', now(), now(), now())`,
    [
      id,
      USER,
      P,
      opts.trackId ?? null,
      title,
      opts.status ?? "active",
      JSON.stringify(opts.metadata ?? {}),
    ]
  );
}

beforeAll(async () => {
  for (const t of [
    focusSessions,
    projects,
    projectTracks,
    projectMembers,
    workspaces,
    workspaceMembers,
    podMembers,
    users,
    channels,
    channelMembers,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, 'Synap', 'active', now(), now())`,
    [P, USER]
  );
  await goal(G.map, "Founder work map", "active");
  await goal(G.crm, "Ship the CRM", "proposed");
  await goal(G.done, "Founder work map v0", "completed");
  await session(S.fresh, "Founder work map graph view");
  await session(S.twin, "Work map graph for the founder");
  await session(S.far, "Invoice reminders for clients");
  await session(S.receipt, "Founder work map graph", {
    metadata: { kind: "agent-proposal-package" },
  });
  await session(S.closed, "Founder work map graph view", {
    status: "closed",
  });
  await session(S.inGoal, "Map legend", { trackId: G.map });
});

const offersFor = (over: Partial<Parameters<typeof readStartOffers>[0]> = {}) =>
  readStartOffers({
    userId: USER,
    sessionId: S.fresh,
    projectId: P,
    trackId: null,
    title: "Founder work map graph view",
    goal: "Founder work map graph view",
    ...over,
  });

describe("start offers (F5): the project's open goals, best match first", () => {
  it("offers every OPEN goal of the project, the matching one first; never a closed one", async () => {
    const offers = await offersFor();
    expect(offers?.goals).toMatchObject({ status: "ok", total: 2 });
    const goals =
      offers?.goals && "items" in offers.goals ? offers.goals.items : [];
    expect(goals.map((g) => g.id)).toEqual([G.map, G.crm]);
    expect(goals[0]!.score).toBeGreaterThan(goals[1]!.score);
  });

  it("a start that named its goal gets no goal offer", async () => {
    const offers = await offersFor({ trackId: G.map });
    expect(offers?.goals).toBeUndefined();
  });

  it("a FAILED goal read is unavailable — and the session offer still answers", async () => {
    h.failGoals = true;
    try {
      const offers = await offersFor();
      expect(offers?.goals).toEqual({
        status: "unavailable",
        reason: expect.any(String),
      });
      expect(offers?.sessions).toMatchObject({ status: "ok" });
    } finally {
      h.failGoals = false;
    }
  });
});

describe("start offers (F6): open sessions on close work", () => {
  it("offers the open near-twin in the project; never itself, a receipt, a closed one or unrelated work", async () => {
    const offers = await offersFor();
    expect(offers?.sessions).toMatchObject({ status: "ok", scope: "project" });
    const ids =
      offers?.sessions && "items" in offers.sessions
        ? offers.sessions.items.map((s) => s.id)
        : [];
    expect(ids).toContain(S.twin);
    for (const never of [S.fresh, S.receipt, S.closed, S.far]) {
      expect(ids).not.toContain(never);
    }
  });

  it("filed into a goal: the scope is the goal's sessions", async () => {
    const offers = await offersFor({
      trackId: G.map,
      title: "Map legend colours",
      goal: "Map legend colours",
    });
    expect(offers?.sessions).toMatchObject({
      status: "ok",
      scope: "goal",
      items: [expect.objectContaining({ id: S.inGoal, trackId: G.map })],
    });
  });

  it("no project and no goal: no offers at all (nothing to look in)", async () => {
    expect(await offersFor({ projectId: null })).toBeUndefined();
  });
});
