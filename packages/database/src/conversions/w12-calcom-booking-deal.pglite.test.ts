/**
 * REAL-POSTGRES (PGlite) test for D7 `w12.calcom.booking-deal-into-lead`,
 * driven through the REAL manifest entry and `runConversions`.
 *
 * Each fixture row rules a wrong rule out:
 *   - d1 (untouched, shape B) with a company and its event: the full turn —
 *     lead attached at engaged, attended_by, works_at; archived only on the
 *     destructive tail;
 *   - d2 carries an `amount` (edited): rules out "every booking deal";
 *   - d3 (shape A) whose person is already a `qualified` lead (active): rules
 *     out "set engaged" — the forward rule keeps it;
 *   - d4 whose person is a `new` lead (open): rules out "never touch an
 *     existing lead";
 *   - d5 has a note linked (an edge someone added): edited, kept;
 *   - d6 has no linked person: kept, counted.
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
  scope text DEFAULT 'system',
  entity_scope text DEFAULT 'pod',
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
  properties jsonb DEFAULT '{}',
  deleted_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE entity_facets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid,
  profile_id uuid,
  user_id text NOT NULL,
  workspace_id uuid,
  status text,
  context_entity_id uuid,
  properties jsonb DEFAULT '{}',
  metadata jsonb DEFAULT '{}',
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  workspace_id uuid,
  source_entity_id uuid,
  target_entity_id uuid,
  type text NOT NULL,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);
`;

const KEY = "w12.calcom.booking-deal-into-lead";
const WS = "499328b7-fd35-4143-b1bc-67b9e45d9b4b";
const USER = "user-1";

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
    `DROP TABLE IF EXISTS "_conversions"; TRUNCATE profiles, entities, entity_facets, relations, property_defs, profile_properties;`
  );
});
afterAll(async () => {
  await db?.close();
});

const errorsOf = (s: RunSummary) =>
  s.results.filter((r) => r.error).map((r) => `${r.opKey}: ${r.error}`);
const run = (options: RunOptions) =>
  runConversions(sql, selectManifestOps(CONVERSION_MANIFEST, [KEY]), options);

async function profile(slug: string, kind: "kind" | "role" = "kind") {
  const [row] = await q(
    `INSERT INTO profiles (slug, display_name, profile_kind, scope) VALUES ($1, $1, $2, 'shared') RETURNING id`,
    [slug, kind]
  );
  return row.id as string;
}
async function entity(profileId: string, type: string, props: object = {}) {
  const [row] = await q(
    `INSERT INTO entities (profile_id, user_id, workspace_id, type, properties) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [profileId, USER, WS, type, JSON.stringify(props)]
  );
  return row.id as string;
}
async function link(source: string, target: string, type: string) {
  await q(
    `INSERT INTO relations (user_id, workspace_id, source_entity_id, target_entity_id, type) VALUES ($1, $2, $3, $4, $5)`,
    [USER, WS, source, target, type]
  );
}
async function leadFacet(entityId: string, lead: string, stage: string) {
  await q(
    `INSERT INTO entity_facets (entity_id, profile_id, user_id, workspace_id, properties) VALUES ($1, $2, $3, $4, $5)`,
    [entityId, lead, USER, WS, JSON.stringify({ leadStage: stage })]
  );
}
const leadOf = async (personId: string) =>
  q(
    `SELECT f.properties->>'leadStage' AS stage, f.status, f.status_category
       FROM entity_facets f JOIN profiles p ON p.id = f.profile_id
      WHERE f.entity_id = $1 AND p.slug = 'lead' AND f.deleted_at IS NULL`,
    [personId]
  );
const edges = (type: string) =>
  q(
    `SELECT source_entity_id AS s, target_entity_id AS t FROM relations WHERE type = $1`,
    [type]
  );
const live = async (id: string) =>
  (await q(`SELECT deleted_at FROM entities WHERE id = $1`, [id]))[0]
    .deleted_at === null;

async function seed() {
  const deal = await profile("deal");
  const person = await profile("person");
  const company = await profile("company");
  const event = await profile("event");
  const lead = await profile("lead", "role");
  const [def] = await q(
    `INSERT INTO property_defs (slug, constraints) VALUES ('leadStage', $1) RETURNING id`,
    [
      JSON.stringify({
        enumOptions: [
          { key: "new", category: "open" },
          { key: "engaged", category: "active" },
          { key: "qualified", category: "active" },
          { key: "disqualified", category: "lost" },
        ],
      }),
    ]
  );
  await q(
    `INSERT INTO profile_properties (profile_id, property_def_id, is_lifecycle) VALUES ($1, $2, true)`,
    [lead, def.id]
  );
  const booking = (uid: string, extra: object = {}) =>
    entity(deal, "deal", {
      commercialStage: "draft",
      source: "cal.com",
      calBookingUid: uid,
      ...extra,
    });

  const p1 = await entity(person, "person");
  const c1 = await entity(company, "company");
  const d1 = await booking("u1");
  const ev1 = await entity(event, "event", { calBookingUid: "u1" });
  await link(p1, d1, "linked_to_deal");
  await link(c1, d1, "linked_to_deal");

  const p2 = await entity(person, "person");
  const d2 = await booking("u2", { amount: 5000 });
  await link(p2, d2, "linked_to_deal");

  const p3 = await entity(person, "person");
  await leadFacet(p3, lead, "qualified");
  const d3 = await entity(deal, "deal", {
    dealStage: "lead",
    source: "cal.com",
    calBookingUid: "u3",
  });
  await link(p3, d3, "linked_to_deal");

  const p4 = await entity(person, "person");
  await leadFacet(p4, lead, "new");
  const d4 = await booking("u4");
  await link(p4, d4, "linked_to_deal");

  const p5 = await entity(person, "person");
  const d5 = await booking("u5");
  await link(p5, d5, "linked_to_deal");
  const note = await entity(await profile("note"), "note");
  await link(note, d5, "mentions");

  const d6 = await booking("u6");
  return { p1, c1, d1, ev1, p2, d2, p3, d3, p4, d4, p5, d5, d6 };
}

describe("D7 w12.calcom.booking-deal-into-lead", () => {
  it("turns untouched booking deals into leads, keeps edited ones, archives the converted deals", async () => {
    const f = await seed();
    // The engine applies an op with a destructive tail only WITH it (else the
    // ledgered op could never archive); the dry run previews it, writing nothing.
    const preview = await run({ dryRun: true, destructiveTail: false });
    expect(errorsOf(preview), errorsOf(preview).join("\n")).toEqual([]);
    expect(await leadOf(f.p1)).toEqual([]);

    const s = await run({ dryRun: false, destructiveTail: true });
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);
    expect(s.results[0].counts).toMatchObject({
      dealsConverted: 3,
      dealsKeptEdited: 2,
      dealsKeptNoPerson: 1,
      facetsCreated: 1,
      leadsAdvanced: 1,
      relationsCreated: 2,
      entitiesArchived: 3,
    });

    // d1: lead attached at engaged; the columns follow the projection.
    expect(await leadOf(f.p1)).toEqual([
      { stage: "engaged", status: "engaged", status_category: "active" },
    ]);
    expect(await edges("attended_by")).toEqual([{ s: f.ev1, t: f.p1 }]);
    expect(await edges("works_at")).toEqual([{ s: f.p1, t: f.c1 }]);
    // d3: a qualified (active) lead is never pulled back to engaged.
    expect((await leadOf(f.p3))[0].stage).toBe("qualified");
    // d4: a new (open) lead moves forward, its columns too.
    expect(await leadOf(f.p4)).toEqual([
      { stage: "engaged", status: "engaged", status_category: "active" },
    ]);
    // Edited / no-person deals: no lead made, the deal kept.
    expect(await leadOf(f.p2)).toEqual([]);
    expect(await leadOf(f.p5)).toEqual([]);
    for (const d of [f.d2, f.d5, f.d6]) expect(await live(d)).toBe(true);
    // Converted deals archived (soft-deleted, the row survives).
    for (const d of [f.d1, f.d3, f.d4]) expect(await live(d)).toBe(false);

    // Idempotent: a second run (ledger cleared) changes nothing.
    await db.exec(`DROP TABLE "_conversions"`);
    const again = await run({ dryRun: false, destructiveTail: true });
    expect(errorsOf(again)).toEqual([]);
    expect(again.results[0].counts).not.toHaveProperty("facetsCreated");
    expect(again.results[0].counts).not.toHaveProperty("relationsCreated");
    expect(again.results[0].counts).not.toHaveProperty("dealsConverted");
  });
});
