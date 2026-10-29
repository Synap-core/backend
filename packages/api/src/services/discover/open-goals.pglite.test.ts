/**
 * orient `startHere.openGoals` on PGlite — the open goals an agent's work can
 * serve (plan v5 T1, lane be-context). Real: `readOpenGoals`, `scopedDb` with
 * the `project_tracks` VisibilityRule (visible iff its project is).
 *
 *   - only LIVE goals (open / active / paused), never closed or dropped ones;
 *   - scoped to one project when orient is, pod-wide otherwise;
 *   - another person's project's goals never show;
 *   - a failed read is `unavailable`, never "no goals".
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  projects,
  projectTracks,
  projectMembers,
  workspaces,
  workspaceMembers,
  podMembers,
  users,
} from "@synap/database";
import { readOpenGoals } from "./open-goals.js";

const ME = "user-me";
const OTHER = "user-other";
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

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const P = { mine: randomUUID(), second: randomUUID(), theirs: randomUUID() };
const G = {
  active: randomUUID(),
  proposed: randomUUID(),
  paused: randomUUID(),
  closed: randomUUID(),
  dropped: randomUUID(),
  secondProject: randomUUID(),
  theirs: randomUUID(),
};

async function goal(
  id: string,
  projectId: string,
  name: string,
  status: string,
  extra: { endState?: string; criteria?: unknown[] } = {}
) {
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, end_state, criteria, created_at, updated_at)
     values ($1, $2, $3, $4, '{}'::jsonb, '1', null, $5, $6, $7::jsonb, now(), now())`,
    [
      id,
      projectId,
      ME,
      name,
      status,
      extra.endState ?? null,
      JSON.stringify(extra.criteria ?? []),
    ]
  );
}

beforeAll(async () => {
  for (const t of [
    projects,
    projectTracks,
    projectMembers,
    workspaces,
    workspaceMembers,
    podMembers,
    users,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  for (const [id, owner, name] of [
    [P.mine, ME, "Synap"],
    [P.second, ME, "Content"],
    [P.theirs, OTHER, "Someone else's"],
  ]) {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
       values ($1, $2, null, $3, 'active', now(), now())`,
      [id, owner, name]
    );
  }
  await goal(G.active, P.mine, "Work, done right", "active", {
    endState: "Every agent's work shows on one map.",
    criteria: [
      { key: "a", statement: "A", check: { kind: "human" } },
      { key: "b", statement: "B", check: { kind: "judge" } },
    ],
  });
  await goal(G.proposed, P.mine, "Ship the CRM", "proposed");
  await goal(G.paused, P.mine, "Old migration", "paused");
  await goal(G.closed, P.mine, "Launched", "completed");
  await goal(G.dropped, P.mine, "Abandoned", "archived");
  await goal(G.secondProject, P.second, "Twenty posts", "active");
  await goal(G.theirs, P.theirs, "Not yours", "active");
});

const goalIds = (s: Awaited<ReturnType<typeof readOpenGoals>>) =>
  "items" in s ? s.items.map((i) => i.id).sort() : s;

describe("orient startHere.openGoals", () => {
  it("pod-wide: every LIVE goal the caller can see, never a closed / dropped one or another person's", async () => {
    const s = await readOpenGoals(ME);
    expect(s).toMatchObject({
      lens: "pod",
      count: 4,
      countIsLowerBound: false,
    });
    expect(goalIds(s)).toEqual(
      [G.active, G.proposed, G.paused, G.secondProject].sort()
    );
    expect(s).toMatchObject({ howTo: expect.stringContaining("trackId") });
  });

  it("scoped to a project: only that project's open goals, with end state and criteria count", async () => {
    const s = await readOpenGoals(ME, P.second);
    expect(s).toEqual({
      count: 1,
      countIsLowerBound: false,
      lens: "project",
      items: [
        {
          id: G.secondProject,
          name: "Twenty posts",
          status: "active",
          projectId: P.second,
          endState: null,
          criteria: 0,
        },
      ],
      // The listed goals' rows, for orient's rollups (never on the wire).
      tracks: [expect.objectContaining({ id: G.secondProject })],
      howTo: expect.any(String),
    });
    const mine = await readOpenGoals(ME, P.mine);
    expect(
      "items" in mine && mine.items.find((i) => i.id === G.active)
    ).toMatchObject({
      endState: "Every agent's work shows on one map.",
      criteria: 2,
    });
  });

  it("another person's project reads as no goals, never theirs", async () => {
    expect(await readOpenGoals(ME, P.theirs)).toMatchObject({
      count: 0,
      items: [],
    });
  });

  it("a FAILED read is unavailable, never 'no goals'", async () => {
    await h.client!.exec(
      `alter table project_tracks rename to project_tracks_gone`
    );
    try {
      expect(await readOpenGoals(ME)).toEqual({ status: "unavailable" });
    } finally {
      await h.client!.exec(
        `alter table project_tracks_gone rename to project_tracks`
      );
    }
  });
});
