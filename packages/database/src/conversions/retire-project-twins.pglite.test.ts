/**
 * REAL-POSTGRES (PGlite) test for `pt1.projects.retire-project-twins`
 * (retireProjectTwins, ticket 8e2c7018, founder approval d95793d1), driven
 * through the REAL manifest entry and `runConversions`.
 *
 * Each fixture row rules a wrong rule out:
 *   - t1 (a project's id, the reserved kind), t2 (a project's id on another
 *     kind), t3 (the reserved kind, no project): each shape of twin is retired;
 *   - n1 (a note filed into the project) is untouched, and its
 *     `belongs_to_project` edge to the project's id survives, as does t1's own
 *     edge: rules out "delete the twin's relations";
 *   - x4 (a twin already deleted) keeps its own deletion;
 *   - the note kind stays active: rules out "deactivate every kind".
 * Search: the twins' entity_vectors rows go, n1's stays; the entities search
 * stamp is cleared (the jobs boot then reindexes and prunes), others kept.
 * DDL: hand-written, only the columns the op touches (sibling convention).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { LIFECYCLE_PROJECTION_TEST_SCHEMA } from "./lifecycle-projection-test-schema.js";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { runConversions } from "./engine.js";
import type { RunOptions, RunSummary } from "./engine.js";
import { CONVERSION_MANIFEST } from "./manifest.js";
import { selectManifestOps } from "./select.js";
import { describeConversionOp } from "./data-changes.js";
import { selectProjectTwins } from "../utils/project-twins.js";

class Frag {
  constructor(
    readonly strings: readonly string[],
    readonly values: unknown[]
  ) {}
}

function flatten(frag: Frag): { text: string; params: unknown[] } {
  let text = "";
  const params: unknown[] = [];
  const walk = (strings: readonly string[], values: unknown[]) => {
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) {
        const v = values[i];
        if (v instanceof Frag) walk(v.strings, v.values);
        else {
          params.push(v);
          text += "$" + params.length;
        }
      }
    }
  };
  walk(frag.strings, frag.values);
  return { text, params };
}

function makePgliteSql(db: PGlite): Sql {
  const exec = async (text: string, params: unknown[]) => {
    const res = await db.query(text, params);
    const rows: any = res.rows ?? [];
    rows.count = (res as any).affectedRows ?? 0;
    return rows;
  };
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const frag: any = new Frag(strings as unknown as string[], values);
    frag.then = (resolve: any, reject: any) => {
      const { text, params } = flatten(frag);
      return exec(text, params).then(resolve, reject);
    };
    return frag;
  };
  sql.begin = async (fn: (tx: Sql) => Promise<unknown>) => {
    await exec("BEGIN", []);
    try {
      const r = await fn(sql);
      await exec("COMMIT", []);
      return r;
    } catch (e) {
      await exec("ROLLBACK", []);
      throw e;
    }
  };
  return sql as Sql;
}

const SCHEMA = `
CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text,
  profile_kind text DEFAULT 'kind',
  scope text DEFAULT 'workspace',
  workspace_id uuid,
  is_active boolean DEFAULT true,
  ui_hints jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid,
  user_id text,
  workspace_id uuid,
  type text,
  title text,
  properties jsonb DEFAULT '{}',
  system_data jsonb NOT NULL DEFAULT '{}',
  deleted_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text,
  name text
);
CREATE TABLE relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  source_entity_id uuid,
  target_entity_id uuid,
  type text NOT NULL
);
CREATE TABLE entity_vectors (
  entity_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  entity_type text NOT NULL
);
CREATE TABLE pod_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
`;

const KEY = "pt1.projects.retire-project-twins";
const WS = "6eb9e938-8a0b-44bb-b4f1-f37b0296308b";
const USER = "user-1";
const OLD_DELETE = "2026-07-18T00:00:00.000Z";

let db: PGlite;
let sql: Sql;
const q = async (text: string, params: unknown[] = []) =>
  (await db.query(text, params)).rows as any[];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA + LIFECYCLE_PROJECTION_TEST_SCHEMA);
  sql = makePgliteSql(db);
}, 120_000);
beforeEach(async () => {
  await db.exec(
    `DROP TABLE IF EXISTS "_conversions"; TRUNCATE profiles, entities, projects, relations, entity_vectors, pod_settings, property_defs, profile_properties;`
  );
});
afterAll(async () => {
  await db?.close();
});

const errorsOf = (s: RunSummary) =>
  s.results.filter((r) => r.error).map((r) => `${r.opKey}: ${r.error}`);
const run = (options: RunOptions) =>
  runConversions(sql, selectManifestOps(CONVERSION_MANIFEST, [KEY]), options);
const APPLY: RunOptions = { dryRun: false, destructiveTail: false };

async function profile(slug: string) {
  const [row] = await q(
    `INSERT INTO profiles (slug, display_name, workspace_id) VALUES ($1, $1, $2) RETURNING id`,
    [slug, WS]
  );
  return row.id as string;
}
async function project(name: string) {
  const [row] = await q(
    `INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id`,
    [USER, name]
  );
  return row.id as string;
}
async function entity(
  profileId: string,
  title: string,
  opts: { id?: string; deletedAt?: string } = {}
) {
  const [row] = await q(
    `INSERT INTO entities (id, profile_id, user_id, workspace_id, type, title, deleted_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, 'x', $5, $6) RETURNING id`,
    [opts.id ?? null, profileId, USER, WS, title, opts.deletedAt ?? null]
  );
  return row.id as string;
}
async function edge(source: string, target: string, type: string) {
  await q(
    `INSERT INTO relations (user_id, source_entity_id, target_entity_id, type) VALUES ($1, $2, $3, $4)`,
    [USER, source, target, type]
  );
}
async function vector(entityId: string) {
  await q(
    `INSERT INTO entity_vectors (entity_id, user_id, entity_type) VALUES ($1, $2, 'x')`,
    [entityId, USER]
  );
}
const entityRow = async (id: string) =>
  (
    await q(`SELECT deleted_at, system_data FROM entities WHERE id = $1`, [id])
  )[0];

async function seed() {
  const projectKind = await profile("project");
  const noteKind = await profile("note");
  const p1 = await project("Synap");
  const p2 = await project("Antoine in public");
  // The July twin: the project's id, the reserved kind.
  const t1 = await entity(projectKind, "Synap", { id: p1 });
  // A project's id on an ordinary kind.
  const t2 = await entity(noteKind, "Antoine in public", { id: p2 });
  // The reserved kind, no project behind it.
  const t3 = await entity(projectKind, "Side project");
  // Not a twin: a note filed into the project (its membership edge).
  const n1 = await entity(noteKind, "Launch notes");
  // A twin someone already deleted.
  const x4 = await entity(projectKind, "Old twin", { deletedAt: OLD_DELETE });
  await edge(n1, p1, "belongs_to_project");
  await edge(t1, n1, "relates_to");
  for (const id of [t1, t3, n1]) await vector(id);
  await q(`INSERT INTO pod_settings (settings) VALUES ($1)`, [
    JSON.stringify({
      searchIndexVersions: { entities: 2, documents: 1 },
      presenceSensitivity: "normal",
    }),
  ]);
  return { projectKind, noteKind, p1, p2, t1, t2, t3, n1, x4 };
}

describe("pt1.projects.retire-project-twins (retireProjectTwins)", () => {
  it("retires every project twin, keeps every relation, drops their search rows and deactivates the reserved kind", async () => {
    const f = await seed();

    const preview = await run({ dryRun: true, destructiveTail: false });
    expect(errorsOf(preview), errorsOf(preview).join("\n")).toEqual([]);
    expect(preview.results[0].counts).toMatchObject({
      projectTwinsRetired: 3,
      entityVectorsDropped: 2,
      profilesDeactivated: 1,
    });
    expect((await entityRow(f.t1)).deleted_at).toBeNull(); // wrote nothing

    const s = await run(APPLY);
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);
    expect(s.results[0]).toMatchObject({
      status: "applied",
      counts: {
        projectTwinsRetired: 3,
        entityVectorsDropped: 2,
        profilesDeactivated: 1,
      },
    });

    // Each twin is soft-deleted with a breadcrumb naming why.
    const reasons: Record<string, string[]> = {
      [f.t1]: ["id_is_a_project", "reserved_kind"],
      [f.t2]: ["id_is_a_project"],
      [f.t3]: ["reserved_kind"],
    };
    for (const [id, why] of Object.entries(reasons)) {
      const r = await entityRow(id);
      expect(r.deleted_at, id).not.toBeNull();
      expect(r.system_data, id).toEqual({
        retiredByConversion: { conversion: KEY, reasons: why },
      });
    }

    // Not a twin: untouched.
    expect(await entityRow(f.n1)).toEqual({
      deleted_at: null,
      system_data: {},
    });
    // Already deleted: its own deletion kept.
    const x4 = await entityRow(f.x4);
    expect(new Date(x4.deleted_at).toISOString()).toBe(OLD_DELETE);
    expect(x4.system_data).toEqual({});

    // Every relation survives: the project's membership and the twin's own.
    expect(
      await q(
        `SELECT source_entity_id AS s, target_entity_id AS t, type FROM relations ORDER BY type`
      )
    ).toEqual([
      { s: f.n1, t: f.p1, type: "belongs_to_project" },
      { s: f.t1, t: f.n1, type: "relates_to" },
    ]);

    // Search: the twins' vectors go, the note's stays; the entities stamp is
    // cleared so the jobs boot reindexes (and prunes), the rest is kept.
    expect(
      (await q(`SELECT entity_id FROM entity_vectors`)).map((r) => r.entity_id)
    ).toEqual([f.n1]);
    expect((await q(`SELECT settings FROM pod_settings`))[0].settings).toEqual({
      searchIndexVersions: { documents: 1 },
      presenceSensitivity: "normal",
    });

    // The reserved kind is deactivated; the note kind is not.
    const kinds = await q(`SELECT id, is_active FROM profiles`);
    expect(Object.fromEntries(kinds.map((k) => [k.id, k.is_active]))).toEqual({
      [f.projectKind]: false,
      [f.noteKind]: true,
    });

    // The diagnose predicate now finds no twin.
    expect(await selectProjectTwins(sql)).toEqual([]);
  });

  it("runs once and is recorded; a second pass changes nothing", async () => {
    const f = await seed();
    await run(APPLY);
    const firstDelete = (await entityRow(f.t1)).deleted_at;
    expect(
      (
        await q(
          `SELECT op_key FROM "_conversions" WHERE error IS NULL AND dry_run = false`
        )
      ).map((r) => r.op_key)
    ).toEqual([KEY]);

    const again = await run(APPLY);
    expect(again.results[0].status).toBe("skipped");

    // Even with the ledger cleared, nothing is left to retire.
    await db.exec(`DROP TABLE "_conversions"`);
    const rerun = await run(APPLY);
    expect(errorsOf(rerun)).toEqual([]);
    expect(rerun.results[0]).toMatchObject({ status: "noop", counts: {} });
    expect((await entityRow(f.t1)).deleted_at).toEqual(firstDelete);
  });

  it("runs at boot and says what it does in one sentence", () => {
    const op = CONVERSION_MANIFEST.ops.find((o) => o.opKey === KEY);
    expect(op?.op).toBe("retireProjectTwins");
    expect(op?.deferAtBoot).toBeUndefined();
    expect(describeConversionOp(op!)).toBe(
      "Retire the leftover copies of your projects stored as things, keeping everything filed into each project."
    );
  });
});
