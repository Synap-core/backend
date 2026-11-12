/**
 * Project pillars on real SQL (PGlite) — the storage rules, the doors' floors
 * and the derived read (goals / pillars / health contract, 2026-11-12):
 *
 *   - `uses` `metadata.purpose`: set on a new edge, changed and cleared on an
 *     existing one (`linkProjectToWorkspace`);
 *   - `advances` through THE dependency door: a space the goal's project
 *     does not use is refused; at most one primary per goal; re-linking an
 *     existing edge with `primary` re-stamps only that key;
 *   - `serves` `primary`: refused on a session edge; one per goal;
 *   - goal placement: the parent becomes primary when the goal has none, the
 *     first pillar becomes primary when none is named;
 *   - the main goal: another project's goal and a closed one are refused;
 *   - `readScopeRollup` with BOTH lenses counts the intersection only;
 *   - `readGoalGroupWork`: one union — a session reached from two roots
 *     counts once, a child session spawned under a goal's session counts;
 *   - `readProjectPillars`: a contributing goal changes nothing in the
 *     pillar's health, a dropped primary goal leaves it, a paused primary
 *     goal stalls its pillar, the root is the worst pillar, and a space
 *     with no declared-lifecycle kind says so.
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
    // A goal's birth appends its events; the log is not under test here.
    EventRepository: class {
      async append() {}
    },
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle(profileId: string) {
        if (profileId !== DEAL) return null;
        return {
          propertySlug: "stage",
          options: [
            { key: "draft", category: "open" },
            { key: "negotiating", category: "active" },
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

// The goal doors' gate: a person's write is granted (governance has its own
// suites); the agent path is not exercised here.
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async () => ({ granted: true }),
  proposedMessageFor: (_t: string, fallback: string) => fallback,
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  linkProjectToWorkspace,
  unlinkProjectFromWorkspace,
} from "../../../utils/project-workspace.js";
import {
  PILLAR_NOT_USED_ERROR,
  PRIMARY_PARENT_TAKEN_ERROR,
  PRIMARY_PILLAR_TAKEN_ERROR,
  writeDependencyLink,
} from "../../links/dependency-links.js";
import {
  applyGoalPlacement,
  PARENT_OTHER_PROJECT_ERROR,
} from "../../tracks/goal-placement.js";
import {
  applyTrackDirection,
  setTrackDirection,
  startTrack,
} from "../../tracks/tracks-service.js";
import { assertMainGoal } from "../update-project.js";
import {
  readGoalGroupWork,
  readScopeMoves,
  readScopeRollup,
} from "../../status/status-rollup.js";
import {
  readProjectPillarFields,
  readProjectPillars,
} from "../pillar-health.js";

const ME = "user-me";
const W_SALES = randomUUID();
const W_BRAND = randomUUID();
const W_UNUSED = randomUUID();
const P = randomUUID();
const P_OTHER = randomUUID();
// Goals of P.
const G_RUN = randomUUID(); // active, clear — primary in Sales
const G_PAUSED = randomUUID(); // paused — primary in Brand
const G_CONTRIB = randomUUID(); // paused bet — CONTRIBUTING in Sales
const G_DROPPED = randomUUID(); // archived — primary in Sales, leaves
const G_SUB = randomUUID(); // serves G_RUN
const G_OTHER_ROOT = randomUUID(); // a second root for the union test
const G_CLOSED = randomUUID(); // completed, not met
const G_ELSEWHERE = randomUUID(); // a goal of P_OTHER
// Sessions.
const S_FILED = randomUUID(); // filed in G_RUN
const S_SUB = randomUUID(); // filed in G_SUB and serving G_RUN
const S_CHILD = randomUUID(); // spawned under S_FILED, no goal of its own
const S_SHARED = randomUUID(); // filed in G_OTHER_ROOT, serving G_RUN
const S_CONTRIB = randomUUID(); // filed in G_CONTRIB (not counted in Sales)
// Things.
const E_IN = randomUUID(); // Sales, filed into P
const E_SPACE_ONLY = randomUUID(); // Sales, not in P
const E_PROJECT_ONLY = randomUUID(); // Brand, filed into P

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

// Goals are created in fixture order, one second apart: the read lists them
// oldest first, and two goals in the same instant would order by random id.
let goalSeq = 0;
async function goal(
  id: string,
  project: string,
  name: string,
  status: string,
  more: { verdict?: string; uncertainty?: string } = {}
) {
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, verdict, uncertainty, criteria, created_at, updated_at)
     values ($1, $2, $3, $4, '{}'::jsonb, '1', $5, $6, $7, '[]'::jsonb, timestamptz '2026-01-01' + make_interval(secs => ${++goalSeq}), now())`,
    [
      id,
      project,
      ME,
      name,
      status,
      more.verdict ?? null,
      more.uncertainty ?? null,
    ]
  );
}

async function session(
  id: string,
  trackId: string | null,
  workspaceId: string
) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'Do it', 'active', 'agent', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
    [id, ME, workspaceId, P, trackId]
  );
}

async function link(
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  linkType: string,
  metadata: Record<string, unknown> = {}
) {
  await q(
    `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, null, $2, $3, $4, $5, $6, $7::jsonb, now())`,
    [
      randomUUID(),
      fromType,
      fromId,
      toType,
      toId,
      linkType,
      JSON.stringify(metadata),
    ]
  );
}

const linkRow = async (fromId: string, toId: string, linkType: string) =>
  (
    await q(
      `select metadata from links where from_id = $1 and to_id = $2 and link_type = $3`,
      [fromId, toId, linkType]
    )
  ).rows[0] as { metadata: Record<string, unknown> } | undefined;

beforeAll(async () => {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (t): t is PgTable => is(t, PgTable)
  );
  expect(tables.length).toBeGreaterThan(50);
  for (const t of tables) await client.exec(ddlFor(t));
  // The generated DDL has no unique indexes; the link doors upsert on it.
  await client.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
  );
  holder.db = drizzle(client, { schema });

  for (const [id, name] of [
    [W_SALES, "Sales"],
    [W_BRAND, "Brand"],
    [W_UNUSED, "Unused"],
  ]) {
    await q(
      `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, $3, 'personal')`,
      [id, ME, name]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), id, ME]
    );
  }
  for (const id of [P, P_OTHER]) {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
       values ($1, $2, $3, 'Project', 'active', now(), now())`,
      [id, ME, W_SALES]
    );
  }
  await link("project", P, "workspace", W_SALES, "uses", {
    purpose: "Win the first clients",
  });
  await link("project", P, "workspace", W_BRAND, "uses");

  await goal(G_RUN, P, "Win clients", "active", { uncertainty: "clear" });
  await goal(G_PAUSED, P, "Rebrand", "paused");
  await goal(G_CONTRIB, P, "Try ads", "paused", { uncertainty: "unknown" });
  await goal(G_DROPPED, P, "Old push", "archived", { verdict: "mistake" });
  await goal(G_SUB, P, "Book demos", "active");
  await goal(G_OTHER_ROOT, P, "Other root", "active");
  await goal(G_CLOSED, P, "Closed one", "completed", { verdict: "not_met" });
  await goal(G_ELSEWHERE, P_OTHER, "Elsewhere", "active");

  await link("track", G_RUN, "workspace", W_SALES, "advances", {
    primary: true,
  });
  await link("track", G_PAUSED, "workspace", W_BRAND, "advances", {
    primary: true,
  });
  await link("track", G_CONTRIB, "workspace", W_SALES, "advances");
  await link("track", G_DROPPED, "workspace", W_SALES, "advances", {
    primary: true,
  });
  await link("track", G_SUB, "track", G_RUN, "serves", { primary: true });

  await session(S_FILED, G_RUN, W_SALES);
  await session(S_SUB, G_SUB, W_SALES);
  await session(S_CHILD, null, W_SALES);
  await session(S_SHARED, G_OTHER_ROOT, W_SALES);
  await session(S_CONTRIB, G_CONTRIB, W_SALES);
  await link("session", S_SUB, "track", G_RUN, "serves");
  await link("session", S_SHARED, "track", G_RUN, "serves");
  await link("session", S_CHILD, "session", S_FILED, "spawned_from");

  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, 'deal', 'Deal', 'kind', 'workspace')`,
    [DEAL]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1, $2, true)`,
    [DEAL, randomUUID()]
  );
  for (const [id, ws, inProject, status] of [
    [E_IN, W_SALES, true, "negotiating"],
    [E_SPACE_ONLY, W_SALES, false, "negotiating"],
    [E_PROJECT_ONLY, W_BRAND, true, "draft"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, title, status, properties, created_at, updated_at)
       values ($1, $2, $3, $4, 'A deal', $5, '{}'::jsonb, now(), now())`,
      [id, ME, ws, DEAL, status]
    );
    if (inProject) {
      await q(
        `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, created_at)
         values ($1, $2, $3, $4, $5, 'belongs_to_project', now())`,
        [randomUUID(), ME, ws, id, P]
      );
    }
  }
});

describe("uses metadata.purpose — the pillar's line", () => {
  it("sets it on a new edge, changes and clears it on an existing one", async () => {
    const db = holder.db as never;
    await linkProjectToWorkspace(db, {
      projectId: P_OTHER,
      workspaceId: W_BRAND,
      userId: ME,
      purpose: "Look the part",
    });
    expect((await linkRow(P_OTHER, W_BRAND, "uses"))?.metadata).toEqual({
      purpose: "Look the part",
    });
    await linkProjectToWorkspace(db, {
      projectId: P_OTHER,
      workspaceId: W_BRAND,
      userId: ME,
      purpose: "Look sharp",
    });
    expect((await linkRow(P_OTHER, W_BRAND, "uses"))?.metadata).toEqual({
      purpose: "Look sharp",
    });
    // Absent leaves it.
    await linkProjectToWorkspace(db, {
      projectId: P_OTHER,
      workspaceId: W_BRAND,
      userId: ME,
    });
    expect((await linkRow(P_OTHER, W_BRAND, "uses"))?.metadata).toEqual({
      purpose: "Look sharp",
    });
    await linkProjectToWorkspace(db, {
      projectId: P_OTHER,
      workspaceId: W_BRAND,
      userId: ME,
      purpose: null,
    });
    expect((await linkRow(P_OTHER, W_BRAND, "uses"))?.metadata).toEqual({});
  });
});

describe("advances — through THE dependency door", () => {
  const edge = (goalId: string, ws: string) => ({
    fromType: "track",
    fromId: goalId,
    toType: "workspace",
    toId: ws,
    linkType: "advances" as const,
  });

  it("refuses a space the goal's project does not use, writing nothing", async () => {
    const r = await writeDependencyLink({
      edge: edge(G_SUB, W_UNUSED),
      userId: ME,
    });
    expect(r).toMatchObject({ ok: false, error: PILLAR_NOT_USED_ERROR });
    expect(await linkRow(G_SUB, W_UNUSED, "advances")).toBeUndefined();
  });

  it("allows one primary per goal, and re-stamps primary on an existing edge", async () => {
    // G_RUN is primary in Sales already: a second primary is refused.
    const second = await writeDependencyLink({
      edge: edge(G_RUN, W_BRAND),
      userId: ME,
      metadata: { primary: true },
    });
    expect(second).toMatchObject({
      ok: false,
      error: PRIMARY_PILLAR_TAKEN_ERROR,
    });
    expect(await linkRow(G_RUN, W_BRAND, "advances")).toBeUndefined();
    // As non-primary it lands; then demote Sales and promote Brand.
    expect(
      await writeDependencyLink({ edge: edge(G_RUN, W_BRAND), userId: ME })
    ).toMatchObject({ ok: true, inserted: 1 });
    expect(
      await writeDependencyLink({
        edge: edge(G_RUN, W_SALES),
        userId: ME,
        metadata: { primary: false },
      })
    ).toMatchObject({ ok: true, inserted: 0 });
    expect(
      await writeDependencyLink({
        edge: edge(G_RUN, W_BRAND),
        userId: ME,
        metadata: { primary: true },
      })
    ).toMatchObject({ ok: true, inserted: 0 });
    expect((await linkRow(G_RUN, W_BRAND, "advances"))?.metadata).toEqual({
      primary: true,
    });
    expect((await linkRow(G_RUN, W_SALES, "advances"))?.metadata).toEqual({
      primary: false,
    });
    // Put it back the way the read tests expect.
    await q(
      `delete from links where from_id = $1 and to_id = $2 and link_type = 'advances'`,
      [G_RUN, W_BRAND]
    );
    await q(
      `update links set metadata = '{"primary": true}'::jsonb where from_id = $1 and to_id = $2 and link_type = 'advances'`,
      [G_RUN, W_SALES]
    );
  });
});

describe("serves primary — a goal's primary parent", () => {
  it("is refused on a session edge", async () => {
    const r = await writeDependencyLink({
      edge: {
        fromType: "session",
        fromId: S_FILED,
        toType: "track",
        toId: G_OTHER_ROOT,
        linkType: "serves",
      },
      userId: ME,
      metadata: { primary: true },
    });
    expect(r).toMatchObject({ ok: false });
  });

  it("is one per goal", async () => {
    // G_SUB's primary parent is G_RUN: a second primary parent is refused.
    const r = await writeDependencyLink({
      edge: {
        fromType: "track",
        fromId: G_SUB,
        toType: "track",
        toId: G_OTHER_ROOT,
        linkType: "serves",
      },
      userId: ME,
      metadata: { primary: true },
    });
    expect(r).toMatchObject({ ok: false, error: PRIMARY_PARENT_TAKEN_ERROR });
  });
});

describe("goal placement — where a goal sits", () => {
  it("makes the parent primary when the goal has none, the second not", async () => {
    const g = randomUUID();
    await goal(g, P, "Placed", "active");
    await applyGoalPlacement({
      trackId: g,
      input: { parentGoalId: G_OTHER_ROOT },
      userId: ME,
    });
    await applyGoalPlacement({
      trackId: g,
      input: { parentGoalId: G_RUN },
      userId: ME,
    });
    expect((await linkRow(g, G_OTHER_ROOT, "serves"))?.metadata).toEqual({
      primary: true,
    });
    expect((await linkRow(g, G_RUN, "serves"))?.metadata).toEqual({});
  });

  it("makes the first pillar primary when none is named; the list replaces; refuses an unused space", async () => {
    const g = randomUUID();
    await goal(g, P, "Placed pillars", "active");
    await applyGoalPlacement({
      trackId: g,
      input: {
        pillars: [{ workspaceId: W_BRAND }, { workspaceId: W_SALES }],
      },
      userId: ME,
    });
    expect((await linkRow(g, W_BRAND, "advances"))?.metadata).toEqual({
      primary: true,
    });
    expect((await linkRow(g, W_SALES, "advances"))?.metadata).toEqual({
      primary: false,
    });
    // Rules out "pillars are added": the list is the whole set.
    await applyGoalPlacement({
      trackId: g,
      input: { pillars: [{ workspaceId: W_SALES }] },
      userId: ME,
    });
    expect(await linkRow(g, W_BRAND, "advances")).toBeUndefined();
    expect((await linkRow(g, W_SALES, "advances"))?.metadata).toEqual({
      primary: true,
    });
    await applyGoalPlacement({
      trackId: g,
      input: { pillars: [] },
      userId: ME,
    });
    expect(await linkRow(g, W_SALES, "advances")).toBeUndefined();
    await expect(
      applyGoalPlacement({
        trackId: g,
        input: { pillars: [{ workspaceId: W_UNUSED }] },
        userId: ME,
      })
    ).rejects.toThrow(PILLAR_NOT_USED_ERROR);
    await q(`delete from links where from_id = $1`, [g]);
  });
});

describe("the goal doors carry the placement", () => {
  // Rules out "a refused placement still writes the goal's columns": G_SUB
  // serves G_RUN, so G_RUN serving G_SUB would close a loop.
  it("an update whose placement is refused changes nothing", async () => {
    const before = await q(
      `select direction from project_tracks where id = $1`,
      [G_RUN]
    );
    await expect(
      setTrackDirection({
        trackId: G_RUN,
        direction: "A new heading",
        parentGoalId: G_SUB,
        actor: { userId: ME },
      })
    ).rejects.toThrow();
    const after = await q(
      `select direction from project_tracks where id = $1`,
      [G_RUN]
    );
    expect(after.rows).toEqual(before.rows);
    expect(await linkRow(G_RUN, G_SUB, "serves")).toBeUndefined();
  });

  // The same on the replay path (an approved proposal): the placement is
  // re-checked before the columns are written.
  it("an approved update whose placement is now refused changes nothing", async () => {
    const before = await q(
      `select direction from project_tracks where id = $1`,
      [G_RUN]
    );
    const track = (
      await q(`select * from project_tracks where id = $1`, [G_RUN])
    ).rows[0];
    const project = (await q(`select * from projects where id = $1`, [P]))
      .rows[0];
    const camel = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()),
          v,
        ])
      );
    await expect(
      applyTrackDirection(
        camel(track as Record<string, unknown>) as never,
        camel(project as Record<string, unknown>) as never,
        { direction: "Replayed heading", parentGoalId: G_SUB },
        { userId: ME }
      )
    ).rejects.toThrow();
    const after = await q(
      `select direction from project_tracks where id = $1`,
      [G_RUN]
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("refuses a parent goal of another project before anything is started", async () => {
    await expect(
      startTrack({
        projectId: P,
        name: "Wrong parent",
        parentGoalId: G_ELSEWHERE,
        actor: { userId: ME },
      })
    ).rejects.toThrow(PARENT_OTHER_PROJECT_ERROR);
    const born = await q(
      `select id from project_tracks where name = 'Wrong parent'`
    );
    expect(born.rows).toHaveLength(0);
  });

  it("a person's start writes the parent and the pillars with the goal", async () => {
    const started = await startTrack({
      projectId: P,
      name: "Born placed",
      parentGoalId: G_OTHER_ROOT,
      pillars: [
        { workspaceId: W_SALES },
        { workspaceId: W_BRAND, primary: true },
      ],
      actor: { userId: ME },
    });
    expect(started.status).toBe("started");
    const id = (started as { track: { id: string } }).track.id;
    expect((await linkRow(id, G_OTHER_ROOT, "serves"))?.metadata).toEqual({
      primary: true,
    });
    expect((await linkRow(id, W_BRAND, "advances"))?.metadata).toEqual({
      primary: true,
    });
    expect((await linkRow(id, W_SALES, "advances"))?.metadata).toEqual({
      primary: false,
    });
    // An update that only places the goal moves the primary pillar.
    const updated = await setTrackDirection({
      trackId: id,
      pillars: [
        { workspaceId: W_BRAND, primary: false },
        { workspaceId: W_SALES, primary: true },
      ],
      actor: { userId: ME },
    });
    expect(updated.status).toBe("updated");
    expect((await linkRow(id, W_SALES, "advances"))?.metadata).toEqual({
      primary: true,
    });
    expect((await linkRow(id, W_BRAND, "advances"))?.metadata).toEqual({
      primary: false,
    });
    await q(`delete from links where from_id = $1`, [id]);
    await q(
      `update project_tracks set status = 'archived', verdict = 'mistake' where id = $1`,
      [id]
    );
  });

  it("refuses an unused space BEFORE anything is started", async () => {
    await expect(
      startTrack({
        projectId: P,
        name: "Never born",
        pillars: [{ workspaceId: W_UNUSED }],
        actor: { userId: ME },
      })
    ).rejects.toThrow(PILLAR_NOT_USED_ERROR);
    const born = await q(
      `select id from project_tracks where name = 'Never born'`
    );
    expect(born.rows).toHaveLength(0);
  });
});

describe("the main goal", () => {
  it("must be one of the project's own live goals", async () => {
    await expect(assertMainGoal(P, G_RUN, ME)).resolves.toMatchObject({
      id: G_RUN,
    });
    await expect(assertMainGoal(P, G_ELSEWHERE, ME)).rejects.toThrow(
      /this project's own goals/
    );
    await expect(assertMainGoal(P, G_CLOSED, ME)).rejects.toThrow(
      /closed or dropped/
    );
  });
});

describe("readScopeRollup with both lenses — the pillar", () => {
  it("counts the project INSIDE the space only", async () => {
    const r = await readScopeRollup({
      userId: ME,
      projectId: P,
      workspaceId: W_SALES,
      byKind: true,
    });
    // E_IN only: not E_SPACE_ONLY (no project), not E_PROJECT_ONLY (Brand).
    expect(r).toMatchObject({
      lens: "pillar",
      id: P,
      workspaceId: W_SALES,
      things: { active: 1 },
      kinds: [{ kind: "deal", byCategory: { active: 1 }, stuck: 0 }],
    });
    // Each lens alone sees more: the intersection is not one of them.
    const space = await readScopeRollup({ userId: ME, workspaceId: W_SALES });
    const project = await readScopeRollup({ userId: ME, projectId: P });
    expect(space?.things).toEqual({ active: 2 });
    expect(project?.things).toEqual({ active: 1, open: 1 });
    expect(space?.kinds).toBeUndefined();
  });
});

describe("readGoalGroupWork — one union", () => {
  it("counts a session reached from two roots once, and a spawned child", async () => {
    // G_RUN's tree: S_FILED, S_SUB (filed in G_SUB, serving G_RUN), S_SHARED
    // (serving G_RUN), S_CHILD (spawned under S_FILED). G_OTHER_ROOT's tree
    // adds nothing new (S_SHARED again).
    const one = await readGoalGroupWork(ME, [G_RUN]);
    const both = await readGoalGroupWork(ME, [G_RUN, G_OTHER_ROOT]);
    expect(one.sessions).toBe(4);
    expect(both.sessions).toBe(4);
    // Summing the roots would have said 5.
    const other = await readGoalGroupWork(ME, [G_OTHER_ROOT]);
    expect(other.sessions).toBe(1);
  });
});

describe("readProjectPillars — the derived read", () => {
  it("rolls primary goals up, lists contributing ones without counting them", async () => {
    const read = await readProjectPillars(ME, P);
    expect(read).not.toBeNull();
    const sales = read!.pillars.find((p) => p.workspaceId === W_SALES)!;
    const brand = read!.pillars.find((p) => p.workspaceId === W_BRAND)!;
    expect(sales).toMatchObject({
      workspaceName: "Sales",
      purpose: "Win the first clients",
      isLinked: true,
      // G_CONTRIB (paused, a bet) is contributing: it does NOT make Sales
      // needs_attention; G_DROPPED left the roll-up.
      health: {
        state: "moving",
        counts: { open: 1, paused: 0, bet: 0, validated: 0 },
        sessions: 4,
      },
      indicator: {
        declared: true,
        kinds: [
          {
            kind: "deal",
            byCategory: { open: 0, active: 1, paused: 0, done: 0, lost: 0 },
            stuck: 0,
          },
        ],
      },
    });
    expect(sales.goals.map((g) => [g.goalId, g.role, g.isBet])).toEqual([
      [G_RUN, "primary", false],
      [G_CONTRIB, "contributing", true],
    ]);
    expect(brand).toMatchObject({
      purpose: null,
      health: { state: "stalled", counts: { paused: 1, open: 0 } },
    });
    expect(read!.rootHealth).toEqual({
      state: "stalled",
      pillarsMoving: 1,
      pillarsTotal: 2,
      pillarsEmpty: 0,
    });
    expect(read!.mainGoal).toBeNull();
  });

  it("a pillar with no declared-lifecycle kind says so; a main goal is read", async () => {
    await q(`update projects set main_goal_id = $1 where id = $2`, [G_RUN, P]);
    await q(`delete from entities where id = $1`, [E_PROJECT_ONLY]);
    const read = await readProjectPillars(ME, P);
    const brand = read!.pillars.find((p) => p.workspaceId === W_BRAND)!;
    expect(brand.indicator).toEqual({ declared: false, kinds: [] });
    expect(read!.mainGoal).toEqual({
      id: G_RUN,
      name: "Win clients",
      status: "active",
    });
  });

  it("another user's project is null, never empty pillars", async () => {
    expect(await readProjectPillars("user-stranger", P)).toBeNull();
  });
});

describe("a sub-goal with two parents counts in one pillar", () => {
  // Rules out "the pillar walk follows every serves edge": G_SUB (with its
  // session S_SUB) serves G_RUN (primary, Sales) AND G_PAUSED (non-primary,
  // Brand). Its sessions count once, in Sales only.
  it("walks primary parent edges only", async () => {
    await link("track", G_SUB, "track", G_PAUSED, "serves");
    try {
      const read = await readProjectPillars(ME, P);
      const sales = read!.pillars.find((p) => p.workspaceId === W_SALES)!;
      const brand = read!.pillars.find((p) => p.workspaceId === W_BRAND)!;
      expect(sales.health.sessions).toBe(4);
      expect(brand.health.sessions).toBe(0);
      // The default walk (goal page, orient) still lists it under both.
      expect((await readGoalGroupWork(ME, [G_PAUSED])).sessions).toBe(1);
    } finally {
      await q(
        `delete from links where from_id = $1 and to_id = $2 and link_type = 'serves'`,
        [G_SUB, G_PAUSED]
      );
    }
  });
});

describe("a space the project stops using is no pillar any more", () => {
  // Rules out "unlinking a space leaves the goals' advances edges behind":
  // a stale primary pillar would then block naming a new one.
  it("removing the uses edge removes the goals' advances to it; a new primary lands", async () => {
    const g = randomUUID();
    await goal(g, P, "Brand push", "active");
    await link("track", g, "workspace", W_BRAND, "advances", { primary: true });
    const r = await unlinkProjectFromWorkspace(holder.db as never, {
      projectId: P,
      workspaceId: W_BRAND,
      userId: ME,
    });
    expect(r).toEqual({ unlinked: true, rows: 1 });
    try {
      expect(await linkRow(g, W_BRAND, "advances")).toBeUndefined();
      expect(await linkRow(G_PAUSED, W_BRAND, "advances")).toBeUndefined();
      await applyGoalPlacement({
        trackId: g,
        input: { pillars: [{ workspaceId: W_SALES, primary: true }] },
        userId: ME,
      });
      expect((await linkRow(g, W_SALES, "advances"))?.metadata).toEqual({
        primary: true,
      });
    } finally {
      await q(`delete from links where from_id = $1`, [g]);
      await q(
        `update project_tracks set status = 'archived', verdict = 'mistake' where id = $1`,
        [g]
      );
      await link("project", P, "workspace", W_BRAND, "uses");
      await link("track", G_PAUSED, "workspace", W_BRAND, "advances", {
        primary: true,
      });
    }
  });

  // Rules out "any primary advances edge counts": an edge left to a space the
  // project does not use (written before this rule) is no primary pillar.
  it("a primary edge to an unused space does not count as the goal's primary", async () => {
    const g = randomUUID();
    await goal(g, P, "Stale pillar", "active");
    await link("track", g, "workspace", W_UNUSED, "advances", {
      primary: true,
    });
    try {
      expect(
        await writeDependencyLink({
          edge: {
            fromType: "track",
            fromId: g,
            toType: "workspace",
            toId: W_SALES,
            linkType: "advances",
          },
          userId: ME,
          metadata: { primary: true },
        })
      ).toMatchObject({ ok: true, inserted: 1 });
    } finally {
      await q(`delete from links where from_id = $1`, [g]);
      await q(
        `update project_tracks set status = 'archived', verdict = 'mistake' where id = $1`,
        [g]
      );
    }
  });
});

describe("the lean scope read agrees with the full one", () => {
  // Rules out "the pillar read counts moves or kinds its own way": the lean
  // read must give exactly what readScopeRollup gives for those two parts.
  it("gives the same moved and kinds, for a pillar and for a project", async () => {
    await q(
      `insert into events (id, type, subject_id, subject_type, data, user_id, timestamp)
       values ($1, 'entity.transition.completed', $2, 'entity', '{}'::jsonb, $3, now())`,
      [randomUUID(), E_IN, ME]
    );
    // A move of a goal of P that advances Brand, not Sales: in the project's
    // count, never in the Sales pillar's.
    await q(
      `insert into events (id, type, subject_id, subject_type, data, user_id, timestamp)
       values ($1, 'track.transition.completed', $2, 'track', '{}'::jsonb, $3, now())`,
      [randomUUID(), G_PAUSED, ME]
    );
    for (const scope of [
      { projectId: P, workspaceId: W_SALES },
      { projectId: P },
      { workspaceId: W_SALES },
    ]) {
      const full = await readScopeRollup({
        userId: ME,
        ...scope,
        byKind: true,
      });
      const lean = await readScopeMoves({ userId: ME, ...scope });
      expect(lean).toEqual({ moved: full!.moved, kinds: full!.kinds });
    }
    // Non-vacuity: the pillar scope saw the move and the kind.
    const pillar = await readScopeMoves({
      userId: ME,
      projectId: P,
      workspaceId: W_SALES,
    });
    expect(pillar.moved).toBe(1);
    expect((await readScopeMoves({ userId: ME, projectId: P })).moved).toBe(2);
    expect(pillar.kinds.map((k) => k.kind)).toEqual(["deal"]);
  });
});

describe("a failed part of the project read is marked, never empty", () => {
  // Rules out "a failed pillar read answers [] / a failed main goal answers
  // null": each part fails on its own and says so; the other part stands.
  it("marks the failed part unavailable and keeps the other", async () => {
    await q(`update projects set main_goal_id = $1 where id = $2`, [G_RUN, P]);
    await q(`alter table links rename to links_gone`);
    try {
      const fields = await readProjectPillarFields(ME, P);
      expect(fields.pillars).toEqual({ status: "unavailable" });
      expect(fields.rootHealth).toEqual({ status: "unavailable" });
      expect(fields.mainGoal).toEqual({
        id: G_RUN,
        name: "Win clients",
        status: "active",
      });
    } finally {
      await q(`alter table links_gone rename to links`);
    }
    await q(`alter table project_tracks rename to project_tracks_gone`);
    try {
      const fields = await readProjectPillarFields(ME, P);
      expect(fields.mainGoal).toEqual({ status: "unavailable" });
      expect(fields.pillars).toEqual({ status: "unavailable" });
    } finally {
      await q(`alter table project_tracks_gone rename to project_tracks`);
    }
  });
});

describe("projects.get carries the pillars only when asked", () => {
  // Rules out "every project read pays for the pillars" and "include is
  // ignored": the tRPC read adds the three fields with include ["pillars"]
  // only.
  it("include: [pillars] adds mainGoal, pillars and rootHealth", async () => {
    const { projectsRouter } = await import("../../../routers/projects.js");
    const caller = projectsRouter.createCaller({
      authenticated: true,
      userId: ME,
      workspaceId: null,
    } as never);
    const plain = (await caller.get({ id: P })) as Record<string, unknown>;
    expect(plain).not.toHaveProperty("pillars");
    expect(plain).not.toHaveProperty("mainGoal");
    const asked = (await caller.get({
      id: P,
      include: ["pillars"],
    })) as Record<string, unknown>;
    expect(Array.isArray(asked.pillars)).toBe(true);
    expect((asked.pillars as unknown[]).length).toBe(2);
    expect(asked).toHaveProperty("rootHealth.pillarsTotal", 2);
    expect(asked).toHaveProperty("mainGoal");
  });
});
