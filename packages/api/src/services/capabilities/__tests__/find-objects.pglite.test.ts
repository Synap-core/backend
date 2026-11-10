/**
 * The object catalogs of `synap_find`, on a REAL Postgres (PGlite): every
 * table the readers touch is created from the Drizzle schema, so the floors
 * are the real SQL (`userVisibleWhere`, `sessionReadableWhere`,
 * `projectVisibleWhere`, `ownerPrivateVisibleWhere`, `accessScopeWhere`,
 * `visibleSkillsAnyWorkspaceWhere`), and so is the "any term hits" filter.
 *
 * Pinned:
 *  - each catalog finds the reader's own row by its words, with an
 *    `/open/<id>` link and a one-line `why`;
 *  - a row the reader cannot see (another person's session, project, goal,
 *    view, document or skill; a space they are not in) is never named;
 *  - archived automations and deleted documents are not offered;
 *  - at pod altitude a workspace-scoped RULE is found (the skills door's
 *    default `visibleSkillsWhere` without a workspace would drop it);
 *  - the better match ranks first (rarity over the catalog's own pool).
 *
 * The coverage tripwire (`../find-coverage.test.ts`) proves every openable
 * kind reaches a catalog; this file proves what each catalog lets through.
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
import {
  searchObjectCatalogs,
  type FindObjects,
  type FoundObject,
} from "../find-objects.js";

const OWNER = randomUUID();
const STRANGER = randomUUID();
const WS = randomUUID();
const THEIR_WS = randomUUID();

const ids = {
  automation: randomUUID(),
  archivedAutomation: randomUUID(),
  theirAutomation: randomUUID(),
  session: randomUUID(),
  otherSession: randomUUID(),
  theirSession: randomUUID(),
  project: randomUUID(),
  theirProject: randomUUID(),
  goal: randomUUID(),
  theirGoal: randomUUID(),
  view: randomUUID(),
  theirView: randomUUID(),
  document: randomUUID(),
  deletedDocument: randomUUID(),
  theirDocument: randomUUID(),
  skill: randomUUID(),
  rule: randomUUID(),
  theirSkill: randomUUID(),
};

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
  for (const [id, name] of [
    [OWNER, "Owner"],
    [STRANGER, "Stranger"],
  ] as const) {
    await q(
      `insert into users (id, email, name, user_type) values ($1, $2, $3, 'human')`,
      [id, `${name.toLowerCase()}@x.test`, name]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'Sales', $2), ($3, 'Theirs', $4)`,
    [WS, OWNER, THEIR_WS, STRANGER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner'), ($4, $5, $6, 'owner')`,
    [randomUUID(), WS, OWNER, randomUUID(), THEIR_WS, STRANGER]
  );

  await q(
    `insert into automations (id, workspace_id, created_by, name, description, trigger_type, status) values
      ($1, $2, $3, 'Weekly pipeline digest', 'Posts the sales pipeline every Monday', 'cron', 'active'),
      ($4, $2, $3, 'Old pipeline digest', null, 'cron', 'archived'),
      ($5, $6, $7, 'Their pipeline digest', null, 'cron', 'active')`,
    [
      ids.automation,
      WS,
      OWNER,
      ids.archivedAutomation,
      ids.theirAutomation,
      THEIR_WS,
      STRANGER,
    ]
  );
  await q(
    `insert into focus_sessions (id, workspace_id, user_id, title, goal, status) values
      ($1, $2, $3, 'Build the pipeline dashboard', 'A bento for the sales pipeline', 'closed'),
      ($4, $2, $3, 'Pipeline cleanup', 'Dedupe deals', 'active'),
      ($5, $6, $7, 'Their pipeline dashboard', 'theirs', 'active')`,
    [
      ids.session,
      WS,
      OWNER,
      ids.otherSession,
      ids.theirSession,
      THEIR_WS,
      STRANGER,
    ]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, description, status) values
      ($1, $2, $3, 'Pipeline revamp', 'Rebuild the sales pipeline', 'active'),
      ($4, $5, null, 'Their pipeline project', null, 'active')`,
    [ids.project, OWNER, WS, ids.theirProject, STRANGER]
  );
  await q(
    `insert into project_tracks (id, project_id, user_id, name, status) values
      ($1, $2, $3, 'Pipeline visible to the team', 'active'),
      ($4, $5, $6, 'Their pipeline goal', 'active')`,
    [ids.goal, ids.project, OWNER, ids.theirGoal, ids.theirProject, STRANGER]
  );
  await q(
    `insert into views (id, workspace_id, user_id, type, name, description) values
      ($1, $2, $3, 'kanban', 'Pipeline board', null),
      ($4, null, $5, 'kanban', 'Their pipeline board', null)`,
    [ids.view, WS, OWNER, ids.theirView, STRANGER]
  );
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, deleted_at) values
      ($1, $2, $3, 'Pipeline spec', 'markdown', null),
      ($4, $2, $3, 'Deleted pipeline spec', 'markdown', now()),
      ($5, $6, null, 'Their pipeline notes', 'markdown', null)`,
    [ids.document, OWNER, WS, ids.deletedDocument, ids.theirDocument, STRANGER]
  );
  await q(
    `insert into skills (id, workspace_id, user_id, kind, scope, name, slug, description, status, approved, tags, topics) values
      ($1, null, null, 'instruction', 'pod', 'Synap — UI generation', 'system/synap-ui/skill', 'Build views and dashboards over a pipeline', 'active', true, '{}', '{}'),
      ($2, $3, $4, 'instruction', 'workspace', 'Pipeline deals need an owner', 'rules/pipeline-owner', 'Every pipeline deal has an owner', 'active', true, '{rule}', '{}'),
      ($5, null, $6, 'instruction', 'user', 'Their pipeline habit', 'u/their-pipeline', null, 'active', true, '{}', '{}')`,
    [ids.skill, ids.rule, WS, OWNER, ids.theirSkill, STRANGER]
  );
}, 120_000);

function matches(block: FindObjects | undefined): FoundObject[] {
  expect(block, "catalog block missing").toBeDefined();
  if (!block || "error" in block) {
    throw new Error(`catalog read failed: ${JSON.stringify(block)}`);
  }
  return block.matches;
}

async function find(query: string, userId = OWNER) {
  return searchObjectCatalogs({
    query,
    userId,
    workspaceId: null,
    catalogs: [
      "skills",
      "automations",
      "sessions",
      "goals",
      "projects",
      "views",
      "documents",
    ],
    limit: 5,
  });
}

describe("synap_find object catalogs — floors and reachability on real SQL", () => {
  it("finds the reader's own row in every catalog, with how to open it", async () => {
    const r = await find("pipeline");
    const expectOne = (
      catalog: keyof typeof r,
      id: string,
      kind: FoundObject["kind"]
    ) => {
      const row = matches(r[catalog]).find((m) => m.id === id);
      expect(row, `${catalog} did not find ${kind}`).toBeDefined();
      expect(row!.kind).toBe(kind);
      expect(row!.open).toMatch(new RegExp(`/open/${id}$`));
      expect(row!.why).toBeTruthy();
      expect(row!.termCoverage).toEqual({ hit: 1, of: 1 });
    };
    expectOne("automations", ids.automation, "automation");
    expectOne("sessions", ids.session, "session");
    expectOne("sessions", ids.otherSession, "session");
    expectOne("projects", ids.project, "project");
    expectOne("goals", ids.goal, "goal");
    expectOne("views", ids.view, "view");
    expectOne("documents", ids.document, "document");
    expectOne("skills", ids.skill, "skill");
    expectOne("skills", ids.rule, "rule");
    const skill = matches(r.skills).find((m) => m.id === ids.skill)!;
    expect(skill.ref).toBe("system/synap-ui/skill");
  });

  it("never names a row the reader cannot see, an archived automation or a deleted document", async () => {
    const r = await find("pipeline");
    const seen = new Set(
      Object.values(r).flatMap((b) => matches(b).map((m) => m.id))
    );
    for (const hidden of [
      ids.theirAutomation,
      ids.archivedAutomation,
      ids.theirSession,
      ids.theirProject,
      ids.theirGoal,
      ids.theirView,
      ids.deletedDocument,
      ids.theirDocument,
      ids.theirSkill,
    ]) {
      expect(seen.has(hidden), `leaked ${hidden}`).toBe(false);
    }
    // Non-vacuity: the stranger DOES see their own rows through the same doors.
    const theirs = await find("pipeline", STRANGER);
    const theirSeen = new Set(
      Object.values(theirs).flatMap((b) => matches(b).map((m) => m.id))
    );
    expect(theirSeen.has(ids.theirSession)).toBe(true);
    expect(theirSeen.has(ids.theirDocument)).toBe(true);
    expect(theirSeen.has(ids.session)).toBe(false);
  });

  it("ranks the better match first (rarity over the catalog's own pool)", async () => {
    const r = await find("pipeline dashboard");
    const sessions = matches(r.sessions);
    expect(sessions[0]!.id).toBe(ids.session);
    expect(sessions[0]!.confidence).toBe(1);
    expect(sessions[0]!.termCoverage).toEqual({ hit: 2, of: 2 });
  });

  it("a query no row shares is searched-and-empty, not an error", async () => {
    const r = await find("xyzzy plugh");
    for (const block of Object.values(r)) expect(matches(block)).toEqual([]);
  });
});
