/**
 * REAL-POSTGRES (PGlite) test for the homes H0 dev-lifecycle conversions,
 * driven through the REAL `CONVERSION_MANIFEST` entries (selected by opKey)
 * and `runConversions`, never a hand-built op.
 *
 * Each fixture row rules a WRONG rule out:
 *   - a story at `backlog` / `planned`: rules out moving every story aside
 *     (a whole-key rename) — only `in-review` rows may move;
 *   - a `task` at `storyStatus: in-review`: rules out a slug-blind remap;
 *   - a feature with BOTH a stray `status` and a `featureStatus`: rules out
 *     the stray key clobbering the lifecycle;
 *   - a feature whose stray `status` is unmapped: rules out dropping it.
 * DDL: the w12 sibling's (only the columns engine.ts touches).
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
`;

/** `run-conversions.ts --apply --destructive-tail` (operator). */
const OPERATOR: RunOptions = { dryRun: false, destructiveTail: true };

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
    `DROP TABLE IF EXISTS "_conversions"; TRUNCATE profiles, entities, entity_facets, property_defs, profile_properties;`
  );
});

afterAll(async () => {
  await db?.close();
});

async function profile(
  slug: string,
  kind: "kind" | "role",
  scope = "shared"
): Promise<string> {
  const [row] = await q(
    `INSERT INTO profiles (slug, display_name, profile_kind, scope) VALUES ($1, $1, $2, $3) RETURNING id`,
    [slug, kind, scope]
  );
  return row.id;
}
async function entity(
  profileId: string,
  type: string,
  props: Record<string, unknown> = {}
) {
  const [row] = await q(
    `INSERT INTO entities (profile_id, type, properties) VALUES ($1, $2, $3) RETURNING id`,
    [profileId, type, JSON.stringify(props)]
  );
  return row.id as string;
}
const errorsOf = (s: RunSummary) =>
  s.results.filter((r) => r.error).map((r) => `${r.opKey}: ${r.error}`);
const run = (keys: string[]) =>
  runConversions(sql, selectManifestOps(CONVERSION_MANIFEST, keys), OPERATOR);

const STORY_FOLD = [
  "h0.devplane-story.in-review-aside",
  "h0.devplane-story.in-review-into-lifecycle",
];
const STATUS_FOLDS = [
  "h0.devplane-feature.status-into-lifecycle",
  "h0.devplane-story.status-into-lifecycle",
];
const propsOf = async (id: string) =>
  (await q(`SELECT properties FROM entities WHERE id = $1`, [id]))[0]
    .properties as Record<string, unknown>;

describe("h0 story in-review → In feature (in-progress)", () => {
  it("moves only in-review stories, leaves no aside key, and is idempotent", async () => {
    const story = await profile("devplane_story", "kind", "workspace");
    const task = await profile("task", "kind", "system");
    const s1 = await entity(story, "devplane_story", {
      storyStatus: "in-review",
      priority: "high",
    });
    const s2 = await entity(story, "devplane_story", {
      storyStatus: "backlog",
    });
    const s3 = await entity(story, "devplane_story", {
      storyStatus: "planned",
    });
    const t1 = await entity(task, "task", { storyStatus: "in-review" });

    const s = await run(STORY_FOLD);
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);

    expect(await propsOf(s1)).toEqual({
      storyStatus: "in-progress",
      priority: "high",
    });
    expect(await propsOf(s2)).toEqual({ storyStatus: "backlog" });
    expect(await propsOf(s3)).toEqual({ storyStatus: "planned" });
    expect(await propsOf(t1)).toEqual({ storyStatus: "in-review" });

    const again = await run(STORY_FOLD);
    expect(errorsOf(again)).toEqual([]);
    expect(await propsOf(s1)).toEqual({
      storyStatus: "in-progress",
      priority: "high",
    });
  });
});

const LEGACY_VALUES = [
  "h0.devplane-feature.legacy-values-aside",
  "h0.devplane-feature.legacy-values-into-lifecycle",
  "h0.devplane-story.planned-aside",
  "h0.devplane-story.planned-into-lifecycle",
];

describe("h0 legacy dev-lifecycle VALUES → the declared keys (homes A5)", () => {
  it("planned/in-progress/error fold by meaning; declared values and other kinds untouched; idempotent", async () => {
    const feature = await profile("devplane_feature", "kind", "workspace");
    const story = await profile("devplane_story", "kind", "workspace");
    const task = await profile("task", "kind", "system");
    const f1 = await entity(feature, "devplane_feature", {
      featureStatus: "planned",
      priority: "p1",
    });
    const f2 = await entity(feature, "devplane_feature", {
      featureStatus: "in-progress",
    });
    const f3 = await entity(feature, "devplane_feature", {
      featureStatus: "error",
    });
    // Declared values never move aside (rules out a whole-key rename).
    const f4 = await entity(feature, "devplane_feature", {
      featureStatus: "in_review",
    });
    const s1 = await entity(story, "devplane_story", {
      storyStatus: "planned",
    });
    // A story's own `in-progress` is DECLARED (In feature): never touched.
    const s2 = await entity(story, "devplane_story", {
      storyStatus: "in-progress",
    });
    // Another kind holding the same values: rules out a slug-blind remap.
    const t1 = await entity(task, "task", {
      featureStatus: "planned",
      storyStatus: "planned",
    });

    const s = await run(LEGACY_VALUES);
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);

    expect(await propsOf(f1)).toEqual({
      featureStatus: "backlog",
      priority: "p1",
    });
    expect(await propsOf(f2)).toEqual({ featureStatus: "in_progress" });
    expect(await propsOf(f3)).toEqual({ featureStatus: "in_progress" });
    expect(await propsOf(f4)).toEqual({ featureStatus: "in_review" });
    expect(await propsOf(s1)).toEqual({ storyStatus: "backlog" });
    expect(await propsOf(s2)).toEqual({ storyStatus: "in-progress" });
    expect(await propsOf(t1)).toEqual({
      featureStatus: "planned",
      storyStatus: "planned",
    });

    const again = await run(LEGACY_VALUES);
    expect(errorsOf(again)).toEqual([]);
    expect(await propsOf(f3)).toEqual({ featureStatus: "in_progress" });
    expect(await propsOf(s1)).toEqual({ storyStatus: "backlog" });
  });
});

describe("x2 decision `status` → decisionStatus (homes X2)", () => {
  it("folds decision states; a set decisionStatus wins; TASK values and other kinds kept", async () => {
    const decision = await profile("decision", "kind", "pod");
    const task = await profile("task", "kind", "system");
    const d1 = await entity(decision, "decision", {
      status: "accepted",
      title: "x",
    });
    const d2 = await entity(decision, "decision", {
      status: "proposed",
      decisionStatus: "rejected",
    });
    const d3 = await entity(decision, "decision", { status: "todo" });
    const d4 = await entity(decision, "decision", {});
    const t1 = await entity(task, "task", { status: "accepted" });

    const s = await run(["x2.decision.status-into-lifecycle"]);
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);

    expect(await propsOf(d1)).toEqual({
      decisionStatus: "accepted",
      title: "x",
    });
    expect(await propsOf(d2)).toEqual({ decisionStatus: "rejected" });
    expect(await propsOf(d3)).toEqual({ status: "todo" });
    // No status at all stays no status — never folded into a guess.
    expect(await propsOf(d4)).toEqual({});
    expect(await propsOf(t1)).toEqual({ status: "accepted" });
  });
});

describe("h0 stray `status` → the dev lifecycles", () => {
  it("folds the stray key; a lifecycle value already set wins; unmapped is kept", async () => {
    const feature = await profile("devplane_feature", "kind", "workspace");
    const story = await profile("devplane_story", "kind", "workspace");
    const f1 = await entity(feature, "devplane_feature", { status: "todo" });
    const f2 = await entity(feature, "devplane_feature", {
      status: "in-progress",
      featureStatus: "in_review",
    });
    const f3 = await entity(feature, "devplane_feature", { status: "stable" });
    const f4 = await entity(feature, "devplane_feature", { status: "weird" });
    const st1 = await entity(story, "devplane_story", { status: "building" });

    const s = await run(STATUS_FOLDS);
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);

    expect(await propsOf(f1)).toEqual({ featureStatus: "backlog" });
    expect(await propsOf(f2)).toEqual({ featureStatus: "in_review" });
    expect(await propsOf(f3)).toEqual({ featureStatus: "done" });
    expect(await propsOf(f4)).toEqual({ status: "weird" });
    expect(await propsOf(st1)).toEqual({ storyStatus: "in-progress" });
  });
});
