/**
 * REAL-POSTGRES (PGlite) test for `content-os.post-at-idea-into-idea`
 * (rekindByStatus, decision b5c3f2f2), driven through the REAL manifest entry
 * and `runConversions`.
 *
 * Each fixture row rules a wrong rule out:
 *   - i1 (at Idea, nothing planned): the full move — same id, kind idea, mapped
 *     fields, idea-status New, the rest kept in system_data, its edge kept;
 *   - i2 carries a campaign, i3 a publish date: rules out "every post at Idea";
 *   - i4 carries an EMPTY series: rules out "a key present means planned";
 *   - b5 is Briefed: rules out "every post";
 *   - x6 is deleted: rules out "deleted things too".
 * A workspace with posts at Idea and no idea kind: the dry run counts them as
 * waiting and the apply refuses: it writes nothing and ledgers only its failure
 * (`error` set), so the op is retried once the target kind exists.
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
  entity_scope text DEFAULT 'workspace',
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
  system_data jsonb NOT NULL DEFAULT '{}',
  deleted_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  workspace_id uuid,
  source_entity_id uuid,
  target_entity_id uuid,
  type text NOT NULL,
  created_at timestamptz DEFAULT now()
);
`;

const KEY = "content-os.post-at-idea-into-idea";
const WS = "9f93c23b-4774-48ec-83b0-aaa570f5441d";
const WS2 = "05b3b548-bc39-4b09-bf64-e4e3d46d5d8f";
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
    `DROP TABLE IF EXISTS "_conversions"; TRUNCATE profiles, entities, relations, property_defs, profile_properties;`
  );
});
afterAll(async () => {
  await db?.close();
});

const errorsOf = (s: RunSummary) =>
  s.results.filter((r) => r.error).map((r) => `${r.opKey}: ${r.error}`);
const run = (options: RunOptions) =>
  runConversions(sql, selectManifestOps(CONVERSION_MANIFEST, [KEY]), options);

async function profile(slug: string, ws: string) {
  const [row] = await q(
    `INSERT INTO profiles (slug, display_name, workspace_id) VALUES ($1, $1, $2) RETURNING id`,
    [slug, ws]
  );
  return row.id as string;
}
async function lifecycle(profileId: string, slug: string, keys: string[][]) {
  const [def] = await q(
    `INSERT INTO property_defs (slug, constraints) VALUES ($1, $2) RETURNING id`,
    [
      slug,
      JSON.stringify({
        enumOptions: keys.map(([key, category]) => ({ key, category })),
      }),
    ]
  );
  await q(
    `INSERT INTO profile_properties (profile_id, property_def_id, is_lifecycle) VALUES ($1, $2, true)`,
    [profileId, def.id]
  );
}
async function entity(
  profileId: string,
  ws: string,
  props: object,
  deleted = false
) {
  const [row] = await q(
    `INSERT INTO entities (profile_id, user_id, workspace_id, type, properties, status, deleted_at)
     VALUES ($1, $2, $3, 'post', $4, $5, ${deleted ? "now()" : "NULL"}) RETURNING id`,
    [profileId, USER, ws, JSON.stringify(props), (props as any)["post-status"]]
  );
  return row.id as string;
}
const row = async (id: string) =>
  (
    await q(
      `SELECT e.type, p.slug AS profile, e.properties, e.system_data, e.status, e.status_category
         FROM entities e JOIN profiles p ON p.id = e.profile_id WHERE e.id = $1`,
      [id]
    )
  )[0];
/** The applied set, as the engine reads it (engine.ts header). */
const ledgered = async () =>
  (
    await q(
      `SELECT op_key FROM "_conversions" WHERE error IS NULL AND dry_run = false`
    )
  ).map((r) => r.op_key);
/** Failed runs: recorded with `error` set, so the next run retries the op. */
const failed = async () =>
  (
    await q(
      `SELECT op_key FROM "_conversions" WHERE error IS NOT NULL AND dry_run = false`
    )
  ).map((r) => r.op_key);

async function seed() {
  const post = await profile("post", WS);
  const idea = await profile("idea", WS);
  await lifecycle(post, "post-status", [
    ["Idea", "open"],
    ["Briefed", "active"],
  ]);
  await lifecycle(idea, "idea-status", [
    ["New", "open"],
    ["Used", "done"],
  ]);
  const pillar = await entity(await profile("pillar", WS), WS, {});
  const i1 = await entity(post, WS, {
    title: "One backend per person",
    content: "Original words",
    "post-status": "Idea",
    "post-pillar": pillar,
    "post-tags": ["source:ideas-doc"],
    "post-hook": "The simplest backend is a thousand backends.",
    "post-format": "Long Video",
  });
  await q(
    `INSERT INTO relations (user_id, workspace_id, source_entity_id, target_entity_id, type) VALUES ($1, $2, $3, $4, 'belongs_to_pillar')`,
    [USER, WS, i1, pillar]
  );
  const i2 = await entity(post, WS, {
    "post-status": "Idea",
    "post-campaign": "1414853d-82ee-4f4a-a7a5-e56cd18442b4",
  });
  const i3 = await entity(post, WS, {
    "post-status": "Idea",
    "publish-date": "2026-10-29T00:00:00.000Z",
  });
  const i4 = await entity(post, WS, {
    "post-status": "Idea",
    "post-series": "",
  });
  const b5 = await entity(post, WS, { "post-status": "Briefed" });
  const x6 = await entity(post, WS, { "post-status": "Idea" }, true);
  return { pillar, i1, i2, i3, i4, b5, x6 };
}

describe("content-os.post-at-idea-into-idea (rekindByStatus)", () => {
  it("turns the unplanned posts at Idea into ideas, keeping each row, and leaves the rest", async () => {
    const f = await seed();

    const preview = await run({ dryRun: true, destructiveTail: false });
    expect(errorsOf(preview), errorsOf(preview).join("\n")).toEqual([]);
    expect(preview.results[0].counts).toEqual({
      entitiesRekinded: 2,
      entitiesKeptByRule: 2,
    });
    expect((await row(f.i1)).type).toBe("post"); // the dry run wrote nothing

    const s = await run({ dryRun: false, destructiveTail: false });
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);
    expect(s.results[0].counts).toMatchObject({
      entitiesRekinded: 2,
      entitiesKeptByRule: 2,
    });

    // i1: same row, now an idea at New; mapped fields carried, the rest kept.
    const i1 = await row(f.i1);
    expect(i1).toMatchObject({
      type: "idea",
      profile: "idea",
      status: "New",
      status_category: "open",
    });
    expect(i1.properties).toEqual({
      title: "One backend per person",
      content: "Original words",
      "idea-pillar": f.pillar,
      "idea-tags": ["source:ideas-doc"],
      "idea-status": "New",
    });
    expect(i1.system_data).toEqual({
      convertedFrom: {
        kind: "post",
        conversion: KEY,
        properties: {
          "post-status": "Idea",
          "post-hook": "The simplest backend is a thousand backends.",
          "post-format": "Long Video",
        },
      },
    });
    expect(
      await q(
        `SELECT source_entity_id AS s FROM relations WHERE target_entity_id = $1`,
        [f.pillar]
      )
    ).toEqual([{ s: f.i1 }]);

    // i4: an empty series is not a plan.
    expect((await row(f.i4)).type).toBe("idea");
    // Planned, other status, deleted: untouched posts.
    for (const id of [f.i2, f.i3, f.b5, f.x6]) {
      const r = await row(id);
      expect(r.type, id).toBe("post");
      expect(r.system_data, id).toEqual({});
    }

    // Idempotent: a second run (ledger cleared) moves nothing.
    await db.exec(`DROP TABLE "_conversions"`);
    const again = await run({ dryRun: false, destructiveTail: false });
    expect(errorsOf(again)).toEqual([]);
    expect(again.results[0].counts).not.toHaveProperty("entitiesRekinded");
    expect(again.results[0].counts).toMatchObject({ entitiesKeptByRule: 2 });
  });

  it("with no idea kind in the space: the dry run says they wait, the apply refuses and writes nothing", async () => {
    const post = await profile("post", WS2);
    const p = await entity(post, WS2, { "post-status": "Idea" });
    await entity(post, WS2, { "post-status": "Idea", "post-series": "s1" });
    // An idea kind in ANOTHER space is not this space's target.
    await profile("idea", WS);

    const preview = await run({ dryRun: true, destructiveTail: false });
    expect(errorsOf(preview)).toEqual([]);
    expect(preview.results[0].counts).toEqual({
      entitiesKeptNoTarget: 1,
      entitiesKeptByRule: 1,
    });

    const s = await run({ dryRun: false, destructiveTail: false });
    expect(errorsOf(s).join("\n")).toMatch(/no "idea" kind exists/);
    expect((await row(p)).type).toBe("post");
    expect(await ledgered()).toEqual([]);
    expect(await failed()).toEqual([KEY]);
  });

  it("is deferred at boot and says what it does in one sentence", () => {
    const op = CONVERSION_MANIFEST.ops.find((o) => o.opKey === KEY);
    expect(op?.deferAtBoot).toBe(true);
    expect(describeConversionOp(op!)).toBe(
      'Turn each "post" at "Idea" into a "idea" at "New", keeping it and its links; one with a "publish-date", a "post-series", a "post-campaign" stays a "post".'
    );
  });
});
