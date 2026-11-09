/**
 * The object catalogs of `synap_find` (and the id prober behind `/open/<id>`)
 * under a calling KEY's grant, on a REAL Postgres (PGlite): the real floors,
 * the real grant clause (`access/grant-read.ts`) and the real door fence.
 *
 * The defect it pins (review rev-code, finding 6310e11b): the automations,
 * goals and projects readers were floored by `userVisibleWhere` /
 * `projectVisibleWhere` on raw `db`, which carry NO key-grant clause (only
 * `ownerPrivateVisibleWhere`, `accessScopeWhere`, `sessionReadableWhere` and
 * the channel floor AND it). So a key read the person's automation, project
 * and goal names and descriptions whatever its grant said, while sessions,
 * views and documents were narrowed. The same three probes of
 * `resolveObjectKind` named such an id.
 *
 * Pinned:
 *  - a key granted space A never sees a row stamped in space B (reader level);
 *  - the door is REACHABLE: a key the `synap_find` fence admits (an unpinned
 *    scope reading tool/command/playbook/automation) and that holds no
 *    `project.read` / `track.read` reads no project or goal;
 *  - GUARD, derived from `OBJECT_CATALOGS`: under a grant that reads none of
 *    a catalog's subject, the catalog names nothing, and without the grant
 *    it names something (non-vacuity). A catalog that cannot be bounded yet
 *    sits in a SHRINK-ONLY exemption that is itself checked to still leak.
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
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return { ...actual, db: d, getDb: async () => d };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithGrant, type KeyGrant } from "@synap/database";
import "../../../access/grant-read.js";
import { mcpToolAllowed } from "../../../access/grant-door-fence.js";
import {
  OBJECT_CATALOGS,
  searchObjectCatalogs,
  type FindObjects,
  type ObjectCatalog,
} from "../find-objects.js";
import { resolveObjectKind } from "../../diagnose/resolve-object-kind.js";

const OWNER = randomUUID();
const WS_A = randomUUID();
const WS_B = randomUUID();

/** One row per catalog in each space, every one answering to "deploy". */
const rows = {
  A: {
    automation: randomUUID(),
    session: randomUUID(),
    project: randomUUID(),
    goal: randomUUID(),
    view: randomUUID(),
    document: randomUUID(),
  },
  B: {
    automation: randomUUID(),
    session: randomUUID(),
    project: randomUUID(),
    goal: randomUUID(),
    view: randomUUID(),
    document: randomUUID(),
  },
};
const SKILL = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.hasDefault && type === "jsonb"
          ? ` default '{}'::jsonb`
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  for (const table of Object.values(schema)) {
    try {
      getTableConfig(table as PgTable);
    } catch {
      continue;
    }
    await h.client!.exec(ddlFor(table as PgTable)).catch(() => undefined);
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'owner@x.test', 'Owner', 'human')`,
    [OWNER]
  );
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'Ops', $3), ($2, 'Finance', $3)`,
    [WS_A, WS_B, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner'), ($4, $5, $3, 'owner')`,
    [randomUUID(), WS_A, OWNER, randomUUID(), WS_B]
  );
  for (const [ws, r] of [
    [WS_A, rows.A],
    [WS_B, rows.B],
  ] as const) {
    const tag = ws === WS_A ? "ops" : "finance";
    await q(
      `insert into automations (id, workspace_id, created_by, name, description, trigger_type, status) values ($1, $2, $3, $4, 'Runs the deploy', 'cron', 'active')`,
      [r.automation, ws, OWNER, `Nightly ${tag} deploy`]
    );
    await q(
      `insert into focus_sessions (id, workspace_id, user_id, title, goal, status) values ($1, $2, $3, $4, 'ship it', 'active')`,
      [r.session, ws, OWNER, `${tag} deploy session`]
    );
    await q(
      `insert into projects (id, user_id, workspace_id, name, description, status) values ($1, $2, $3, $4, 'The deploy project', 'active')`,
      [r.project, OWNER, ws, `${tag} deploy project`]
    );
    await q(
      `insert into project_tracks (id, project_id, user_id, name, status) values ($1, $2, $3, $4, 'active')`,
      [r.goal, r.project, OWNER, `${tag} deploy goal`]
    );
    await q(
      `insert into views (id, workspace_id, user_id, type, name, description) values ($1, $2, $3, 'kanban', $4, null)`,
      [r.view, ws, OWNER, `${tag} deploy board`]
    );
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, deleted_at) values ($1, $2, $3, $4, 'markdown', null)`,
      [r.document, OWNER, ws, `${tag} deploy notes`]
    );
  }
  await q(
    `insert into skills (id, workspace_id, user_id, kind, scope, name, slug, description, status, approved, tags, topics) values
      ($1, null, null, 'instruction', 'pod', 'Deploy runbook', 'team/deploy', 'How we deploy', 'active', true, '{}', '{}')`,
    [SKILL]
  );
}, 120_000);

function matchIds(block: FindObjects | undefined): string[] {
  expect(block, "catalog block missing").toBeDefined();
  if (!block || "error" in block) {
    throw new Error(`catalog read failed: ${JSON.stringify(block)}`);
  }
  return block.matches.map((m) => m.id);
}

const find = (catalogs: readonly ObjectCatalog[] = OBJECT_CATALOGS) =>
  searchObjectCatalogs({
    query: "deploy",
    userId: OWNER,
    workspaceId: null,
    catalogs,
    limit: 10,
  });

const scope = (
  permissions: string[],
  workspaceIds: string[] | null = null
): KeyGrant => ({
  scopes: [{ permissions, workspaceIds, projectIds: null, entityIds: null }],
  clientId: null,
});

/** Every subject the object catalogs read, granted, but only in space A. */
const SPACE_A_KEY = scope(
  [
    "automation.read",
    "session.read",
    "project.read",
    "track.read",
    "view.read",
    "document.read",
    "skill.read",
  ],
  [WS_A]
);

/** What the `synap_find` fence asks of a key, and nothing else. */
const FIND_DOOR_ONLY_KEY = scope([
  "tool.read",
  "command.read",
  "playbook.read",
  "automation.read",
]);

/** A live key that reads none of the object catalogs' subjects. */
const READS_NO_CATALOG_KEY = scope(["event.read"]);

/**
 * SHRINK-ONLY: catalogs whose reader cannot be bounded by a grant yet, each
 * with why. `skills`: the `skills` table has no grant subject in
 * `GRANT_READ_SPECS` (only `box_runs` names `skill`), so every skill door
 * (`searchInstructionSkills`, `synap_load_skill`) reads it unbounded; a clause
 * on this reader alone would fail closed and hide every skill from every
 * fenced agent key. Remove the entry when the table gets its subject.
 */
const NOT_YET_BOUNDED: ReadonlySet<ObjectCatalog> = new Set(["skills"]);

describe("synap_find object catalogs under a key's grant", () => {
  it("a key granted space A never names a row stamped in space B", async () => {
    const ungranted = await find();
    const granted = await runWithGrant(SPACE_A_KEY, () => find());
    for (const catalog of OBJECT_CATALOGS) {
      if (catalog === "skills") continue; // pod-wide rows only: no space B row
      const all = matchIds(ungranted[catalog]);
      const narrowed = matchIds(granted[catalog]);
      const inA = Object.values(rows.A);
      const inB = Object.values(rows.B);
      // Non-vacuity: without the grant the person reads both spaces.
      expect(
        all.some((id) => inB.includes(id)),
        `${catalog}: no space B row to leak`
      ).toBe(true);
      // A goal (`project_tracks`) has no workspace column, so a space-pinned
      // grant reads none at all: fail closed, as `scopedDb` and
      // `tracks.list` read it (grant-read.ts). Every other catalog reads A.
      if (catalog !== "goals") {
        expect(
          narrowed.some((id) => inA.includes(id)),
          `${catalog}: the space A key reads nothing in A`
        ).toBe(true);
      }
      expect(
        narrowed.filter((id) => inB.includes(id)),
        `${catalog}: leaked a space B row to a space A key`
      ).toEqual([]);
    }
  });

  it("the door is reachable: a key the synap_find fence admits reads no project or goal it holds no read on", async () => {
    // The fence admits it (the door is live for this key)...
    expect(mcpToolAllowed("synap_find", true, FIND_DOOR_ONLY_KEY)).toBe(true);
    // ...and a pinned key never passes the aggregate fence at all.
    expect(mcpToolAllowed("synap_find", true, SPACE_A_KEY)).toBe(false);

    const r = await runWithGrant(FIND_DOOR_ONLY_KEY, () => find());
    expect(matchIds(r.projects)).toEqual([]);
    expect(matchIds(r.goals)).toEqual([]);
    expect(matchIds(r.sessions)).toEqual([]);
    expect(matchIds(r.views)).toEqual([]);
    expect(matchIds(r.documents)).toEqual([]);
    // Non-vacuity: the subject it DOES hold is still read, in both spaces.
    expect(matchIds(r.automations).sort()).toEqual(
      [rows.A.automation, rows.B.automation].sort()
    );
  });

  it("GUARD: every object catalog is bounded by the key's grant (derived from OBJECT_CATALOGS)", async () => {
    expect(OBJECT_CATALOGS.length).toBeGreaterThan(0);
    const ungranted = await find();
    const denied = await runWithGrant(READS_NO_CATALOG_KEY, () => find());
    const unbounded: string[] = [];
    for (const catalog of OBJECT_CATALOGS) {
      // Non-vacuity: every catalog names something without a grant.
      expect(
        matchIds(ungranted[catalog]).length,
        `${catalog}: seeded rows not found without a grant`
      ).toBeGreaterThan(0);
      if (matchIds(denied[catalog]).length > 0) unbounded.push(catalog);
    }
    expect(
      unbounded.filter((c) => !NOT_YET_BOUNDED.has(c as ObjectCatalog)),
      "a find catalog reader reads rows no grant clause bounds: AND grantReadPredicate(<table>) onto it"
    ).toEqual([]);
    // Shrink-only: an exempt catalog that became bounded must leave the list.
    expect(
      [...NOT_YET_BOUNDED].filter((c) => !unbounded.includes(c)),
      "an exempt catalog is now bounded: remove it from NOT_YET_BOUNDED"
    ).toEqual([]);
  });
});

describe("resolveObjectKind under a key's grant (the /open/<id> prober)", () => {
  it("a key granted space A does not resolve an automation, project or goal of space B", async () => {
    for (const [kind, id] of [
      ["automation", rows.B.automation],
      ["project", rows.B.project],
      ["track", rows.B.goal],
    ] as const) {
      // Non-vacuity: the person resolves it.
      expect((await resolveObjectKind(id, OWNER))?.kind).toBe(kind);
      expect(
        await runWithGrant(SPACE_A_KEY, () => resolveObjectKind(id, OWNER)),
        `${kind} of space B resolved for a space A key`
      ).toBeNull();
    }
    // ...and space A's own still resolve for that key (a goal never does for
    // a space-pinned key: `project_tracks` has no workspace column, so the
    // grant fails closed on it, as everywhere else it is read).
    for (const [kind, id] of [
      ["automation", rows.A.automation],
      ["project", rows.A.project],
    ] as const) {
      expect(
        (await runWithGrant(SPACE_A_KEY, () => resolveObjectKind(id, OWNER)))
          ?.kind
      ).toBe(kind);
    }
  });
});
