/**
 * S5 (structural plan, founder Q9) — a start that landed in NO project and no
 * goal gets `homes`: up to 3 projects or goals the work may belong in, each
 * with the facts that point there. Suggest-only: nothing is filed.
 *
 * Real: `readStartOffers`, the `projects` VisibilityRule (`scopedDb`),
 * `listOpenGoalRows`, `sessionKindWhere`, `tokenSetOverlap`, on PGlite. Only the
 * goal reader is wrapped, so one flag can force a FAILED read.
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
  relations,
} from "@synap/database";
import { readStartOffers, START_HOMES_MAX } from "../start-offers.js";

const USER = "user-1";
const OTHER = "user-2";
const AGENT = randomUUID();
const CWD = "/Users/someone/code/synap";

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

const P = {
  synap: randomUUID(),
  brand: randomUUID(),
  crm: randomUUID(),
  archived: randomUUID(), // shares "security", but archived → never
  foreign: randomUUID(), // shares "security", but another person's → never
};
const GOAL = { security: randomUUID(), crmSecurity: randomUUID() };
const SUBJECT = randomUUID();
const FRESH = randomUUID();

async function project(
  id: string,
  owner: string,
  name: string,
  status = "active"
) {
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, $3, $4, now(), now())`,
    [id, owner, name, status]
  );
}
async function goal(id: string, projectId: string, name: string) {
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, created_at, updated_at)
     values ($1, $2, $3, $4, '{}'::jsonb, '1', null, 'active', now(), now())`,
    [id, projectId, USER, name]
  );
}
async function session(opts: {
  id?: string;
  projectId: string | null;
  ageDays: number;
  cwd?: string;
  agent?: boolean;
  metadata?: Record<string, unknown>;
}) {
  await q(
    `insert into focus_sessions (id, user_id, project_id, track_id, title, goal, status, expected_outputs, metadata, agent_ids, origin, created_at, updated_at, started_at)
     values ($1, $2, $3, null, 'Past work', 'Past work', 'active', '[]'::jsonb, $4::jsonb, $5::text[], 'agent',
             now() - make_interval(days => $6), now(), now())`,
    [
      opts.id ?? randomUUID(),
      USER,
      opts.projectId,
      JSON.stringify({
        ...(opts.cwd ? { conversationCwd: opts.cwd } : {}),
        ...(opts.metadata ?? {}),
      }),
      opts.agent ? [AGENT] : [],
      opts.ageDays,
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
    relations,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await project(P.synap, USER, "Synap");
  await project(P.brand, USER, "Brand studio");
  await project(P.crm, USER, "Sales CRM");
  await project(P.archived, USER, "Security archive", "archived");
  await project(P.foreign, OTHER, "Security foreign");
  await goal(GOAL.security, P.synap, "Security hardening");

  // The subject belongs to Brand studio.
  await q(
    `insert into relations (id, user_id, source_entity_id, target_entity_id, type)
     values ($1, $2, $3, $4, 'belongs_to_project')`,
    [randomUUID(), USER, SUBJECT, P.brand]
  );
  // Three of this agent's recent sessions, from this folder, are in Synap.
  for (let i = 0; i < 3; i++) {
    await session({ projectId: P.synap, ageDays: 2, cwd: CWD, agent: true });
  }
  // From this folder but 40 days ago (outside the window): no fact for CRM.
  await session({ projectId: P.crm, ageDays: 40, cwd: CWD, agent: true });
  // A receipt from this folder says nothing about where work belongs.
  await session({
    projectId: P.crm,
    ageDays: 1,
    cwd: CWD,
    agent: true,
    metadata: { kind: "agent-proposal-package" },
  });
  // The session just started: no project, no goal.
  await session({
    id: FRESH,
    projectId: null,
    ageDays: 0,
    cwd: CWD,
    agent: true,
  });
});

const homesFor = (over: Partial<Parameters<typeof readStartOffers>[0]> = {}) =>
  readStartOffers({
    userId: USER,
    sessionId: FRESH,
    projectId: null,
    trackId: null,
    title: "Security headers",
    goal: "Ship the security headers",
    subjectEntityId: SUBJECT,
    conversationCwd: CWD,
    agentUserId: AGENT,
    ...over,
  });

const itemsOf = (offers: Awaited<ReturnType<typeof readStartOffers>>) =>
  offers?.homes && "items" in offers.homes ? offers.homes.items : [];

describe("start homes (S5): where an unfiled start may belong, with its reasons", () => {
  it("ranks by the facts that point at each place, at most 3, each with its reasons — and files nothing", async () => {
    const offers = await homesFor();
    expect(offers?.homes).toMatchObject({ status: "ok", total: 3 });
    // No project and no goal to look in: no goal part, and an empty session
    // part (still present, so no reader meets a gap).
    expect(offers?.goals).toBeUndefined();
    expect(offers?.sessions).toEqual({
      status: "ok",
      scope: "none",
      total: 0,
      items: [],
    });
    expect(offers?.hint).toMatch(/nothing was applied/i);

    const items = itemsOf(offers);
    expect(items.map((i) => [i.kind, i.trackId ?? i.projectId])).toEqual([
      // Two facts: this folder and this agent's recent filings.
      ["project", P.synap],
      // One fact each; shared words rank the goal before the subject's project.
      ["goal", GOAL.security],
      ["project", P.brand],
    ]);
    expect(items[0]!.reasons).toEqual([
      "3 sessions started from this folder in the last 30 days are in this project.",
      "3 sessions this agent ran in the last 7 days are in this project.",
    ]);
    expect(items[1]).toMatchObject({
      projectId: P.synap,
      projectName: "Synap",
      trackName: "Security hardening",
      reasons: ['Shares "security" with the goal.'],
    });
    expect(items[2]!.reasons).toEqual([
      "The session's subject is in this project.",
    ]);
    // Never an archived project, another person's project, or a stale folder fact.
    const offered = items.map((i) => i.projectId);
    for (const never of [P.archived, P.foreign, P.crm]) {
      expect(offered).not.toContain(never);
    }

    // Suggest-only: the session is still in no project and no goal.
    const row = (
      await q<{ project_id: string | null; track_id: string | null }>(
        `select project_id, track_id from focus_sessions where id = $1`,
        [FRESH]
      )
    ).rows[0]!;
    expect(row).toEqual({ project_id: null, track_id: null });
  });

  it("more than 3 places: the best 3 are listed, `total` counts them all", async () => {
    await goal(GOAL.crmSecurity, P.crm, "Security review");
    try {
      const offers = await homesFor();
      expect(offers?.homes).toMatchObject({ status: "ok", total: 4 });
      expect(itemsOf(offers)).toHaveLength(START_HOMES_MAX);
      expect(itemsOf(offers)[0]!.projectId).toBe(P.synap);
    } finally {
      await q(`delete from project_tracks where id = $1`, [GOAL.crmSecurity]);
    }
  });

  it("no fact points anywhere: no offers block at all", async () => {
    expect(
      await homesFor({
        title: "Zebra stripes",
        goal: "Zebra stripes",
        subjectEntityId: null,
        conversationCwd: null,
        agentUserId: null,
      })
    ).toBeUndefined();
  });

  it("a FAILED read is unavailable, never folded into no homes", async () => {
    h.failGoals = true;
    try {
      const offers = await homesFor();
      expect(offers?.homes).toEqual({
        status: "unavailable",
        reason: expect.any(String),
      });
    } finally {
      h.failGoals = false;
    }
  });

  it("a start that landed in a project gets no homes", async () => {
    const offers = await homesFor({ projectId: P.synap });
    expect(offers?.homes).toBeUndefined();
  });
});
