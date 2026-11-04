/**
 * RAIL PINS (surfaces W1.7) on PGlite through the REAL `preferences.*` doors:
 *  - a space's template `sidebarItems` pipeline views are SUGGESTED pins
 *    (by viewId, or by a name only one pipeline view in the space has);
 *  - pin / unpin / reorder persist the effective list and seed every space in
 *    view, so an unpinned suggestion never comes back — while a space that
 *    appears later still suggests its own;
 *  - a pin must name a real, readable surface of that kind; pinning twice
 *    keeps one pin; another person's pins are untouched;
 *  - GOAL pins ("This week", D4): `track:<id>`, `profileSlug` null, at most
 *    `RAIL_GOAL_PINS_MAX` (a 4th is PRECONDITION_FAILED while the rail has
 *    room), unpin / reorder by the `track:` key, a goal the person cannot read
 *    is refused, and a pinned goal that stops being readable leaves the read
 *    and frees its place;
 *  - DOCUMENT pins (plan 9ad4b2fc P4, Q5/Q6): `doc:<id>`, `profileSlug` and
 *    `trackId` null, always the person's own; sent only with
 *    `includeDocuments: true` (never with `includeGoals` alone); a document the
 *    person cannot read is refused; one that stops being readable leaves the
 *    read; nothing in a space's sidebar suggests one.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { preferencesRouter } from "./preferences.js";

const U = randomUUID();
const OTHER = randomUUID();
const W1 = randomUUID();
const W2 = randomUUID();
const W3 = randomUUID();

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
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "ui_preferences"
          ? " default '{}'::jsonb"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function space(id: string, owner: string, sidebarItems: unknown[]) {
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,$3::jsonb)`,
    [id, owner, JSON.stringify({ layout: { sidebarItems } })]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), id, owner]
  );
}
async function view(
  ws: string,
  name: string,
  type: string,
  config: unknown
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into views (id, workspace_id, user_id, name, type, scope_profile_ids, query, config, metadata)
     values ($1,$2,$3,$4,$5,'{}'::uuid[],'{}'::jsonb,$6::jsonb,'{}'::jsonb)`,
    [id, ws, U, name, type, JSON.stringify(config)]
  );
  return id;
}

const as = (userId: string) =>
  preferencesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
  } as never);
const keys = async (userId = U) =>
  (
    await as(userId).railPins({ includeGoals: true, includeDocuments: true })
  ).pins.map((p) => p.key);

let LEADS = "";
let POSTS = "";
let TABLE = "";
let LATER = "";

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  for (const u of [U, OTHER])
    await q(`insert into users (id, email) values ($1,$2)`, [u, `${u}@x.io`]);
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values
      (gen_random_uuid(),'lead','Lead','role','workspace'),
      (gen_random_uuid(),'post','Post','kind','workspace'),
      (gen_random_uuid(),'client','Client','role','workspace')`
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
    [W1, U]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), W1, U]
  );
  LEADS = await view(W1, "Lead Pipeline", "pipeline", { profileSlug: "lead" });
  TABLE = await view(W1, "Leads table", "table", { profileSlug: "lead" });
  POSTS = randomUUID();
  // W1's sidebar: the pipeline BY NAME, a table view, an app. Only the
  // pipeline is a pin.
  await q(`update workspaces set settings = $2::jsonb where id = $1`, [
    W1,
    JSON.stringify({
      layout: {
        sidebarItems: [
          { kind: "app", appId: "chat" },
          { kind: "view", viewName: "Lead Pipeline", label: "Leads" },
          { kind: "view", viewId: TABLE },
        ],
      },
    }),
  ]);
  await space(W2, U, []);
  POSTS = await view(W2, "Posts", "pipeline", { profileSlug: "post" });
  await q(`update workspaces set settings = $2::jsonb where id = $1`, [
    W2,
    JSON.stringify({
      layout: { sidebarItems: [{ kind: "view", viewId: POSTS }] },
    }),
  ]);
  // Another person's space — never suggested to U.
  await space(randomUUID(), OTHER, []);
});

describe("preferences rail pins", () => {
  it("suggests the pipeline views each visible space's sidebar names", async () => {
    const { pins } = await as(U).railPins();
    expect(pins).toEqual(
      expect.arrayContaining([
        {
          key: `view:${LEADS}`,
          profileSlug: "lead",
          viewId: LEADS,
          trackId: null,
          documentId: null,
          label: "Leads",
          source: "template",
        },
        {
          key: `view:${POSTS}`,
          profileSlug: "post",
          viewId: POSTS,
          trackId: null,
          documentId: null,
          label: "Posts",
          source: "template",
        },
      ])
    );
    expect(pins).toHaveLength(2);
    expect(await keys(OTHER)).toEqual([]);
  });

  it("pin appends (idempotent), unpin removes for good, a later space still suggests", async () => {
    await as(U).pinSurface({ profileSlug: "client" });
    await as(U).pinSurface({ profileSlug: "client" });
    expect((await keys()).filter((k) => k === "kind:client")).toHaveLength(1);

    await as(U).unpinSurface({ key: `view:${LEADS}` });
    expect(await keys()).not.toContain(`view:${LEADS}`);
    // A re-read does not resurrect it: W1 is seeded now.
    expect(await keys()).not.toContain(`view:${LEADS}`);

    await space(W3, U, []);
    LATER = await view(W3, "Later", "pipeline", { profileSlug: "post" });
    await q(`update workspaces set settings = $2::jsonb where id = $1`, [
      W3,
      JSON.stringify({
        layout: { sidebarItems: [{ kind: "view", viewId: LATER }] },
      }),
    ]);
    expect(await keys()).toContain(`view:${LATER}`);
  });

  it("reorder puts the named keys first and keeps the rest", async () => {
    const before = await keys();
    await as(U).reorderRailPins({ keys: ["kind:client", "nope"] });
    const after = await keys();
    expect(after[0]).toBe("kind:client");
    expect(new Set(after)).toEqual(new Set(before));
  });

  it("a pin must name a real, readable surface of that kind", async () => {
    await expect(
      as(U).pinSurface({ profileSlug: "nope" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      as(U).pinSurface({ profileSlug: "post", viewId: LEADS })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as(U).pinSurface({ profileSlug: "lead", viewId: TABLE })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // OTHER cannot pin U's view.
    await expect(
      as(OTHER).pinSurface({ profileSlug: "lead", viewId: LEADS })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("goal pins — This week (D4)", () => {
  const MINE = randomUUID();
  const THEIRS = randomUUID();
  const goals: string[] = [];
  let theirGoal = "";

  async function goal(project: string, owner: string, name: string) {
    const id = randomUUID();
    await q(
      `insert into project_tracks (id, project_id, user_id, name, status, definition_snapshot, params, stage_history, metadata)
       values ($1, $2, $3, $4, 'active', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
      [id, project, owner, name]
    );
    return id;
  }

  beforeAll(async () => {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status) values
        ($1, $2, null, 'Mine', 'active'), ($3, $4, null, 'Theirs', 'active')`,
      [MINE, U, THEIRS, OTHER]
    );
    for (const n of ["One", "Two", "Three", "Four"]) {
      goals.push(await goal(MINE, U, n));
    }
    theirGoal = await goal(THEIRS, OTHER, "Not yours");
  });

  it("pins a goal under its track: key, with no kind", async () => {
    const { pins } = await as(U).pinSurface({
      trackId: goals[0]!,
      includeGoals: true,
    });
    expect(pins).toContainEqual({
      key: `track:${goals[0]}`,
      profileSlug: null,
      viewId: null,
      trackId: goals[0],
      documentId: null,
      label: null,
      source: "user",
    });
    // The stored pin reads back (a pin with no profileSlug is kept).
    expect(await keys()).toContain(`track:${goals[0]}`);
  });

  it("holds three goals: a fourth is a precondition, not a 500", async () => {
    await as(U).pinSurface({ trackId: goals[1]! });
    await as(U).pinSurface({ trackId: goals[2]! });
    // Pinning a pinned goal again is idempotent, never "full".
    await as(U).pinSurface({ trackId: goals[2]! });
    await expect(
      as(U).pinSurface({ trackId: goals[3]! })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await keys()).filter((k) => k.startsWith("track:"))).toHaveLength(
      3
    );
    // The rail itself still has room: a kind pin still lands.
    await as(U).pinSurface({ profileSlug: "post" });
    expect(await keys()).toContain("kind:post");
  });

  it("unpin and reorder work by the track: key", async () => {
    await as(U).reorderRailPins({ keys: [`track:${goals[2]}`] });
    expect((await keys())[0]).toBe(`track:${goals[2]}`);
    await as(U).unpinSurface({ key: `track:${goals[1]}` });
    expect(await keys()).not.toContain(`track:${goals[1]}`);
    // The freed place takes the fourth goal.
    await as(U).pinSurface({ trackId: goals[3]! });
    expect(await keys()).toContain(`track:${goals[3]}`);
  });

  it("refuses a goal the person cannot read, and a pin that names both a kind and a goal", async () => {
    await expect(
      as(U).pinSurface({ trackId: theirGoal })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      as(U).pinSurface({ trackId: goals[0]!, profileSlug: "post" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(as(U).pinSurface({})).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("goal pins come back only when asked: an old client reads surface pins alone", async () => {
    const withGoals = (await as(U).railPins({ includeGoals: true })).pins;
    expect(withGoals.some((p) => p.trackId)).toBe(true); // non-vacuity
    for (const read of [await as(U).railPins(), await as(U).railPins({})]) {
      // Every pin an old build reads names a kind — never a null profileSlug.
      expect(read.pins.every((p) => p.trackId === null && p.profileSlug)).toBe(
        true
      );
      expect(read.pins.map((p) => p.key)).toEqual(
        withGoals.filter((p) => !p.trackId).map((p) => p.key)
      );
    }
    // The WRITE doors answer the same way: no goal pin unless asked.
    const surfaceOnly = (pins: Array<{ trackId: string | null }>) =>
      pins.every((p) => p.trackId === null);
    const goalKey = withGoals.find((p) => p.trackId)!.key;
    const written = [
      await as(U).pinSurface({ profileSlug: "post" }),
      await as(U).reorderRailPins({ keys: [goalKey] }),
      await as(U).unpinSurface({ key: "kind:post" }),
    ];
    for (const w of written) expect(surfaceOnly(w.pins)).toBe(true);
    const asked = await as(U).reorderRailPins({
      keys: [goalKey],
      includeGoals: true,
    });
    expect(asked.pins.some((p) => p.key === goalKey)).toBe(true);
  });

  it("a pinned goal that is no longer readable leaves the read and frees its place", async () => {
    const pinned = (await keys()).filter((k) => k.startsWith("track:"));
    expect(pinned).toHaveLength(3);
    await q(`delete from project_tracks where id = $1`, [goals[0]]);
    expect(await keys()).not.toContain(`track:${goals[0]}`);
    // Its place is free: a new goal pins without "unpin one first".
    await as(U).pinSurface({ trackId: goals[1]! });
    expect((await keys()).filter((k) => k.startsWith("track:"))).toHaveLength(
      3
    );
  });
});

describe("document pins — a living document on the rail (P4)", () => {
  const MINE = randomUUID();
  const ALSO_MINE = randomUUID();
  const THEIRS = randomUUID();
  const THEIR_SPACE = randomUUID();

  async function doc(id: string, owner: string, ws: string | null) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision)
       values ($1,$2,$3,'Doc','markdown',1,1)`,
      [id, owner, ws]
    );
  }

  beforeAll(async () => {
    await space(THEIR_SPACE, OTHER, []);
    await doc(MINE, U, W1);
    await doc(ALSO_MINE, U, W1);
    await doc(THEIRS, OTHER, THEIR_SPACE);
  });

  it("pins a document under its doc: key, the person's own, with no kind", async () => {
    const { pins } = await as(U).pinSurface({
      documentId: MINE,
      includeDocuments: true,
    });
    expect(pins).toContainEqual({
      key: `doc:${MINE}`,
      profileSlug: null,
      viewId: null,
      trackId: null,
      documentId: MINE,
      label: null,
      source: "user",
      title: "Doc",
    });
    // Idempotent: pinning it again keeps one pin.
    await as(U).pinSurface({ documentId: MINE, label: "Dashboard" });
    expect((await keys()).filter((k) => k === `doc:${MINE}`)).toHaveLength(1);
  });

  it("document pins come back only when asked — never with goals alone", async () => {
    const all = (
      await as(U).railPins({ includeGoals: true, includeDocuments: true })
    ).pins;
    expect(all.some((p) => p.documentId)).toBe(true); // non-vacuity
    for (const read of [
      await as(U).railPins(),
      await as(U).railPins({ includeGoals: true }),
    ]) {
      expect(read.pins.every((p) => p.documentId === null)).toBe(true);
    }
    const docsOnly = (await as(U).railPins({ includeDocuments: true })).pins;
    expect(docsOnly.some((p) => p.key === `doc:${MINE}`)).toBe(true);
    expect(docsOnly.every((p) => p.trackId === null)).toBe(true);
    // The WRITE doors answer the same way.
    const written = [
      await as(U).pinSurface({ documentId: ALSO_MINE }),
      await as(U).reorderRailPins({ keys: [`doc:${ALSO_MINE}`] }),
      await as(U).unpinSurface({ key: "kind:nothing-pinned" }),
    ];
    for (const w of written) {
      expect(w.pins.every((p) => p.documentId === null)).toBe(true);
    }
    const asked = await as(U).reorderRailPins({
      keys: [`doc:${ALSO_MINE}`],
      includeDocuments: true,
    });
    expect(asked.pins[0]?.key).toBe(`doc:${ALSO_MINE}`);
  });

  it("refuses a document the person cannot read, and a pin that names two things", async () => {
    await expect(
      as(U).pinSurface({ documentId: THEIRS })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      as(U).pinSurface({ documentId: randomUUID() })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      as(U).pinSurface({ documentId: MINE, profileSlug: "post" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as(U).pinSurface({ documentId: MINE, trackId: randomUUID() })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as(U).pinSurface({ documentId: MINE, viewId: LEADS })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await keys(OTHER)).not.toContain(`doc:${MINE}`);
  });

  it("unpins by the doc: key", async () => {
    await as(U).unpinSurface({ key: `doc:${ALSO_MINE}` });
    expect(await keys()).not.toContain(`doc:${ALSO_MINE}`);
  });

  it("a pinned document that is no longer readable leaves the read", async () => {
    expect(await keys()).toContain(`doc:${MINE}`);
    await q(`delete from documents where id = $1`, [MINE]);
    expect(await keys()).not.toContain(`doc:${MINE}`);
    // A write drops it from the stored row too, and keeps the rest.
    const before = (await keys()).length;
    await as(U).reorderRailPins({ keys: [] });
    expect(await keys()).toHaveLength(before);
  });

  it("a document pin carries its document's title, read with the pin and never stored (review A7)", async () => {
    const D = randomUUID();
    await doc(D, U, W1);
    await q(`update documents set title = 'Quarterly' where id = $1`, [D]);
    // The write that pins it answers with the title (the pinned document is
    // in the same batched read).
    const written = await as(U).pinSurface({
      documentId: D,
      includeDocuments: true,
    });
    expect(written.pins.find((p) => p.documentId === D)?.title).toBe(
      "Quarterly"
    );
    // The read follows the document's title as it is now.
    await q(`update documents set title = 'Quarterly review' where id = $1`, [
      D,
    ]);
    const read = (await as(U).railPins({ includeDocuments: true })).pins;
    expect(read.find((p) => p.documentId === D)?.title).toBe(
      "Quarterly review"
    );
    // Only a document pin carries one.
    expect(
      read.filter((p) => !p.documentId).every((p) => !("title" in p))
    ).toBe(true);
    // Never stored: the row holds the pin, not its title.
    const { rows } = await q<{ pins: string }>(
      `select (ui_preferences #> '{railPins,pins}')::text as pins from user_preferences where user_id = $1`,
      [U]
    );
    expect(rows[0]!.pins).toContain(D);
    expect(rows[0]!.pins).not.toContain("Quarterly");
    await as(U).unpinSurface({ key: `doc:${D}` });
  });

  it("a full rail tells a client that hides documents how many of its pins it does not show (review A11)", async () => {
    const FULL = randomUUID();
    await q(`insert into users (id, email) values ($1,$2)`, [
      FULL,
      `${FULL}@x.io`,
    ]);
    const ids = Array.from({ length: 30 }, () => randomUUID());
    for (const id of ids) await doc(id, FULL, null);
    await q(
      `insert into user_preferences (user_id, ui_preferences) values ($1, $2::jsonb)`,
      [
        FULL,
        JSON.stringify({
          railPins: {
            pins: ids.map((documentId) => ({
              documentId,
              label: null,
              source: "user",
            })),
            seededWorkspaceIds: [],
          },
        }),
      ]
    );
    expect(
      (await as(FULL).railPins({ includeDocuments: true })).pins
    ).toHaveLength(30); // non-vacuity: every pin is readable, the rail is full
    // An old client sees none of them, and is told why its rail is full.
    expect((await as(FULL).railPins()).pins).toEqual([]);
    await expect(
      as(FULL).pinSurface({ profileSlug: "post" })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(
        /30 of them are goals or documents this app does not show/
      ),
    });
    // A client that draws them gets the plain sentence.
    await expect(
      as(FULL).pinSurface({ profileSlug: "post", includeDocuments: true })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "A rail holds at most 30 pins — unpin one first.",
    });
  });

  it("only the person pins a document: a stored 'template' claim reads as theirs, and no sidebar item suggests one", async () => {
    const D = randomUUID();
    await doc(D, U, W1);
    await q(
      `update user_preferences
          set ui_preferences = jsonb_set(ui_preferences, '{railPins,pins}',
            (ui_preferences #> '{railPins,pins}') || $2::jsonb)
        where user_id = $1`,
      [U, JSON.stringify([{ documentId: D, label: null, source: "template" }])]
    );
    const pin = (await as(U).railPins({ includeDocuments: true })).pins.find(
      (p) => p.documentId === D
    );
    expect(pin?.source).toBe("user");

    // A space whose sidebar names a document suggests no pin (Q6).
    const W4 = randomUUID();
    const E = randomUUID();
    await space(W4, U, [{ kind: "document", documentId: E }]);
    await doc(E, U, W4);
    expect(await keys()).not.toContain(`doc:${E}`);
  });
});
