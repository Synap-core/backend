/**
 * The status read and the rollups (status-flow W0b) on real SQL (PGlite):
 *
 *   - `readStatusOf`: an entity's status, words, category and tone; since =
 *     its last transition, else its creation, said as NOT measured; stuck
 *     only past its step's `stuckAfterDays`; a goal's and a session's since
 *     from their own transitions; a session's owed slot is what it waits on;
 *     an id the caller cannot see, or that is not a uuid, is `unknown`;
 *   - a step that DECLARES a wait (`waits`) is what its thing waits on, its
 *     `refFrom` thing named only when the reader may read it; `include:
 *     ["moves"]` lists the moves its step offers, and nothing else does;
 *   - `readGoalRollups`: a goal's sessions per category, its moves this
 *     week, what it waits on;
 *   - `readScopeRollup`: a space's things per category, its stuck things
 *     (named), its work, its moves; another person's project is `null`;
 *   - `withGoalRollups`: a failed rollup read is `unavailable`, never zeros;
 *   - goal rollups follow `serves`: a session filed in AND serving a goal
 *     counts once there, a serving session counts, a sub-goal is a child;
 *   - a thing's `roles` (only those the reader may see) and its `account`
 *     line (the account it works at, when the reader may read it);
 *   - `include`: `history` (THE timeline, kept to status events; a hidden
 *     role's move left out), `links` (`serves` both ways, a hidden end left
 *     out), `rollup` (a goal's tree: each session and goal once, a loop cut
 *     and named, stuck and waits per kind), `signals` (only open episodes).
 *
 * Only `getEffectiveLifecycle` is stubbed (its own suites prove it).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
const DEAL = "11111111-1111-4111-8111-111111111111";
const LEAD = "44444444-4444-4444-8444-444444444444";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle(profileId: string) {
        if (profileId === LEAD) {
          return {
            propertySlug: "leadStage",
            options: [
              { key: "new", category: "open" },
              { key: "talking", category: "active", label: "In talks" },
              { key: "parked", category: "paused" },
            ],
            unclassified: [],
          };
        }
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
            {
              key: "sent",
              category: "active",
              label: "Proposal sent",
              waits: {
                on: "person",
                waitKind: "their_reply",
                refFrom: "contactId",
              },
            },
            { key: "won", category: "done" },
            // A pause that declares a wait of its own: its hold names it first.
            { key: "on_hold", category: "paused", waits: { on: "date" } },
            { key: "lost", category: "lost", humanOnly: true },
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
import { readStatusOf, type StatusOf } from "../status-read.js";
import { LIFECYCLE_CATEGORY_TONE } from "@synap-core/types/lifecycle";
import {
  STATUS_HISTORY_EVENT_KINDS,
  resolveStatusTone,
} from "@synap-core/types/units";
import { closesDependencyCycle } from "../../links/dependency-links.js";
import { resolveWaitingOnReasonLabel } from "@synap-core/types/vocabulary";
import { listOpenGoalTracks } from "../../discover/open-goals.js";
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
const E_PLAIN = randomUUID();
const G_QUIET = randomUUID();
const G_THEIRS = randomUUID();
const S_THEIRS = randomUUID();
const NOTE = "33333333-3333-4333-8333-333333333333";
const PERSON = randomUUID();
// Two deals in a step that waits on their contact: mine, and another
// person's contact I may not read. Pod-personal, so no space counts them.
const E_SENT = randomUUID();
const E_SENT_HIDDEN = randomUUID();
const C_MINE = randomUUID();
const C_THEIRS = randomUUID();
// A deal paused on a hold, in a pause that declares a wait of its own.
const E_HELD = randomUUID();

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
  for (const [id, project, owner] of [
    [G_QUIET, P, ME],
    [G_THEIRS, P_THEIRS, OTHER],
  ]) {
    await q(
      `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
       values ($1, $2, $3, 'Goal', '{}'::jsonb, '1', 'active', '[]'::jsonb, now(), now())`,
      [id, project, owner]
    );
  }
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
  for (const [id, status, outputs, owner] of [
    [S_ACTIVE, "active", owed, ME],
    [S_CLOSED, "closed", [], ME],
    [S_THEIRS, "active", [], OTHER],
  ] as const) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, goal, status, origin, expected_outputs, metadata, started_at, closed_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'Do it', $6, 'agent', $7::jsonb, '{}'::jsonb, ${ago(5)}, $8, now(), now())`,
      [
        id,
        owner,
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
  // Another person's session, in their own project.
  await q(
    `update focus_sessions set track_id = null, project_id = $1 where id = $2`,
    [P_THEIRS, S_THEIRS]
  );
  // A kind with no declared lifecycle: its status has no category.
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, title, status, properties, created_at, updated_at)
     values ($1, $2, $3, $4, 'A note', 'draft', '{}'::jsonb, now(), now())`,
    [E_PLAIN, ME, W, NOTE]
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
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, 'person', 'Person', 'kind', 'workspace')`,
    [PERSON]
  );
  for (const [id, owner, title] of [
    [C_MINE, ME, "Ada Lovelace"],
    [C_THEIRS, OTHER, "Their secret client"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, title, properties, created_at, updated_at)
       values ($1, $2, null, $3, $4, '{}'::jsonb, now(), now())`,
      [id, owner, PERSON, title]
    );
  }
  for (const [id, contact] of [
    [E_SENT, C_MINE],
    [E_SENT_HIDDEN, C_THEIRS],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, title, status, status_category, properties, created_at, updated_at)
       values ($1, $2, null, $3, 'A deal', 'sent', 'active', $4::jsonb, now(), now())`,
      [id, ME, DEAL, JSON.stringify({ stage: "sent", contactId: contact })]
    );
  }
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, title, status, status_category, properties, created_at, updated_at)
     values ($1, $2, null, $3, 'A held deal', 'on_hold', 'paused', '{}'::jsonb, now(), now())`,
    [E_HELD, ME, DEAL]
  );
  const heldSince = new Date().toISOString();
  await q(
    `insert into lifecycle_transition_outbox (transition_id, transition, created_at) values ($1, $2::jsonb, now())`,
    [
      randomUUID(),
      JSON.stringify({
        transitionId: randomUUID(),
        subjectType: "entity",
        subjectId: E_HELD,
        to: "on_hold",
        category: "paused",
        userId: ME,
        workspaceId: null,
        recordedAt: heldSince,
        hold: { on: "external", resumeTo: "sent", since: heldSince },
      }),
    ]
  );
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
      G_THEIRS,
      S_THEIRS,
      E_PLAIN,
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

    expect(by.get(E_PLAIN)).toMatchObject({
      type: "entity",
      status: "draft",
      category: null,
    });
    // Another person's thing, goal and session read as not there at all.
    for (const id of [E_THEIRS, G_THEIRS, S_THEIRS]) {
      expect(by.get(id)).toEqual({ id, type: "unknown" });
    }
    expect(by.get("not-an-id")).toEqual({ id: "not-an-id", type: "unknown" });
    expect(out).toHaveLength(10);
  });
});

describe("readStatusOf: a step that waits, its tone, its moves", () => {
  it("a step's declared wait is what the thing waits on, its contact named", async () => {
    const [sent] = await readStatusOf(ME, [E_SENT]);
    expect(sent).toMatchObject({
      type: "entity",
      status: "sent",
      label: "Proposal sent",
      category: "active",
      tone: LIFECYCLE_CATEGORY_TONE.active,
      waitingOn: [
        {
          reason: "input",
          count: 1,
          refs: [
            {
              kind: "person",
              id: C_MINE,
              label: "Ada Lovelace",
              waitKind: "their_reply",
            },
          ],
        },
      ],
    });
    // No include: no moves.
    expect(sent).not.toHaveProperty("moves");
  });

  it("a contact the reader may not read is counted, never named", async () => {
    const [hidden] = await readStatusOf(ME, [E_SENT_HIDDEN]);
    expect(hidden).toMatchObject({
      type: "entity",
      waitingOn: [
        {
          reason: "input",
          count: 1,
          refs: [
            {
              kind: "thing",
              label: resolveWaitingOnReasonLabel("input"),
              waitKind: "their_reply",
            },
          ],
        },
      ],
    });
    const said = JSON.stringify(hidden);
    expect(said).not.toContain(C_THEIRS);
    expect(said).not.toContain("Their secret client");
  });

  it("a thing held in a pause waits on its hold, not on the step's own wait", async () => {
    const [held] = await readStatusOf(ME, [E_HELD]);
    expect(held).toMatchObject({
      category: "paused",
      tone: LIFECYCLE_CATEGORY_TONE.paused,
      hold: { on: "external" },
      waitingOn: [{ reason: "external", count: 1 }],
    });
  });

  it("every answer carries its tone: the option's, else the status word's", async () => {
    const out = await readStatusOf(ME, [E_STUCK, E_PLAIN, G, S_ACTIVE]);
    const by = new Map(out.map((a) => [a.id, a]));
    expect(by.get(E_STUCK)).toMatchObject({
      tone: LIFECYCLE_CATEGORY_TONE.active,
    });
    expect(by.get(E_PLAIN)).toMatchObject({ tone: resolveStatusTone("draft") });
    expect(by.get(G)).toMatchObject({ tone: resolveStatusTone("active") });
    expect(by.get(S_ACTIVE)).toMatchObject({
      tone: resolveStatusTone("active"),
    });
  });

  it('include: ["moves"] lists the moves its step offers, a pause needing a hold', async () => {
    const out = await readStatusOf(ME, [E_SENT, E_PLAIN, G], {
      include: ["moves"],
    });
    const by = new Map(out.map((a) => [a.id, a]));
    const sent = by.get(E_SENT);
    expect(sent && "moves" in sent ? sent.moves : null).toEqual([
      {
        to: "draft",
        label: expect.any(String),
        humanOnly: false,
        needsHold: false,
      },
      {
        to: "negotiating",
        label: "In talks",
        humanOnly: false,
        needsHold: false,
      },
      {
        to: "won",
        label: expect.any(String),
        humanOnly: false,
        needsHold: false,
      },
      {
        to: "on_hold",
        label: expect.any(String),
        humanOnly: false,
        needsHold: true,
      },
      {
        to: "lost",
        label: expect.any(String),
        humanOnly: true,
        needsHold: false,
      },
    ]);
    // No declared lifecycle (a note), or not a thing (a goal): no moves.
    expect(by.get(E_PLAIN)).not.toHaveProperty("moves");
    expect(by.get(G)).not.toHaveProperty("moves");
  });
});

describe("rollups", () => {
  it("a goal: its sessions per category, its moves this week, what it waits on", async () => {
    const tracks = await listOpenGoalTracks({ userId: ME, limit: 20 });
    // The caller's own goals come first; another person's are not seen.
    expect(tracks.map((t) => t.id).sort()).toEqual([G, G_QUIET].sort());
    const rollups = await readGoalRollups(ME, tracks);
    const rollup = rollups.get(G);
    expect(rollup).toMatchObject({
      sinceMeasured: true,
      work: { active: 1, done: 1 },
      // The goal's own move and its closed session's; the 30-day-old one is out.
      moved: 2,
    });
    expect(rollup?.waitingOn).toContainEqual(
      expect.objectContaining({ reason: "input", count: 1 })
    );
    // A quiet goal costs one line: nothing empty is sent.
    expect(rollups.get(G_QUIET)).toEqual({
      since: expect.any(String),
      sinceMeasured: false,
    });
  });

  it("a space: things per category, the stuck ones named, its work and moves", async () => {
    const r = await readScopeRollup({ userId: ME, workspaceId: W });
    expect(r).toMatchObject({
      lens: "workspace",
      id: W,
      things: { active: 2 },
      // S_THEIRS (another person's session in this space) is not counted.
      work: { active: 1, done: 1 },
      // E_MOVED and S_CLOSED; the goal moves in no space.
      moved: 2,
      stuck: {
        count: 1,
        items: [{ id: E_STUCK, kind: "deal", status: "negotiating" }],
      },
    });
    expect(r?.waitingOn).toContainEqual(
      expect.objectContaining({ reason: "input", count: 1 })
    );
  });

  it("a project: its work, its goals' and sessions' moves, what waits", async () => {
    const r = await readScopeRollup({ userId: ME, projectId: P });
    expect(r).toMatchObject({
      lens: "project",
      id: P,
      work: { active: 1, done: 1 },
      // The goal's move and S_CLOSED's; no thing is filed into the project.
      moved: 2,
      stuck: { count: 0, items: [] },
    });
    expect(r?.waitingOn).toContainEqual(
      expect.objectContaining({ reason: "input", count: 1 })
    );
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
      tracks: (await listOpenGoalTracks({ userId: ME, limit: 20 })).filter(
        (t) => t.id === G
      ),
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

describe("goal rollups follow `serves`", () => {
  const G_PARENT = randomUUID();
  const G_CHILD = randomUUID();
  const S_BOTH = randomUUID(); // filed in G_PARENT AND serving it
  const S_SERVING = randomUUID(); // filed in G_CHILD, serving G_PARENT

  async function serves(fromType: string, fromId: string, toId: string) {
    await q(
      `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_by, created_at)
       values ($1, null, $2, $3, 'track', $4, 'serves', '{}'::jsonb, $5, now())`,
      [randomUUID(), fromType, fromId, toId, ME]
    );
  }

  beforeAll(async () => {
    for (const [id, name] of [
      [G_PARENT, "Launch"],
      [G_CHILD, "Pricing page"],
    ]) {
      await q(
        `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
         values ($1, $2, $3, $4, '{}'::jsonb, '1', 'active', '[]'::jsonb, now(), now())`,
        [id, P, ME, name]
      );
    }
    for (const [id, goal] of [
      [S_BOTH, G_PARENT],
      [S_SERVING, G_CHILD],
    ]) {
      await q(
        `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'Do it', 'active', 'agent', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
        [id, ME, W, P, goal]
      );
    }
    await serves("session", S_BOTH, G_PARENT);
    await serves("session", S_SERVING, G_PARENT);
    await serves("track", G_CHILD, G_PARENT);
    // One move of S_BOTH: reached through BOTH its filing and its edge.
    await transition(
      "focus_session",
      S_BOTH,
      "focus_session.transition.completed",
      1,
      { trackId: G_PARENT, projectId: P }
    );
  });

  it("a session filed in AND serving a goal counts once; a serving one counts; a sub-goal is a child", async () => {
    const tracks = (await listOpenGoalTracks({ userId: ME, limit: 50 })).filter(
      (t) => t.id === G_PARENT || t.id === G_CHILD
    );
    expect(tracks).toHaveLength(2);
    const rollups = await readGoalRollups(ME, tracks);

    expect(rollups.get(G_PARENT)).toMatchObject({
      // S_BOTH once (not twice), plus S_SERVING, which is filed elsewhere.
      work: { active: 2 },
      // S_BOTH's one move, counted once.
      moved: 1,
      children: [G_CHILD],
    });
    // The sub-goal keeps its own filed session, and has no children.
    const child = rollups.get(G_CHILD);
    expect(child).toMatchObject({ work: { active: 1 } });
    expect(child).not.toHaveProperty("children");
    expect(child).not.toHaveProperty("moved");
  });
});

/** The one answer for `id`, as a status (fails on `unknown`). */
async function statusOf(
  id: string,
  include?: Parameters<typeof readStatusOf>[2]
): Promise<StatusOf> {
  const [a] = await readStatusOf(ME, [id], include);
  if (!a || a.type === "unknown") throw new Error(`${id} read as unknown`);
  return a as StatusOf;
}

async function outbox(t: Record<string, unknown>) {
  const at = new Date().toISOString();
  await q(
    `insert into lifecycle_transition_outbox (transition_id, transition, created_at) values ($1, $2::jsonb, now())`,
    [
      (t.transitionId as string | undefined) ?? randomUUID(),
      JSON.stringify({
        transitionId: randomUUID(),
        userId: ME,
        workspaceId: null,
        actorKind: "human",
        recordedAt: at,
        occurredAt: at,
        ...t,
      }),
    ]
  );
}

describe("a thing's roles and its account line", () => {
  const E_ROLE = randomUUID();
  const F_LEAD = randomUUID();
  const F_HIDDEN = randomUUID();
  const SECRET = randomUUID();
  const COMPANY = randomUUID();
  const E_PERSON = randomUUID();
  const E_PERSON_2 = randomUUID();
  const E_ACME = randomUUID();
  const E_THEIR_CO = randomUUID();
  const E_PERSON_3 = randomUUID();
  const F_ACME_LEAD = randomUUID();

  beforeAll(async () => {
    for (const [id, slug, name] of [
      [LEAD, "lead", "Lead"],
      [SECRET, "secret-role", "Secret role"],
    ]) {
      await q(
        `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, $2, $3, 'role', 'workspace')`,
        [id, slug, name]
      );
    }
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, 'company', 'Company', 'kind', 'workspace')`,
      [COMPANY]
    );
    for (const [id, owner, ws, profile, title] of [
      [E_ROLE, ME, W, PERSON, "Grace Hopper"],
      [E_PERSON, ME, W, PERSON, "Ada"],
      [E_PERSON_2, ME, W, PERSON, "Linus"],
      [E_PERSON_3, ME, W, PERSON, "Margaret"],
      [E_ACME, ME, W, COMPANY, "Acme"],
      [E_THEIR_CO, OTHER, null, COMPANY, "Their company"],
    ] as const) {
      await q(
        `insert into entities (id, user_id, workspace_id, profile_id, title, properties, created_at, updated_at)
         values ($1, $2, $3, $4, $5, '{}'::jsonb, now(), now())`,
        [id, owner, ws, profile, title]
      );
    }
    // A role in my space, and another person's pod-wide one I may not see.
    for (const [id, entity, profile, owner, ws, status, cat] of [
      [F_LEAD, E_ROLE, LEAD, ME, W, "talking", "active"],
      [F_HIDDEN, E_ROLE, SECRET, OTHER, null, "x", "active"],
      [F_ACME_LEAD, E_ACME, LEAD, ME, W, "new", "open"],
    ] as const) {
      await q(
        `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, status_category, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
        [id, entity, profile, owner, ws, status, cat]
      );
    }
    for (const [from, to, ago] of [
      [E_PERSON, E_ACME, "0"],
      [E_PERSON_2, E_THEIR_CO, "0"],
      // Margaret: an older account I may read, a newer one I may not.
      [E_PERSON_3, E_ACME, "2 days"],
      [E_PERSON_3, E_THEIR_CO, "1 day"],
    ] as const) {
      await q(
        `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, created_at)
         values ($1, $2, $3, $4, $5, 'works_at', now() - $6::interval)`,
        [randomUUID(), ME, W, from, to, ago]
      );
    }
    // The visible role's move and the hidden one's, on the thing's log.
    await outbox({
      subjectType: "entity",
      subjectId: E_ROLE,
      facetId: F_LEAD,
      role: "lead",
      from: "new",
      to: "talking",
      category: "active",
    });
    await outbox({
      subjectType: "entity",
      subjectId: E_ROLE,
      facetId: F_HIDDEN,
      role: "secret-role",
      to: "x",
      category: "active",
    });
  });

  it("lists the roles the reader may see, each with its own status", async () => {
    const a = await statusOf(E_ROLE);
    expect(a.roles).toEqual([
      {
        facetId: F_LEAD,
        role: "lead",
        roleName: "Lead",
        status: "talking",
        label: "In talks",
        category: "active",
        tone: LIFECYCLE_CATEGORY_TONE.active,
      },
    ]);
    expect(JSON.stringify(a)).not.toContain(F_HIDDEN);
    expect(a).not.toHaveProperty("account");
  });

  it("carries the account it works at, with the account's roles", async () => {
    const a = await statusOf(E_PERSON);
    expect(a.roles).toEqual([]);
    expect(a.account).toMatchObject({
      id: E_ACME,
      name: "Acme",
      status: null,
      category: null,
      roles: [
        { facetId: F_ACME_LEAD, role: "lead", status: "new", category: "open" },
      ],
      link: expect.any(String),
    });
  });

  it("an account the reader may not read is no line at all", async () => {
    const a = await statusOf(E_PERSON_2);
    expect(a).not.toHaveProperty("account");
    expect(JSON.stringify(a)).not.toContain(E_THEIR_CO);
  });

  it("the newest account the reader may read stands; a newer hidden one is skipped", async () => {
    const a = await statusOf(E_PERSON_3);
    expect(a.account).toMatchObject({ id: E_ACME, name: "Acme" });
    expect(JSON.stringify(a)).not.toContain(E_THEIR_CO);
  });

  it('include: ["history"] is the timeline kept to status moves, a hidden role left out', async () => {
    const plain = await statusOf(E_ROLE);
    expect(plain).not.toHaveProperty("history");
    const a = await statusOf(E_ROLE, { include: ["history"] });
    expect(a.history).toMatchObject({
      truncated: false,
      events: [
        {
          kind: "status_moved",
          from: "new",
          to: "talking",
          role: "lead",
        },
      ],
    });
    expect(JSON.stringify(a.history)).not.toContain("secret-role");

    // A thing's own pause, with its hold.
    const held = await statusOf(E_HELD, { include: ["history"] });
    expect(held.history).toMatchObject({
      events: [
        { kind: "status_moved", to: "on_hold", hold: { on: "external" } },
      ],
    });
  });

  it("a goal's and a session's history keep only their status events", async () => {
    await outbox({
      subjectType: "focus_session",
      subjectId: S_ACTIVE,
      from: "forming",
      to: "active",
      category: "active",
    });
    const [goal, session] = await readStatusOf(ME, [G, S_ACTIVE], {
      include: ["history"],
    });
    for (const a of [goal, session]) {
      const events = (a as StatusOf).history as {
        events: Array<{ kind: string }>;
      };
      expect(events.events.length).toBeGreaterThan(0);
      for (const e of events.events) {
        expect(STATUS_HISTORY_EVENT_KINDS as readonly string[]).toContain(
          e.kind
        );
      }
    }
    expect((session as StatusOf).history).toMatchObject({
      events: [{ kind: "status_moved", from: "forming", to: "active" }],
    });
  });
});

describe('include: ["links"] — the serves edges, both ways', () => {
  const G_TOP = randomUUID();
  const G_SUB = randomUUID();
  const S_WORK = randomUUID();

  beforeAll(async () => {
    for (const [id, name] of [
      [G_TOP, "Grow"],
      [G_SUB, "Pricing"],
    ]) {
      await q(
        `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
         values ($1, $2, $3, $4, '{}'::jsonb, '1', 'active', '[]'::jsonb, now(), now())`,
        [id, P, ME, name]
      );
    }
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, project_id, title, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'Write the page', 'Do it', 'active', 'agent', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
      [S_WORK, ME, W, P]
    );
    for (const [fromType, fromId, metadata] of [
      ["track", G_SUB, {}],
      ["session", S_WORK, { criterionKey: "page-live" }],
      // Another person's session serving my goal: never named.
      ["session", S_THEIRS, {}],
    ] as const) {
      await q(
        `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_by, created_at)
         values ($1, null, $2, $3, 'track', $4, 'serves', $5::jsonb, $6, now())`,
        [randomUUID(), fromType, fromId, G_TOP, JSON.stringify(metadata), ME]
      );
    }
  });

  it("a goal lists what serves it, a hidden end left out; a session what it serves", async () => {
    const [top, work] = await readStatusOf(ME, [G_TOP, S_WORK], {
      include: ["links"],
    });
    const links = (top as StatusOf).links as {
      serves: unknown[];
      servedBy: Array<{ id: string }>;
    };
    expect(links.serves).toEqual([]);
    expect(links.servedBy).toHaveLength(2);
    expect(links.servedBy).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "goal",
          id: G_SUB,
          name: "Pricing",
          category: "active",
        }),
        expect.objectContaining({
          type: "session",
          id: S_WORK,
          name: "Write the page",
          criterionKey: "page-live",
        }),
      ])
    );
    expect(JSON.stringify(links)).not.toContain(S_THEIRS);
    expect((work as StatusOf).links).toEqual({
      serves: [
        expect.objectContaining({
          type: "goal",
          id: G_TOP,
          criterionKey: "page-live",
        }),
      ],
      servedBy: [],
    });
    // Without the include: no links.
    expect(await statusOf(G_TOP)).not.toHaveProperty("links");
  });
});

describe('include: ["rollup"] — a goal\'s tree down serves', () => {
  const ROOT = randomUUID();
  const A = randomUUID();
  const B = randomUUID();
  const S_R = randomUUID();
  const S_A = randomUUID(); // filed in A AND serving ROOT: once
  const S_B_STALE = randomUUID();
  const S_B_DONE = randomUUID();
  const LOOP_1 = randomUUID();
  const LOOP_2 = randomUUID();
  const S_L1 = randomUUID();
  const S_L2 = randomUUID();

  async function goal(id: string, name: string) {
    await q(
      `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
       values ($1, $2, $3, $4, '{}'::jsonb, '1', 'active', '[]'::jsonb, now(), now())`,
      [id, P, ME, name]
    );
  }
  async function session(
    id: string,
    trackId: string,
    status: string,
    outputs: unknown[] = []
  ) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, goal, status, origin, expected_outputs, metadata, started_at, closed_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'Do it', $6, 'agent', $7::jsonb, '{}'::jsonb, now(), $8, now(), now())`,
      [
        id,
        ME,
        W,
        P,
        trackId,
        status,
        JSON.stringify(outputs),
        status === "closed" ? new Date() : null,
      ]
    );
  }
  async function serves(fromType: string, fromId: string, toId: string) {
    await q(
      `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_by, created_at)
       values ($1, null, $2, $3, 'track', $4, 'serves', '{}'::jsonb, $5, now())`,
      [randomUUID(), fromType, fromId, toId, ME]
    );
  }

  beforeAll(async () => {
    for (const [id, name] of [
      [ROOT, "Root"],
      [A, "A"],
      [B, "B"],
      [LOOP_1, "Loop one"],
      [LOOP_2, "Loop two"],
    ]) {
      await goal(id, name);
    }
    await session(S_R, ROOT, "active");
    await session(S_A, A, "active", [
      {
        key: "pick",
        label: "Which plan",
        kind: "decision",
        owner: "human",
        status: "pending",
        blockedReason: "decision",
        owedSince: new Date().toISOString(),
      },
    ]);
    await session(S_B_STALE, B, "stale");
    await session(S_B_DONE, B, "closed");
    // ROOT <- A <- B, and B serves ROOT too: B is reached twice.
    await serves("track", A, ROOT);
    await serves("track", B, A);
    await serves("track", B, ROOT);
    await serves("session", S_A, ROOT);
    await session(S_L1, LOOP_1, "active");
    await session(S_L2, LOOP_2, "active");
    await serves("track", LOOP_2, LOOP_1);
  });

  it("counts each goal and each session once, its stuck and its waits per kind", async () => {
    const a = await statusOf(ROOT, { include: ["rollup"] });
    expect(a.rollup).toMatchObject({
      goals: 3,
      sessions: 4,
      byCategory: { active: 2, paused: 1, done: 1 },
      stuck: 1,
      waits: { decide: 1 },
    });
    expect(a.rollup).not.toHaveProperty("cycle");
    const children = (a.rollup as { children: Array<{ id: string }> }).children;
    expect(children.map((c) => c.id).sort()).toEqual([A, B].sort());
    expect(children.find((c) => c.id === A)).toMatchObject({
      name: "A",
      category: "active",
      // A's own subtree: A and B.
      byCategory: { active: 1, paused: 1, done: 1 },
      stuck: 1,
      waits: { decide: 1 },
    });
    expect(children.find((c) => c.id === B)).toMatchObject({
      byCategory: { paused: 1, done: 1 },
      stuck: 1,
      waits: {},
    });
    // Only goals carry a rollup; without the include, none.
    expect(await statusOf(ROOT)).not.toHaveProperty("rollup");
    expect(await statusOf(S_R, { include: ["rollup"] })).not.toHaveProperty(
      "rollup"
    );
  });

  it("the door refuses a loop; one already stored is cut once and named", async () => {
    expect(
      await closesDependencyCycle(
        { fromType: "track", fromId: LOOP_1, toType: "track", toId: LOOP_2 },
        "serves"
      )
    ).toBe(true);
    // An older row may hold the loop the door now refuses.
    await serves("track", LOOP_1, LOOP_2);
    const a = await statusOf(LOOP_1, { include: ["rollup"] });
    expect(a.rollup).toMatchObject({
      goals: 2,
      sessions: 2,
      byCategory: { active: 2 },
      cycle: true,
      children: [{ id: LOOP_2, byCategory: { active: 2 } }],
    });
  });
});

describe('include: ["signals"] — only the episodes still open', () => {
  const E_HELD_2 = randomUUID();
  const HOLD_T = randomUUID();
  const E_LEADY = randomUUID();
  const F_LEADY = randomUUID();

  async function raised(
    subjectId: string,
    signal: string,
    episodeKey: string,
    daysAgo = 0
  ) {
    await q(
      `insert into status_signal_raised (subject_type, subject_id, signal, episode_key, raised_at)
       values ('entity', $1, $2, $3, ${ago(daysAgo)})`,
      [subjectId, signal, episodeKey]
    );
  }

  beforeAll(async () => {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, title, status, status_category, properties, created_at, updated_at)
       values ($1, $2, null, $3, 'Held, review due', 'on_hold', 'paused', '{}'::jsonb, now(), now())`,
      [E_HELD_2, ME, DEAL]
    );
    const since = new Date().toISOString();
    await outbox({
      transitionId: HOLD_T,
      subjectType: "entity",
      subjectId: E_HELD_2,
      to: "on_hold",
      category: "paused",
      hold: {
        on: "person",
        resumeTo: "sent",
        since,
        reviewBy: "2026-01-01",
      },
    });
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, title, properties, created_at, updated_at)
       values ($1, $2, $3, $4, 'Leady', '{}'::jsonb, now(), now())`,
      [E_LEADY, ME, W, PERSON]
    );
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, status_category, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'talking', 'active', now(), now())`,
      [F_LEADY, E_LEADY, LEAD, ME, W]
    );
    // E_STUCK stands in `negotiating` since it was created (10 days ago).
    await raised(E_STUCK, "stuck", "negotiating:now");
    await raised(E_STUCK, "late", "draft:then:2026-01-01"); // another step
    await raised(E_STUCK, "stuck", "negotiating:before", 20); // before it entered
    await raised(E_STUCK, "gossip", "negotiating:x"); // not a signal
    await raised(E_HELD_2, "hold_review_due", `${HOLD_T}:2026-01-01`);
    await raised(E_HELD_2, "hold_review_due", `${randomUUID()}:2025-01-01`);
    await raised(F_LEADY, "stuck", "talking:now");
  });

  it("a thing's own, its hold's while it stands, and its role's", async () => {
    const stuck = await statusOf(E_STUCK, { include: ["signals"] });
    expect(stuck.signals).toEqual([
      { signal: "stuck", role: null, raisedAt: expect.any(String) },
    ]);
    const held = await statusOf(E_HELD_2, { include: ["signals"] });
    expect(held.signals).toEqual([
      { signal: "hold_review_due", role: null, raisedAt: expect.any(String) },
    ]);
    const leady = await statusOf(E_LEADY, { include: ["signals"] });
    expect(leady.signals).toEqual([
      { signal: "stuck", role: "lead", raisedAt: expect.any(String) },
    ]);
    // A goal with none says so; without the include, no signals at all.
    expect(await statusOf(G, { include: ["signals"] })).toMatchObject({
      signals: [],
    });
    expect(await statusOf(E_STUCK)).not.toHaveProperty("signals");
  });
});
