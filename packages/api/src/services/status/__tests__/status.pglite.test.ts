/**
 * The status read and the rollups (status-flow W0b) on real SQL (PGlite):
 *
 *   - `readStatusOf`: an entity's status, words and category; since = its
 *     last transition, else its creation, said as NOT measured; stuck only
 *     past its step's `stuckAfterDays`; a goal's and a session's since from
 *     their own transitions; a session's owed slot is what it waits on; an id
 *     the caller cannot see, or that is not a uuid, is `unknown`;
 *   - `readGoalRollups`: a goal's sessions per category, its moves this
 *     week, what it waits on;
 *   - `readScopeRollup`: a space's things per category, its stuck things
 *     (named), its work, its moves; another person's project is `null`;
 *   - `withGoalRollups`: a failed rollup read is `unavailable`, never zeros.
 *
 * Only `getEffectiveLifecycle` is stubbed (its own suites prove it).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
const DEAL = "11111111-1111-4111-8111-111111111111";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle(profileId: string) {
        if (profileId !== DEAL) return null;
        return {
          propertySlug: "stage",
          options: [
            { key: "draft", category: "open" },
            {
              key: "negotiating",
              category: "active",
              label: "In talks",
              stuckAfterDays: 3,
            },
            { key: "won", category: "done" },
          ],
          unclassified: [],
        };
      }
    },
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { readStatusOf } from "../status-read.js";
import {
  readGoalRollups,
  readScopeRollup,
  withGoalRollups,
} from "../status-rollup.js";

const ME = "user-me";
const OTHER = "user-other";
const W = randomUUID();
const P = randomUUID();
const P_THEIRS = randomUUID();
const G = randomUUID();
const S_ACTIVE = randomUUID();
const S_CLOSED = randomUUID();
const E_STUCK = randomUUID();
const E_MOVED = randomUUID();
const E_THEIRS = randomUUID();

let client: PGlite;
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${columns.join(", ")});`;
}

const ago = (days: number) => `now() - interval '${days} days'`;

async function transition(
  subjectType: string,
  subjectId: string,
  type: string,
  daysAgo: number,
  data: Record<string, unknown> = {}
) {
  await q(
    `insert into events (id, type, subject_id, subject_type, data, user_id, workspace_id, timestamp)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, ${ago(daysAgo)})`,
    [randomUUID(), type, subjectId, subjectType, JSON.stringify(data), ME, W]
  );
}

beforeAll(async () => {
  client = new PGlite();
  // Every table of the schema: the reads under test join widely, and a
  // hand-kept list is the one that falls behind.
  const tables = (Object.values(schema) as unknown[]).filter(
    (t): t is PgTable => is(t, PgTable)
  );
  expect(tables.length).toBeGreaterThan(50);
  for (const t of tables) await client.exec(ddlFor(t));
  holder.db = drizzle(client, { schema });

  await q(
    `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, 'Sales', 'personal')`,
    [W, ME]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), W, ME]
  );
  for (const [id, owner] of [
    [P, ME],
    [P_THEIRS, OTHER],
  ]) {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
       values ($1, $2, null, 'Project', 'active', now(), now())`,
      [id, owner]
    );
  }
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
     values ($1, $2, $3, 'Ship the CRM', '{}'::jsonb, '1', 'active', '[]'::jsonb, ${ago(20)}, now())`,
    [G, P, ME]
  );
  const owed = [
    {
      key: "pick",
      label: "Which plan",
      kind: "decision",
      owner: "human",
      status: "pending",
      blockedReason: "decision",
      owedSince: new Date().toISOString(),
    },
  ];
  for (const [id, status, outputs] of [
    [S_ACTIVE, "active", owed],
    [S_CLOSED, "closed", []],
  ] as const) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, goal, status, origin, expected_outputs, metadata, started_at, closed_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'Do it', $6, 'agent', $7::jsonb, '{}'::jsonb, ${ago(5)}, $8, now(), now())`,
      [
        id,
        ME,
        W,
        P,
        G,
        status,
        JSON.stringify(outputs),
        status === "closed" ? new Date() : null,
      ]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, 'deal', 'Deal', 'kind', 'workspace')`,
    [DEAL]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1, $2, true)`,
    [DEAL, randomUUID()]
  );
  for (const [id, owner, created] of [
    [E_STUCK, ME, 10],
    [E_MOVED, ME, 10],
    [E_THEIRS, OTHER, 10],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, title, status, status_category, properties, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'negotiating', 'active', '{}'::jsonb, ${ago(created)}, now())`,
      [id, owner, owner === ME ? W : null, DEAL, `Deal ${id.slice(0, 4)}`]
    );
  }
  // E_MOVED entered `negotiating` a day ago; E_STUCK never moved.
  await transition("entity", E_MOVED, "entity.transition.completed", 1, {
    role: null,
    category: "active",
  });
  await transition("track", G, "track.transition.completed", 2, {
    trackId: G,
    projectId: P,
  });
  await transition(
    "focus_session",
    S_CLOSED,
    "focus_session.transition.completed",
    1,
    { trackId: G, projectId: P }
  );
  // Outside the 7-day window: not "moved".
  await transition(
    "focus_session",
    S_ACTIVE,
    "focus_session.transition.completed",
    30,
    { trackId: G, projectId: P }
  );
});

describe("readStatusOf", () => {
  it("says where each id stands, and `unknown` for what the caller cannot see", async () => {
    const out = await readStatusOf(ME, [
      E_STUCK,
      E_MOVED,
      G,
      S_ACTIVE,
      E_THEIRS,
      randomUUID(),
      "not-an-id",
    ]);
    const by = new Map(out.map((a) => [a.id, a]));

    expect(by.get(E_STUCK)).toMatchObject({
      type: "entity",
      status: "negotiating",
      label: "In talks",
      category: "active",
      sinceMeasured: false,
      stuck: { afterDays: 3, forDays: 10 },
    });
    const moved = by.get(E_MOVED);
    expect(moved).toMatchObject({ type: "entity", sinceMeasured: true });
    expect(moved).not.toHaveProperty("stuck");

    expect(by.get(G)).toMatchObject({
      type: "goal",
      status: "active",
      category: "active",
      sinceMeasured: true,
    });
    expect(by.get(S_ACTIVE)).toMatchObject({
      type: "session",
      category: "active",
      sinceMeasured: true,
      waitingOn: [{ reason: "input", count: 1 }],
    });

    expect(by.get(E_THEIRS)).toEqual({ id: E_THEIRS, type: "unknown" });
    expect(by.get("not-an-id")).toEqual({ id: "not-an-id", type: "unknown" });
    expect(out).toHaveLength(7);
  });
});

describe("rollups", () => {
  it("a goal: its sessions per category, its moves this week, what it waits on", async () => {
    const rollup = (await readGoalRollups(ME, [G])).get(G);
    expect(rollup).toMatchObject({
      sinceMeasured: true,
      work: { active: 1, done: 1 },
      // The goal's own move and its closed session's; the 30-day-old one is out.
      moved: 2,
    });
    expect(rollup?.waitingOn).toContainEqual({ reason: "input", count: 1 });
  });

  it("a space: things per category, the stuck ones named, its work and moves", async () => {
    const r = await readScopeRollup({ userId: ME, workspaceId: W });
    expect(r).toMatchObject({
      lens: "workspace",
      id: W,
      things: { active: 2 },
      work: { active: 1, done: 1 },
      moved: 3,
      stuck: {
        count: 1,
        items: [{ id: E_STUCK, kind: "deal", status: "negotiating" }],
      },
    });
    expect(r?.waitingOn).toContainEqual({ reason: "input", count: 1 });
  });

  it("another person's project is null, never a rollup of zeros", async () => {
    expect(
      await readScopeRollup({ userId: ME, projectId: P_THEIRS })
    ).toBeNull();
  });

  it("a FAILED rollup read is unavailable on each goal, never zeros", async () => {
    const goals = {
      count: 1,
      countIsLowerBound: false,
      lens: "pod" as const,
      items: [
        {
          id: G,
          projectId: P,
          name: "Ship the CRM",
          status: "active",
          endState: null,
          criteria: 0,
        },
      ],
      howTo: "file work into it",
    };
    await client.exec(`alter table focus_sessions rename to fs_gone`);
    try {
      const out = await withGoalRollups(ME, goals);
      expect(out).toMatchObject({
        items: [{ id: G, rollup: { status: "unavailable" } }],
      });
    } finally {
      await client.exec(`alter table fs_gone rename to focus_sessions`);
    }
  });
});
