/**
 * THE NEXT-HOUR PICKS on PGlite — the REAL `readNextMovePicks` (task + track
 * step halves, the real access floors, the real batched dependency read) and
 * the REAL `writeNextMoveSkip`, from stored rows to ranked wire rows.
 *
 *   - an open task blocked by an open task is NOT a pick; its blocker is,
 *     with "Unblocks 1", ranked first;
 *   - a done task, a deleted task and a stranger's task are never picks;
 *   - an open step of an ACTIVE track is a pick (Resume, track named, draft
 *     ready when the agent claims an output); a step of a paused track is not;
 *   - a session already on the page (Blocking / Happening) is excluded;
 *   - a skip hides the pick until `until`, and touches no other preference;
 *   - "draft ready" is THE outcome projection's `needs_review`: a RETIRED
 *     slot the agent claimed is not a draft (rule 5) — the row where the old
 *     raw re-derivation and the projection disagree;
 *   - a task is open when THE dependency rule does not clear it, so an
 *     overlay status (`Blocked`) is a pick and a folded `Closed-Won` is not;
 *   - two skips written back to back both land (one-key merge);
 *   - a failed project-name read is NAMED in `unreadable`, never "no project".
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
  // With the schema: the facet-scope read (`resolveFacetVisibilityScope` →
  // workspace membership) uses the relational query API.
  const schema = await import("@synap/database/schema");
  const pg = drizzle(client, { schema });
  return { ...actual, db: pg, getDb: async () => pg };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { userPreferences } from "@synap/database/schema";
import { AccessContext } from "../../../access/index.js";
import {
  hasDraftReady,
  readNextMovePicks,
  writeNextMoveSkip,
} from "../next-moves.js";

const USER = "user-1";
const STRANGER = "user-2";
const NOW = new Date("2026-10-05T12:00:00.000Z");
const ago = (d: number) =>
  new Date(NOW.getTime() - d * 86_400_000).toISOString();

const BLOCKER = randomUUID();
const BLOCKED = randomUUID();
const OLD = randomUUID();
const DONE = randomUUID();
const GONE = randomUUID();
const THEIRS = randomUUID();
const TRACK = randomUUID();
const PAUSED_TRACK = randomUUID();
const PROJECT = randomUUID();
const STEP = randomUUID();
const STEP_PAUSED_TRACK = randomUUID();
const STEP_ON_PAGE = randomUUID();
const STEP_RETIRED_CLAIM = randomUUID();
const OVERLAY = randomUUID();
const WON = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "id"
        ? " default gen_random_uuid()"
        : c.name.endsWith("_at") && c.notNull
          ? " default now()"
          : c.name === "theme"
            ? " default 'system'"
            : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const ctx = () => ({
  userId: USER,
  roster: true,
  access: AccessContext.operator({ userId: USER }),
});

async function picks(exclude: string[] = []) {
  return readNextMovePicks(
    ctx(),
    {},
    {
      excludeSessionIds: new Set(exclude),
      projectNames: async (ids) =>
        new Map(ids.filter((i) => i === PROJECT).map((i) => [i, "Launch"])),
      now: NOW,
    }
  );
}

beforeAll(async () => {
  // Every table the access predicates may touch (members, grants, …): the
  // real floors run, so their tables must exist — empty is the honest state.
  const seen = new Set<string>();
  for (const t of [...Object.values(database), userPreferences]) {
    if (!is(t, PgTable)) continue;
    const name = getTableConfig(t).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(t));
  }
  const task = (
    id: string,
    user: string,
    status: string | null,
    created: string,
    deleted = false
  ) =>
    h.client!.query(
      `insert into entities (id, user_id, type, title, properties, created_at, updated_at, deleted_at)
       values ($1, $2, 'task', $3, $4::jsonb, $5, $5, $6)`,
      [
        id,
        user,
        `Task ${id.slice(0, 4)}`,
        JSON.stringify(status ? { status, projectId: PROJECT } : {}),
        created,
        deleted ? NOW.toISOString() : null,
      ]
    );
  await task(BLOCKER, USER, "todo", ago(1));
  await task(BLOCKED, USER, "todo", ago(2));
  await task(OLD, USER, null, ago(9));
  await task(DONE, USER, "done", ago(3));
  await task(GONE, USER, "todo", ago(3), true);
  await task(THEIRS, STRANGER, "todo", ago(3));
  await task(OVERLAY, USER, "Blocked", ago(3));
  await task(WON, USER, "Closed-Won", ago(3));
  await h.client!.query(
    `insert into links (id, created_by, from_type, from_id, to_type, to_id, link_type)
     values (gen_random_uuid(), $1, 'entity', $2, 'entity', $3, 'blocked_by')`,
    [USER, BLOCKED, BLOCKER]
  );
  for (const [id, status] of [
    [TRACK, "active"],
    [PAUSED_TRACK, "paused"],
  ] as const) {
    await h.client!.query(
      `insert into project_tracks (id, project_id, user_id, name, status, definition_snapshot, method_version, params, stage_history)
       values ($1, $2, $3, $4, $5, '{}'::jsonb, '1', '{}'::jsonb, '[]'::jsonb)`,
      [id, PROJECT, USER, id === TRACK ? "Pricing" : "Parked", status]
    );
  }
  const step = (id: string, trackId: string, outputs: unknown[]) =>
    h.client!.query(
      `insert into focus_sessions (id, user_id, title, goal, project_id, track_id, status, origin, expected_outputs, agent_ids, metadata, updated_at)
       values ($1, $2, $3, 'g', $4, $5, 'active', 'human', $6::jsonb, '{}', '{}'::jsonb, $7)`,
      [
        id,
        USER,
        `Step ${id.slice(0, 4)}`,
        PROJECT,
        trackId,
        JSON.stringify(outputs),
        ago(4),
      ]
    );
  await step(STEP, TRACK, [{ kind: "doc", label: "Brief", claimedDone: true }]);
  await step(STEP_PAUSED_TRACK, PAUSED_TRACK, []);
  await step(STEP_ON_PAGE, TRACK, []);
  await step(STEP_RETIRED_CLAIM, TRACK, [
    {
      kind: "doc",
      label: "Dropped",
      claimedDone: true,
      retiredAt: ago(1),
    },
  ]);
});

describe("hasDraftReady — THE projection's needs_review, never a re-derivation", () => {
  // Each row rules out a rival: the raw "claimedDone && status !== done"
  // rule says TRUE on the retired row; the projection says retired is never
  // owed. A human-owned claim is the person's own work, not an AI draft.
  it.each([
    [[{ kind: "doc", label: "A", claimedDone: true }], true],
    [
      [
        {
          kind: "doc",
          label: "A",
          claimedDone: true,
          retiredAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      false,
    ],
    [[{ kind: "doc", label: "A", claimedDone: true, status: "done" }], false],
    [[{ kind: "doc", label: "A", claimedDone: true, owner: "human" }], false],
    [[{ kind: "doc", label: "A" }], false],
    [null, false],
  ])("%j → %s", (outputs, expected) => {
    expect(hasDraftReady(outputs)).toBe(expected);
  });
});

describe("readNextMovePicks — stored rows to ranked picks", () => {
  it("ranks the free blocker first (Unblocks 1); never a blocked, done, deleted or foreign task", async () => {
    const out = await picks([STEP_ON_PAGE]);
    expect(out.unreadable).toEqual([]);
    const keys = out.rows.map((r) => r.key);
    expect(keys[0]).toBe(`entity:${BLOCKER}`);
    expect(out.rows[0]).toMatchObject({
      unblocks: 1,
      action: "start",
      project: { name: "Launch" },
    });
    for (const absent of [BLOCKED, DONE, GONE, THEIRS]) {
      expect(keys).not.toContain(`entity:${absent}`);
    }
    // A task with no status is open (the honest default) — and has waited longest.
    expect(keys).toContain(`entity:${OLD}`);
  });

  it("an open step of an ACTIVE track is a pick (Resume, track named, draft ready); a paused track's is not", async () => {
    const out = await picks([STEP_ON_PAGE]);
    const step = out.rows.find((r) => r.key === `session:${STEP}`);
    expect(step).toMatchObject({
      action: "resume",
      track: { id: TRACK, name: "Pricing" },
      draftReady: true,
    });
    expect(out.rows.map((r) => r.key)).not.toContain(
      `session:${STEP_PAUSED_TRACK}`
    );
    // Retired + claimed ⇒ no draft (rule 5) — the disagreeing row.
    expect(
      out.rows.find((r) => r.key === `session:${STEP_RETIRED_CLAIM}`)
    ).toMatchObject({ draftReady: false });
    // Already on the page (Blocking / Happening) ⇒ excluded.
    expect(out.rows.map((r) => r.key)).not.toContain(`session:${STEP_ON_PAGE}`);
    // Ranking: unblocks > draft > waited.
    expect(out.rows.map((r) => r.key).slice(0, 2)).toEqual([
      `entity:${BLOCKER}`,
      `session:${STEP}`,
    ]);
  });

  it("a task is open by THE dependency rule: an overlay status is a pick, a folded cleared one is not", async () => {
    const keys = (await picks([STEP_ON_PAGE])).rows.map((r) => r.key);
    expect(keys).toContain(`entity:${OVERLAY}`);
    expect(keys).not.toContain(`entity:${WON}`);
  });

  it("a failed project-name read is named in `unreadable`, and the picks survive", async () => {
    const out = await readNextMovePicks(
      ctx(),
      {},
      {
        excludeSessionIds: new Set([STEP_ON_PAGE]),
        projectNames: async () => {
          throw new Error("projects down");
        },
        now: NOW,
      }
    );
    expect(out.unreadable).toEqual(["projects"]);
    expect(out.truncated).toBe(true);
    expect(out.rows.length).toBeGreaterThan(0);
    expect(out.rows.every((r) => r.project === null)).toBe(true);
  });

  it("a skip hides the pick until `until`, writing only its own preference key", async () => {
    await h.client!.query(
      `insert into user_preferences (user_id, theme, ui_preferences) values ($1, 'system', $2::jsonb)`,
      [USER, JSON.stringify({ feedPreferences: { persona: "kept" } })]
    );
    await writeNextMoveSkip({
      userId: USER,
      key: `entity:${BLOCKER}`,
      until: new Date(NOW.getTime() + 6 * 3600_000),
      now: NOW,
    });
    const out = await picks([STEP_ON_PAGE]);
    expect(out.rows.map((r) => r.key)).not.toContain(`entity:${BLOCKER}`);
    const { rows } = await h.client!.query<{ ui: Record<string, unknown> }>(
      `select ui_preferences as ui from user_preferences where user_id = $1`,
      [USER]
    );
    expect(rows[0]!.ui.feedPreferences).toEqual({ persona: "kept" });
    expect(Object.keys(rows[0]!.ui.nextMoveSkips as object)).toEqual([
      `entity:${BLOCKER}`,
    ]);
    // Past `until` it is back.
    const later = await readNextMovePicks(
      ctx(),
      {},
      {
        excludeSessionIds: new Set([STEP_ON_PAGE]),
        projectNames: async () => new Map(),
        now: new Date(NOW.getTime() + 7 * 3600_000),
      }
    );
    expect(later.rows.map((r) => r.key)).toContain(`entity:${BLOCKER}`);
  });

  it("two skips written back to back both land; an expired one is pruned", async () => {
    await h.client!.query(
      `update user_preferences set ui_preferences = jsonb_set(ui_preferences, '{nextMoveSkips,stale}', '"2020-01-01T00:00:00.000Z"') where user_id = $1`,
      [USER]
    );
    const until = new Date(NOW.getTime() + 3600_000);
    await Promise.all([
      writeNextMoveSkip({ userId: USER, key: "entity:a", until, now: NOW }),
      writeNextMoveSkip({ userId: USER, key: "entity:b", until, now: NOW }),
    ]);
    const { rows } = await h.client!.query<{ ui: Record<string, unknown> }>(
      `select ui_preferences as ui from user_preferences where user_id = $1`,
      [USER]
    );
    const skips = rows[0]!.ui.nextMoveSkips as Record<string, string>;
    expect(skips["entity:a"]).toBe(until.toISOString());
    expect(skips["entity:b"]).toBe(until.toISOString());
    expect(skips[`entity:${BLOCKER}`]).toBeDefined();
    expect(skips.stale).toBeUndefined();
    expect(rows[0]!.ui.feedPreferences).toEqual({ persona: "kept" });
  });

  it("a skip is clamped to 36h — never a permanent hide", async () => {
    const { until } = await writeNextMoveSkip({
      userId: USER,
      key: `entity:${OLD}`,
      until: new Date(NOW.getTime() + 30 * 86_400_000),
      now: NOW,
    });
    expect(new Date(until).getTime()).toBe(NOW.getTime() + 36 * 3600_000);
  });
});
