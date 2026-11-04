/**
 * REAL-POSTGRES (PGlite) test for the before → after preview of a pending data
 * change (finding 4e4b2858), driven by the REAL manifest entry
 * `content-os.post-at-idea-into-idea` and the REAL engine dry run.
 *
 * The fixture is shaped like the founder's pod on 4 Nov (31 posts at Idea: 25
 * moved, 2 kept for a campaign, 4 for a date, a series and a campaign), scaled
 * down, and each row rules a wrong rule out:
 *   - 3 posts at Idea with nothing planned, and one with an EMPTY series: the
 *     four that move ("a key present means planned" is wrong);
 *   - 2 with a campaign only, 4 with a date, a series and a campaign: two kept
 *     groups, each named by WHICH fields it holds, with its own count;
 *   - a Briefed post and a deleted one: never looked at;
 *   - field and kind labels that differ from their keys: the words are the
 *     labels, never the slugs;
 *   - a label read that fails: the count, the groups and the titles stay, in
 *     slugs (an empty result and a failed read are different facts).
 * DDL: hand-written, only the columns the op and the preview read.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { LIFECYCLE_PROJECTION_TEST_SCHEMA } from "./lifecycle-projection-test-schema.js";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { CONVERSION_MANIFEST } from "./manifest.js";
import { pendingTemplateDataChanges } from "./data-changes.js";
import { readDataChangeWords } from "./data-change-preview.js";

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

/** A sql whose every query fails: a label read that cannot reach its tables. */
function failingSql(): Sql {
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const frag: any = new Frag(strings as unknown as string[], values);
    frag.then = (_resolve: any, reject: any) =>
      Promise.reject(new Error('relation "profiles" does not exist')).then(
        undefined,
        reject
      );
    return frag;
  };
  return sql as Sql;
}

const SCHEMA = `
CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text,
  plural text,
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
  title text,
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
CREATE TABLE property_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text,
  profile_id uuid,
  constraints jsonb,
  ui_hints jsonb DEFAULT '{}'
);
`;

const KEY = "content-os.post-at-idea-into-idea";
const WS = "9f93c23b-4774-48ec-83b0-aaa570f5441d";
const USER = "user-1";
/** The Content OS template's profile slugs this op touches. */
const CONTENT_OS = ["post", "idea"];

let db: PGlite;
let sql: Sql;
const q = async (text: string, params: unknown[] = []) =>
  (await db.query(text, params)).rows as any[];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA + LIFECYCLE_PROJECTION_TEST_SCHEMA);
  sql = makePgliteSql(db);
}, 120_000);

/** A booted pod: every op ledgered except the one under test. */
beforeEach(async () => {
  await db.exec(
    `DROP TABLE IF EXISTS "_conversions"; TRUNCATE profiles, entities, relations, property_defs, profile_properties;
     CREATE TABLE "_conversions" (
       "id" serial PRIMARY KEY, "op_key" text NOT NULL UNIQUE,
       "applied_at" timestamptz NOT NULL DEFAULT now(),
       "dry_run" boolean NOT NULL DEFAULT false,
       "counts" jsonb NOT NULL DEFAULT '{}', "error" text)`
  );
  for (const op of CONVERSION_MANIFEST.ops) {
    if (op.opKey === KEY) continue;
    await q(`INSERT INTO "_conversions" (op_key) VALUES ($1)`, [op.opKey]);
  }
});
afterAll(async () => {
  await db?.close();
});

async function profile(slug: string, displayName: string) {
  const [row] = await q(
    `INSERT INTO profiles (slug, display_name, workspace_id) VALUES ($1, $2, $3) RETURNING id`,
    [slug, displayName, WS]
  );
  return row.id as string;
}
/** A field of a kind, with its label and (for a lifecycle) its options. */
async function field(
  profileId: string,
  slug: string,
  label: string,
  options?: Array<{ key: string; label?: string; category: string }>
) {
  const [def] = await q(
    `INSERT INTO property_defs (slug, profile_id, constraints, ui_hints) VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      slug,
      profileId,
      JSON.stringify(options ? { enumOptions: options } : {}),
      JSON.stringify({ label }),
    ]
  );
  await q(
    `INSERT INTO profile_properties (profile_id, property_def_id, is_lifecycle) VALUES ($1, $2, $3)`,
    [profileId, def.id, !!options]
  );
}
async function post(
  profileId: string,
  title: string,
  props: object,
  deleted = false
) {
  await q(
    `INSERT INTO entities (profile_id, user_id, workspace_id, type, title, properties, status, deleted_at)
     VALUES ($1, $2, $3, 'post', $4, $5, $6, ${deleted ? "now()" : "NULL"})`,
    [
      profileId,
      USER,
      WS,
      title,
      JSON.stringify(props),
      (props as any)["post-status"],
    ]
  );
}

const CAMPAIGN = "1414853d-82ee-4f4a-a7a5-e56cd18442b4";
const SERIES = "7c1e5b0e-3c55-4a43-9a51-6b8f0e1d2a77";

async function seed() {
  const p = await profile("post", "Post");
  const i = await profile("idea", "Idea");
  await field(p, "post-status", "Status", [
    { key: "Idea", label: "Idea", category: "open" },
    { key: "Briefed", category: "active" },
  ]);
  await field(i, "idea-status", "Status", [
    { key: "New", label: "New", category: "open" },
  ]);
  await field(p, "publish-date", "Publish date");
  await field(p, "post-series", "Series");
  await field(p, "post-campaign", "Campaign");

  const atIdea = { "post-status": "Idea" };
  await post(p, "Fewer agents, less randomness", atIdea);
  await post(p, "One backend per person", atIdea);
  await post(p, "Why Synap exists", atIdea);
  await post(p, "An empty series is no plan", {
    ...atIdea,
    "post-series": "",
  });
  for (const t of ["Carousel: three scales", "Carousel: your own agent"])
    await post(p, t, { ...atIdea, "post-campaign": CAMPAIGN });
  for (const t of ["Post 08", "Carousel 07", "Video 06", "Carousel 05"])
    await post(p, t, {
      ...atIdea,
      "publish-date": "2026-10-29T00:00:00.000Z",
      "post-series": SERIES,
      "post-campaign": CAMPAIGN,
    });
  await post(p, "Already briefed", { "post-status": "Briefed" });
  await post(p, "Deleted idea", atIdea, true);
}

const MOVING = [
  "An empty series is no plan",
  "Fewer agents, less randomness",
  "One backend per person",
  "Why Synap exists",
];

describe("the preview of content-os.post-at-idea-into-idea", () => {
  it("draws posts at Idea → ideas at New, in labels, with the kept posts grouped by why", async () => {
    await seed();
    const [change, ...rest] = await pendingTemplateDataChanges(sql, CONTENT_OS);
    expect(rest).toEqual([]);
    expect(change).toMatchObject({ opKey: KEY, affected: 4 });

    expect(change!.preview).toEqual({
      change: "rekind",
      from: {
        kind: { key: "post", label: "Post", plural: "Posts" },
        detail: { as: "status", label: { key: "Idea", label: "Idea" } },
        count: 4,
      },
      to: {
        kind: { key: "idea", label: "Idea", plural: "Ideas" },
        detail: { as: "status", label: { key: "New", label: "New" } },
        count: 4,
      },
      samples: { titles: MOVING, more: 0 },
      kept: {
        count: 6,
        groups: [
          {
            reason: "fieldsSet",
            fields: [{ key: "post-campaign", label: "Campaign" }],
            count: 2,
            samples: {
              titles: ["Carousel: three scales", "Carousel: your own agent"],
              more: 0,
            },
          },
          {
            reason: "fieldsSet",
            fields: [
              { key: "publish-date", label: "Publish date" },
              { key: "post-series", label: "Series" },
              { key: "post-campaign", label: "Campaign" },
            ],
            count: 4,
            samples: {
              titles: ["Carousel 05", "Carousel 07", "Post 08", "Video 06"],
              more: 0,
            },
          },
        ],
      },
    });

    // The terminal reads the same, in short lines, labels never slugs.
    expect(change!.description.split("\n").map((l) => l.trim())).toEqual([
      "Posts at Idea become Ideas (10 Posts looked at).",
      "Stay as Posts: 6.",
      "Campaign already set: 2.",
      "Publish date, Series and Campaign already set: 4.",
      "Post · Idea → Idea · New: 4. Same records: content, links and history are kept.",
    ]);
    expect(change!.description).not.toMatch(
      /post-campaign|publish-date|post-series|"post"/
    );
  });

  it("caps each title list and says how many more", async () => {
    const p = await profile("post", "Post");
    await profile("idea", "Idea");
    for (let n = 0; n < 30; n++)
      await post(p, `Idea ${String(n).padStart(2, "0")}`, {
        "post-status": "Idea",
      });
    const [change] = await pendingTemplateDataChanges(sql, CONTENT_OS);
    expect(change!.affected).toBe(30);
    expect(change!.preview!.samples.titles).toHaveLength(25);
    expect(change!.preview!.samples.titles[0]).toBe("Idea 00");
    expect(change!.preview!.samples.more).toBe(5);
    expect(change!.preview!.kept).toBeNull();
  });

  it("a label read that FAILS keeps the count, the groups and the titles, in slugs", async () => {
    await seed();
    const [change] = await pendingTemplateDataChanges(
      sql,
      CONTENT_OS,
      CONVERSION_MANIFEST,
      (_sql, terms) => readDataChangeWords(failingSql(), terms)
    );
    expect(change).toMatchObject({ opKey: KEY, affected: 4 });
    expect(change!.preview).toMatchObject({
      from: {
        kind: { key: "post", label: "post" },
        detail: { label: { key: "Idea", label: "Idea" } },
        count: 4,
      },
      to: { kind: { label: "idea" }, count: 4 },
      samples: { titles: MOVING, more: 0 },
      kept: { count: 6 },
    });
    expect(
      change!.preview!.kept!.groups.map((g) => [
        g.fields.map((f) => f.label),
        g.count,
      ])
    ).toEqual([
      [["post-campaign"], 2],
      [["publish-date", "post-series", "post-campaign"], 4],
    ]);

    // A words reader that throws outright: the same, never a lost change.
    const [thrown] = await pendingTemplateDataChanges(
      sql,
      CONTENT_OS,
      CONVERSION_MANIFEST,
      async () => {
        throw new Error("labels unreachable");
      }
    );
    expect(thrown).toMatchObject({ opKey: KEY, affected: 4 });
    expect(thrown!.preview!.from.kind.label).toBe("post");
  });

  it("a kind with no label shows its slug; a found label always wins", async () => {
    await seed();
    await q(`UPDATE profiles SET display_name = NULL WHERE slug = 'idea'`);
    const [change] = await pendingTemplateDataChanges(sql, CONTENT_OS);
    expect(change!.preview!.from.kind.label).toBe("Post");
    expect(change!.preview!.to.kind).toEqual({
      key: "idea",
      label: "idea",
      plural: "idea",
    });
  });
});
