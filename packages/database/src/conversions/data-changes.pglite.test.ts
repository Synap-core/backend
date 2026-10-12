/**
 * REAL-POSTGRES (PGlite) test for the template data-change door
 * (data-changes.ts, TEMPLATE-LIFECYCLE Contract C), driven by the REAL
 * `CONVERSION_MANIFEST` and the REAL engine dry run, never hand-built counts.
 *
 * The pod is modelled as BOOTED: every manifest op is ledgered except the
 * deferred ones under test, which is exactly the state a live pod is in.
 * Fixture rows are chosen to rule wrong rules out:
 *   - deals with a mapped AND an unmapped `dealStage`: `affected` counts only
 *     what the engine would really touch (rules out "every deal");
 *   - a `content-studio`-only template: rules out "every pending op is every
 *     template's business" (no crm op may show up);
 *   - a ledgered op: rules out reading pending-ness from the manifest alone;
 *   - a failing dry run: rules out folding "unmeasured" into 0.
 * DDL: hand-written, only the columns engine.ts touches (sibling convention).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { LIFECYCLE_PROJECTION_TEST_SCHEMA } from "./lifecycle-projection-test-schema.js";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { CONVERSION_MANIFEST } from "./manifest.js";
import {
  pendingTemplateDataChanges,
  dataChangeConsent,
  runConsentedDataChanges,
  holdsTemplateStamp,
} from "./data-changes.js";

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
/** The crm template's declared profile slugs (synap-app crm.yaml). */
const CRM = ["person", "company", "deal", "client", "partner", "lead"];
const DEAL = "crm.deal-stage.commercial-fold";
const CHURNED = "w12.role.churned-into-status";
const LEAD_FOLD = "w12.lead.lifecycle-stage-fold";
const LEAD_LEGACY = "w12.lead.legacy-stage-values";
const UNDER_TEST = [DEAL, CHURNED, LEAD_FOLD, LEAD_LEGACY];

let db: PGlite;
let sql: Sql;
const q = async (text: string, params: unknown[] = []) =>
  (await db.query(text, params)).rows as any[];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA + LIFECYCLE_PROJECTION_TEST_SCHEMA);
  sql = makePgliteSql(db);
}, 120_000);

/** A booted pod: every op ledgered except the ones under test. */
async function bootedLedger(): Promise<void> {
  await db.exec(`
    CREATE TABLE "_conversions" (
      "id" serial PRIMARY KEY,
      "op_key" text NOT NULL UNIQUE,
      "applied_at" timestamptz NOT NULL DEFAULT now(),
      "dry_run" boolean NOT NULL DEFAULT false,
      "counts" jsonb NOT NULL DEFAULT '{}',
      "error" text
    )`);
  for (const op of CONVERSION_MANIFEST.ops) {
    if (UNDER_TEST.includes(op.opKey)) continue;
    await q(`INSERT INTO "_conversions" (op_key) VALUES ($1)`, [op.opKey]);
  }
}

beforeEach(async () => {
  await db.exec(
    `DROP TABLE IF EXISTS "_conversions"; TRUNCATE profiles, entities, entity_facets;`
  );
  await bootedLedger();
});

afterAll(async () => {
  await db?.close();
});

async function profile(slug: string, kind: "kind" | "role"): Promise<string> {
  const [row] = await q(
    `INSERT INTO profiles (slug, display_name, profile_kind, scope) VALUES ($1, $1, $2, 'shared') RETURNING id`,
    [slug, kind]
  );
  return row.id;
}
async function entity(profileId: string, type: string, props = {}) {
  const [row] = await q(
    `INSERT INTO entities (profile_id, type, properties) VALUES ($1, $2, $3) RETURNING id`,
    [profileId, type, JSON.stringify(props)]
  );
  return row.id as string;
}
async function facet(entityId: string, profileId: string, props = {}) {
  await q(
    `INSERT INTO entity_facets (entity_id, profile_id, user_id, workspace_id, properties)
     VALUES ($1, $2, $3, $4, $5)`,
    [entityId, profileId, USER, WS, JSON.stringify(props)]
  );
}

/** Three mapped deals, one unmapped; two churned facets; one lead overlay. */
async function seedCrm(): Promise<void> {
  const deal = await profile("deal", "kind");
  const company = await profile("company", "kind");
  const churned = await profile("churned", "role");
  await profile("client", "role");
  const lead = await profile("lead", "role");
  await entity(deal, "deal", { dealStage: "lead" });
  await entity(deal, "deal", { dealStage: "won" });
  await entity(deal, "deal", { dealStage: "proposal" });
  await entity(deal, "deal", { dealStage: "made-up" }); // unmapped: untouched
  const c1 = await entity(company, "company");
  const c2 = await entity(company, "company");
  await facet(c1, churned, { churnReason: "price" });
  await facet(c2, churned, {});
  await facet(c1, lead, { lifecycleStage: "engaged" });
}

describe("pendingTemplateDataChanges — what a crm update is waiting on", () => {
  it("lists each pending op that touches the template, counted by the engine's dry run", async () => {
    await seedCrm();
    const pending = await pendingTemplateDataChanges(sql, CRM);
    const byKey = Object.fromEntries(pending.map((c) => [c.opKey, c]));

    expect(Object.keys(byKey).sort()).toEqual(
      [CHURNED, DEAL, LEAD_FOLD].sort()
    );
    expect(byKey[DEAL]).toMatchObject({
      affected: 3, // the unmapped `made-up` deal is not touched
      destructive: false,
      counts: { entitiesRemapped: 3 },
    });
    expect(byKey[DEAL].description).toContain("dealStage");
    expect(byKey[LEAD_FOLD]).toMatchObject({ affected: 1, destructive: false });
    // foldRoleIntoStatus has a destructive tail: an operator step, never run here.
    expect(byKey[CHURNED]).toMatchObject({ affected: 2, destructive: true });
    expect(byKey[CHURNED].operatorCommand).toContain(`--only ${CHURNED}`);
    // LEAD_LEGACY touches `lead` but no facet holds a legacy value: nothing to agree to.
    expect(byKey[LEAD_LEGACY]).toBeUndefined();
  });

  it("is nothing for a template none of the pending ops touch", async () => {
    await seedCrm();
    expect(
      await pendingTemplateDataChanges(sql, ["post", "production-recipe"])
    ).toEqual([]);
  });

  it("drops an op once the engine has ledgered it", async () => {
    await seedCrm();
    const ran = await runConsentedDataChanges(sql, [DEAL]);
    expect(ran.hadError).toBe(false);
    expect(ran.results[0]).toMatchObject({ opKey: DEAL, status: "applied" });
    const deals = await q(
      `SELECT properties FROM entities WHERE type = 'deal' ORDER BY properties->>'commercialStage'`
    );
    expect(deals.map((d) => d.properties.commercialStage ?? null)).toEqual([
      "draft",
      "proposed",
      "won",
      null,
    ]);
    const pending = await pendingTemplateDataChanges(sql, CRM);
    expect(pending.map((c) => c.opKey)).not.toContain(DEAL);
  });

  it("keeps an op whose dry run FAILED, unmeasured — never folded into 0", async () => {
    // `relation_defs` does not exist in this schema, so the engine's dry run
    // of a dedupeRelationDefs op throws.
    const broken = {
      version: 1,
      ops: [{ op: "dedupeRelationDefs" as const, opKey: "test.broken" }],
    };
    const pending = await pendingTemplateDataChanges(sql, CRM, broken);
    expect(pending).toHaveLength(1);
    expect(pending[0].affected).toBeNull();
    expect(pending[0].error).toBeTruthy();
  });
});

describe("dataChangeConsent — the person agrees to each consentable change", () => {
  it("needs every non-destructive change accepted; destructive ones are operator steps", async () => {
    await seedCrm();
    const pending = await pendingTemplateDataChanges(sql, CRM);
    expect(holdsTemplateStamp(pending)).toBe(true);

    const none = dataChangeConsent(pending, undefined);
    expect(none.ok).toBe(false);
    expect(none.missing.map((c) => c.opKey).sort()).toEqual(
      [DEAL, LEAD_FOLD].sort()
    );
    expect(none.operatorSteps.map((c) => c.opKey)).toEqual([CHURNED]);

    const partial = dataChangeConsent(pending, [DEAL]);
    expect(partial.ok).toBe(false);
    expect(partial.missing.map((c) => c.opKey)).toEqual([LEAD_FOLD]);

    const all = dataChangeConsent(pending, [DEAL, LEAD_FOLD]);
    expect(all.ok).toBe(true);
    expect(all.toRun.map((c) => c.opKey).sort()).toEqual(
      [DEAL, LEAD_FOLD].sort()
    );

    // A pending destructive change never blocks the update (lane-cli's
    // deadlock): the consentable ones alone make it ok.
    expect(all.operatorSteps.map((c) => c.opKey)).toEqual([CHURNED]);
    // Accepting a destructive change runs nothing and blocks nothing; it is
    // echoed back so the caller is told it stays an operator step.
    const destructive = dataChangeConsent(pending, [DEAL, LEAD_FOLD, CHURNED]);
    expect(destructive.ok).toBe(true);
    expect(destructive.toRun.map((c) => c.opKey)).not.toContain(CHURNED);
    expect(destructive.destructiveAccepted).toEqual([CHURNED]);
  });

  it("a destructive-only backlog holds nothing back", async () => {
    await seedCrm();
    await runConsentedDataChanges(sql, [DEAL, LEAD_FOLD]);
    const pending = await pendingTemplateDataChanges(sql, CRM);
    expect(pending.map((c) => c.opKey)).toEqual([CHURNED]);
    expect(holdsTemplateStamp(pending)).toBe(false);
  });
});
