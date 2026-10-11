/**
 * REAL-POSTGRES (PGlite) test for the work-model wave-0 conversions — the three
 * op types `foldRoleIntoStatus`, `remapFacetPropertyValues`, `renameProfile`,
 * driven through the REAL `CONVERSION_MANIFEST` entries (selected by opKey)
 * and `runConversions`, never a hand-built op.
 *
 * Each fixture row is chosen to rule a WRONG rule out:
 *   - e4 wears churned + client + partner: rules out "every target" and
 *     "partner first" (only the client may take the status);
 *   - e1's client already has `notes`: rules out a fold that clobbers;
 *   - e3 wears no target: rules out silently dropping the state;
 *   - lead f2 (explicit leadStage + stale overlay): rules out "overlay wins";
 *   - lead f1 (default `prospect` + overlay): rules out "leadStage wins";
 *   - a `production-recipe` beside `content-pipeline`: rules out a rename
 *     that mints a twin.
 * DDL: hand-written, only the columns engine.ts touches (sibling convention).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
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

const WS = "499328b7-fd35-4143-b1bc-67b9e45d9b4b";
const USER = "user-1";
/** `run-conversions.ts --apply --destructive-tail` (operator). */
const OPERATOR: RunOptions = { dryRun: false, destructiveTail: true };

let db: PGlite;
let sql: Sql;
const q = async (text: string, params: unknown[] = []) =>
  (await db.query(text, params)).rows as any[];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  sql = makePgliteSql(db);
}, 120_000);

beforeEach(async () => {
  await db.exec(
    `DROP TABLE IF EXISTS "_conversions"; TRUNCATE profiles, entities, entity_facets;`
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
async function facet(
  entityId: string,
  profileId: string,
  props: Record<string, unknown> = {}
) {
  const [row] = await q(
    `INSERT INTO entity_facets (entity_id, profile_id, user_id, workspace_id, properties)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [entityId, profileId, USER, WS, JSON.stringify(props)]
  );
  return row.id as string;
}
const liveFacets = (entityId: string, slug: string) =>
  q(
    `SELECT f.properties FROM entity_facets f JOIN profiles p ON p.id = f.profile_id
     WHERE f.entity_id = $1 AND p.slug = $2 AND f.deleted_at IS NULL`,
    [entityId, slug]
  );
const errorsOf = (s: RunSummary) =>
  s.results.filter((r) => r.error).map((r) => `${r.opKey}: ${r.error}`);
const run = (keys: string[]) =>
  runConversions(sql, selectManifestOps(CONVERSION_MANIFEST, keys), OPERATOR);

describe("w12.role.churned-into-status — a state is never a role", () => {
  const KEY = "w12.role.churned-into-status";

  it("puts churned on the first role worn, attaches client when none, keeps existing values", async () => {
    const company = await profile("company", "kind", "system");
    const churned = await profile("churned", "role");
    const client = await profile("client", "role");
    const partner = await profile("partner", "role");

    const e1 = await entity(company, "company");
    await facet(e1, churned, { churnReason: "price", notes: "from churned" });
    await facet(e1, client, { clientStatus: "active", notes: "keep me" });
    const e2 = await entity(company, "company");
    await facet(e2, churned, { churnedDate: "2026-01-01" });
    await facet(e2, partner, { partnerStatus: "active" });
    const e3 = await entity(company, "company");
    await facet(e3, churned, { churnReason: "gone" });
    const e4 = await entity(company, "company");
    await facet(e4, churned, {});
    await facet(e4, client, { clientStatus: "active" });
    await facet(e4, partner, { partnerStatus: "active" });

    const s = await run([KEY]);
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);

    expect((await liveFacets(e1, "client"))[0].properties).toEqual({
      clientStatus: "churned",
      notes: "keep me", // never clobbered
      churnReason: "price",
    });
    expect((await liveFacets(e2, "partner"))[0].properties).toMatchObject({
      partnerStatus: "churned",
      churnedDate: "2026-01-01",
    });
    expect(await liveFacets(e2, "client")).toEqual([]);
    expect((await liveFacets(e3, "client"))[0].properties).toEqual({
      clientStatus: "churned",
      churnReason: "gone",
    });
    expect((await liveFacets(e4, "client"))[0].properties.clientStatus).toBe(
      "churned"
    );
    expect((await liveFacets(e4, "partner"))[0].properties.partnerStatus).toBe(
      "active"
    );

    for (const e of [e1, e2, e3, e4])
      expect(await liveFacets(e, "churned")).toEqual([]);
    // Soft-deleted, not lost: the four source rows survive with their props.
    const gone = await q(
      `SELECT metadata FROM entity_facets WHERE profile_id = $1 AND deleted_at IS NOT NULL`,
      [churned]
    );
    expect(gone).toHaveLength(4);
    // Destructive tail: the drained role row retires.
    const [row] = await q(
      `SELECT is_active, ui_hints FROM profiles WHERE id = $1`,
      [churned]
    );
    expect(row.is_active).toBe(false);
    expect(row.ui_hints.retired.reason).toBe(`conversion:${KEY}`);
  });

  it("is idempotent — a second run (ledger cleared) changes nothing", async () => {
    const company = await profile("company", "kind", "system");
    const churned = await profile("churned", "role");
    const client = await profile("client", "role");
    await profile("partner", "role");
    const e = await entity(company, "company");
    await facet(e, churned, {});
    await run([KEY]);
    const before = await q(
      `SELECT id, properties, deleted_at FROM entity_facets ORDER BY id`
    );
    await db.exec(`DROP TABLE "_conversions"`);
    const s = await run([KEY]);
    expect(errorsOf(s)).toEqual([]);
    expect(
      await q(
        `SELECT id, properties, deleted_at FROM entity_facets ORDER BY id`
      )
    ).toEqual(before);
    expect(await liveFacets(e, "client")).toHaveLength(1);
    void client;
  });
});

describe("w12.lead.* — leadStage is the lead's one lifecycle", () => {
  it("folds the overlay with the CRM app's precedence, then moves the old values", async () => {
    const person = await profile("person", "kind", "system");
    const lead = await profile("lead", "role");
    const f = async (props: Record<string, unknown>) => {
      const e = await entity(person, "person");
      await facet(e, lead, props);
      return e;
    };
    const f1 = await f({ leadStage: "prospect", lifecycleStage: "engaged" });
    const f2 = await f({ leadStage: "qualified", lifecycleStage: "outreach" });
    const f3 = await f({ leadStage: "lost" });
    const f4 = await f({ leadStage: "prospect" });
    const f5 = await f({ lifecycleStage: "researching" });

    const s = await run([
      "w12.lead.lifecycle-stage-fold",
      "w12.lead.legacy-stage-values",
    ]);
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);
    const stage = async (e: string) =>
      (await liveFacets(e, "lead"))[0].properties;
    expect(await stage(f1)).toEqual({ leadStage: "engaged" });
    expect(await stage(f2)).toEqual({ leadStage: "qualified" });
    expect(await stage(f3)).toEqual({ leadStage: "disqualified" });
    expect(await stage(f4)).toEqual({ leadStage: "new" });
    expect(await stage(f5)).toEqual({ leadStage: "researching" });
  });
});

describe("w12 renameProfile — pipeline names only the view", () => {
  it("renames content-pipeline in place (id kept), retypes entities, then its keys", async () => {
    const id = await profile("content-pipeline", "kind", "workspace");
    const e = await entity(id, "content-pipeline", {
      "pipeline-kind": "reel",
      "pipeline-mode": "fast",
    });
    const keys = [
      "w12.content.pipeline-kind-to-production-recipe",
      ...["kind", "platform", "mode", "script", "stages"].map(
        (k) => `w12.content.recipe-key.pipeline-${k}`
      ),
    ];
    const s = await run(keys);
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);
    const [p] = await q(
      `SELECT id, slug, display_name FROM profiles WHERE id = $1`,
      [id]
    );
    expect(p).toEqual({
      id,
      slug: "production-recipe",
      display_name: "Production recipe",
    });
    const [ent] = await q(
      `SELECT type, properties FROM entities WHERE id = $1`,
      [e]
    );
    expect(ent).toEqual({
      type: "production-recipe",
      properties: { "recipe-kind": "reel", "recipe-mode": "fast" },
    });
  });

  it("REFUSES when the target slug already exists beside it — a merge, never a twin", async () => {
    const id = await profile("content-pipeline", "kind", "workspace");
    await profile("production-recipe", "kind", "workspace");
    await entity(id, "content-pipeline");
    const s = await run(["w12.content.pipeline-kind-to-production-recipe"]);
    expect(errorsOf(s).join("\n")).toMatch(/that is a merge, not a rename/);
    const [p] = await q(`SELECT slug FROM profiles WHERE id = $1`, [id]);
    expect(p.slug).toBe("content-pipeline");
    expect((await q(`SELECT type FROM entities`))[0].type).toBe(
      "content-pipeline"
    );
  });

  it("renames the pod-only CRM `pipeline` kind to sales-motion", async () => {
    const id = await profile("pipeline", "kind", "workspace");
    const s = await run(["w12.crm.pipeline-kind-to-sales-motion"]);
    expect(errorsOf(s)).toEqual([]);
    const [p] = await q(
      `SELECT slug, display_name FROM profiles WHERE id = $1`,
      [id]
    );
    expect(p).toEqual({ slug: "sales-motion", display_name: "Sales motion" });
  });
});
