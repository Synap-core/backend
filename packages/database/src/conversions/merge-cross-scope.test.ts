/**
 * REAL-POSTGRES (PGlite) behaviour test for CROSS-SCOPE mergeInto
 * (`MergeIntoOp.intoScope: "shared"`).
 *
 * WHY A REAL PLANNER: engine.test.ts / defer.test.ts drive the engine with a
 * FAKE tagged-template `sql` keyed on query substrings — that proves JS
 * orchestration but never sends a byte to a planner, and it cannot prove the
 * thing that matters here: which ROWS the UPDATEs actually match and which
 * COLUMNS they leave alone. PGlite is real Postgres compiled to WASM, so the
 * assertions below are about real row state (see engine.integration.test.ts for
 * the fuller rationale on why NOT pg-mem).
 *
 * WHAT IT PROVES:
 *   (a) with `intoScope:"shared"` a WORKSPACE-scoped source resolves the POD-WIDE
 *       `scope='shared'` canonical and repoints its entity_facets onto it;
 *   (b) each facet keeps its OWN workspace_id lens and its per-instance
 *       properties/status/context — only `profile_id` moves;
 *   (c) WITHOUT the option, same-scope mergeInto behaves exactly as before —
 *       and in particular still CANNOT reach a shared target from a
 *       workspace-scoped source (the gap the option exists to close).
 *
 * MUTATION-TESTED: deleting the `intoScope === "shared"` dispatch in
 * applyMergeInto turns (a) and (b) red (0 facets repointed, still on the old
 * profile) while (c) stays green.
 */

import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { runConversions, computeCounts } from "./engine.js";
import type { ConversionManifest } from "./manifest.js";

// ─── postgres.js-shaped `Sql` shim over PGlite ───────────────────────────────
// Same shim contract as engine.integration.test.ts: tagged templates become $N
// binds, nested fragments splice as SQL, `.begin` is a real BEGIN/COMMIT, and
// write results expose `.count`.
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
  applicable_kinds text[],
  ui_hints jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid,
  user_id uuid,
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
  user_id uuid,
  workspace_id uuid,
  status text,
  context_entity_id uuid,
  properties jsonb DEFAULT '{}',
  metadata jsonb DEFAULT '{}',
  created_by_kind text,
  deleted_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE property_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid,
  slug text,
  workspace_id uuid
);
CREATE TABLE profile_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid,
  property_def_id uuid
);
CREATE TABLE views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_profile_ids uuid[] DEFAULT '{}'
);
`;

const WS_CRM = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

/**
 * The live shape this conversion exists for: foundation's POD-WIDE
 * `client` shared role, the legacy WORKSPACE-scoped `crm-client` role row, one
 * `company` entity, and a live facet instance on the legacy row carrying the
 * handoff state a party's detail page renders.
 */
async function setupPod() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  const q = async (text: string, params: unknown[] = []) =>
    (await db.query(text, params)).rows as any[];

  const [sharedClient] = await q(
    `INSERT INTO profiles (slug, display_name, profile_kind, scope, entity_scope, workspace_id, applicable_kinds)
     VALUES ('client','Client','role','shared','workspace',NULL,ARRAY['company','person'])
     RETURNING id`
  );
  const [crmClient] = await q(
    `INSERT INTO profiles (slug, display_name, profile_kind, scope, entity_scope, workspace_id, applicable_kinds)
     VALUES ('crm-client','Client (CRM)','role','workspace','workspace',$1,ARRAY['company','person'])
     RETURNING id`,
    [WS_CRM]
  );
  const [company] = await q(
    `INSERT INTO profiles (slug, display_name, profile_kind, scope) VALUES ('company','Company','kind','system') RETURNING id`
  );
  const [acme] = await q(
    `INSERT INTO entities (profile_id, user_id, workspace_id, type, properties)
     VALUES ($1,$2,$3,'company','{"name":"Acme"}') RETURNING id`,
    [company.id, USER, WS_CRM]
  );
  // The payload: per-instance role state + a workspace lens, both of which must
  // survive the repoint byte-for-byte.
  const [facet] = await q(
    `INSERT INTO entity_facets (entity_id, profile_id, user_id, workspace_id, status, properties, created_by_kind)
     VALUES ($1,$2,$3,$4,'active','{"handoffStatus":"handed_off","becameClientAt":"2026-03-01"}','user')
     RETURNING id`,
    [acme.id, crmClient.id, USER, WS_CRM]
  );
  // A BASE property_def on the workspace-only legacy row — must NOT become a
  // pod-wide base def on the shared row.
  await q(
    `INSERT INTO property_defs (profile_id, slug, workspace_id) VALUES ($1,'handoffStatus',NULL)`,
    [crmClient.id]
  );

  return {
    db,
    sql: makePgliteSql(db),
    q,
    ids: {
      sharedClient: sharedClient.id as string,
      crmClient: crmClient.id as string,
      acme: acme.id as string,
      facet: facet.id as string,
    },
  };
}

function manifestOf(op: ConversionManifest["ops"][number]): ConversionManifest {
  return { version: 1, ops: [op] };
}

const CROSS_SCOPE_OP = {
  op: "mergeInto",
  opKey: "test.merge.crm-client-cross-scope",
  fromSlugs: ["crm-client"],
  intoSlug: "client",
  intoScope: "shared",
} as const;

const SAME_SCOPE_OP = {
  op: "mergeInto",
  opKey: "test.merge.crm-client-same-scope",
  fromSlugs: ["crm-client"],
  intoSlug: "client",
} as const;

describe("cross-scope mergeInto (intoScope:'shared')", () => {
  it("(a) resolves the POD-WIDE shared canonical and repoints entity_facets onto it", async () => {
    const { sql, q, ids } = await setupPod();

    const summary = await runConversions(sql, manifestOf(CROSS_SCOPE_OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(
      summary.results[0].error ?? null,
      summary.results[0].error ?? ""
    ).toBeNull();
    expect(summary.results[0].status).toBe("applied");
    expect(summary.results[0].counts.facetsRepointed).toBe(1);

    const [row] = await q(
      `SELECT profile_id FROM entity_facets WHERE id = $1`,
      [ids.facet]
    );
    expect(row.profile_id).toBe(ids.sharedClient);
    expect(row.profile_id).not.toBe(ids.crmClient);
  });

  it("(b) preserves the facet's OWN workspace_id lens, properties and status", async () => {
    const { sql, q, ids } = await setupPod();
    await runConversions(sql, manifestOf(CROSS_SCOPE_OP), {
      dryRun: false,
      destructiveTail: true,
    });

    const [row] = await q(
      `SELECT workspace_id, status, properties, context_entity_id, deleted_at
         FROM entity_facets WHERE id = $1`,
      [ids.facet]
    );
    // The lens is NOT collapsed to the shared row's NULL workspace.
    expect(row.workspace_id).toBe(WS_CRM);
    expect(row.status).toBe("active");
    expect(row.properties).toEqual({
      handoffStatus: "handed_off",
      becameClientAt: "2026-03-01",
    });
    expect(row.context_entity_id).toBeNull();
    expect(row.deleted_at).toBeNull();

    // A BASE def on the workspace-only source lands as THAT workspace's
    // OVERLAY on the pod-wide row — never as a pod-wide base def.
    const [pd] = await q(
      `SELECT profile_id, workspace_id FROM property_defs WHERE slug = 'handoffStatus'`
    );
    expect(pd.profile_id).toBe(ids.sharedClient);
    expect(pd.workspace_id).toBe(WS_CRM);
  });

  it("REFUSES without --destructive-tail (no repoint, no ledger), deactivates with", async () => {
    // Repoint + retire are atomic: applying only the repoint would ledger the
    // opKey and orphan the deactivation forever (the ledger trap).
    const noTail = await setupPod();
    const refused = await runConversions(
      noTail.sql,
      manifestOf(CROSS_SCOPE_OP),
      {
        dryRun: false,
        destructiveTail: false,
      }
    );
    expect(refused.hadError).toBe(true);
    expect(refused.results[0].error).toMatch(/--destructive-tail/);
    const [still] = await noTail.q(
      `SELECT is_active FROM profiles WHERE id = $1`,
      [noTail.ids.crmClient]
    );
    expect(still.is_active).toBe(true);
    const [facetRow] = await noTail.q(
      `SELECT profile_id FROM entity_facets WHERE id = $1`,
      [noTail.ids.facet]
    );
    expect(facetRow.profile_id).toBe(noTail.ids.crmClient); // not repointed
    expect(await noTail.q(`SELECT op_key FROM "_conversions"`)).toEqual([]);

    const tail = await setupPod();
    const summary = await runConversions(tail.sql, manifestOf(CROSS_SCOPE_OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(summary.results[0].counts.profilesDeactivated).toBe(1);
    const [retired] = await tail.q(
      `SELECT is_active FROM profiles WHERE id = $1`,
      [tail.ids.crmClient]
    );
    expect(retired.is_active).toBe(false);
  });

  it("is idempotent — a second real run repoints nothing", async () => {
    const { sql, q, ids } = await setupPod();
    await runConversions(sql, manifestOf(CROSS_SCOPE_OP), {
      dryRun: false,
      destructiveTail: true,
    });
    // Fresh manifest object, same opKey → the ledger short-circuits it; drop the
    // ledger row to prove the SQL ITSELF is a no-op the second time.
    await q(`DELETE FROM "_conversions"`);
    const again = await runConversions(sql, manifestOf(CROSS_SCOPE_OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(again.results[0].status).toBe("noop");
    const [row] = await q(
      `SELECT profile_id FROM entity_facets WHERE id = $1`,
      [ids.facet]
    );
    expect(row.profile_id).toBe(ids.sharedClient);
  });

  it("dry-run counts the repoint and writes nothing", async () => {
    const { sql, q, ids } = await setupPod();
    const counts = await computeCounts(sql, CROSS_SCOPE_OP as any, {
      dryRun: true,
      destructiveTail: false,
    });
    expect(counts.facetsRepointed).toBe(1);
    const [row] = await q(
      `SELECT profile_id FROM entity_facets WHERE id = $1`,
      [ids.facet]
    );
    expect(row.profile_id).toBe(ids.crmClient); // untouched
  });

  it("THROWS rather than ledgering a no-op when the shared canonical is missing but data sits on the source", async () => {
    const { sql, q, ids } = await setupPod();
    await q(`DELETE FROM profiles WHERE id = $1`, [ids.sharedClient]);

    const summary = await runConversions(sql, manifestOf(CROSS_SCOPE_OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(summary.hadError).toBe(true);
    expect(summary.results[0].error).toMatch(/refusing to record a no-op/);
    // Nothing ledgered as successful → a later run retries the op.
    const ledger = await q(
      `SELECT op_key, error FROM "_conversions" WHERE error IS NULL`
    );
    expect(ledger).toEqual([]);
  });

  it("stays a clean no-op on a pod that carries neither the legacy nor the shared row", async () => {
    const { sql, q, ids } = await setupPod();
    await q(`DELETE FROM entity_facets`);
    await q(`DELETE FROM profiles WHERE id IN ($1,$2)`, [
      ids.sharedClient,
      ids.crmClient,
    ]);
    const summary = await runConversions(sql, manifestOf(CROSS_SCOPE_OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(summary.hadError).toBe(false);
    expect(summary.results[0].status).toBe("noop");
  });
});

describe("same-scope mergeInto is unchanged when intoScope is absent", () => {
  it("(c) does NOT reach the shared target from a workspace-scoped source", async () => {
    // The REGRESSION anchor: this is the pre-existing behaviour (canonical
    // matched at `k.scope = src.scope AND k.workspace_id IS NOT DISTINCT FROM
    // src.workspace_id`), and it is exactly the gap `intoScope` closes. If this
    // ever starts repointing, the default path silently changed.
    //
    // It used to ALSO pin `hadError:false` — i.e. a zero-count "applied" ledger
    // row with a live facet left on a source that has no same-scope canonical:
    // the silent strand. That is now REFUSED (L3), so this asserts the refusal.
    const { sql, q, ids } = await setupPod();
    const summary = await runConversions(sql, manifestOf(SAME_SCOPE_OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(summary.hadError).toBe(true);
    expect(summary.results[0].error).toMatch(/refusing to record a no-op/);
    expect(
      await q(`SELECT op_key FROM "_conversions" WHERE error IS NULL`)
    ).toEqual([]);

    const [row] = await q(
      `SELECT profile_id FROM entity_facets WHERE id = $1`,
      [ids.facet]
    );
    expect(row.profile_id).toBe(ids.crmClient); // still on the legacy row
    const [legacy] = await q(`SELECT is_active FROM profiles WHERE id = $1`, [
      ids.crmClient,
    ]);
    expect(legacy.is_active).toBe(true);
  });

  it("still merges within the SAME scope + workspace (entities + type + tail)", async () => {
    const { sql, q } = await setupPod();
    // A workspace-scoped `crm-client` AND a workspace-scoped `client` in the
    // SAME workspace — the shape the default path is built for.
    const [wsClient] = await q(
      `INSERT INTO profiles (slug, display_name, profile_kind, scope, workspace_id)
       VALUES ('client','Client (ws)','role','workspace',$1) RETURNING id`,
      [WS_CRM]
    );
    const [crmClient] = await q(
      `SELECT id FROM profiles WHERE slug = 'crm-client'`
    );
    const [ent] = await q(
      `INSERT INTO entities (profile_id, user_id, workspace_id, type)
       VALUES ($1,$2,$3,'crm-client') RETURNING id`,
      [crmClient.id, USER, WS_CRM]
    );

    const summary = await runConversions(sql, manifestOf(SAME_SCOPE_OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(summary.hadError).toBe(false);
    expect(summary.results[0].counts.entitiesRepointed).toBe(1);

    const [moved] = await q(
      `SELECT profile_id, type FROM entities WHERE id = $1`,
      [ent.id]
    );
    expect(moved.profile_id).toBe(wsClient.id);
    expect(moved.type).toBe("client");
    // Facets are NOT part of the same-scope path (unchanged, pre-existing).
    const [facet] = await q(`SELECT profile_id FROM entity_facets LIMIT 1`);
    expect(facet.profile_id).toBe(crmClient.id);
  });
});

// ─── L3: same-scope mergeInto refuses to strand live data ───────────────────
// The discriminating inputs (each rules OUT a wrong rule):
//   - live entity, no canonical         → refuse   (rules out: today's silent noop)
//   - only a SOFT-DELETED entity        → noop     (rules out: "any entity row" counts)
//   - one source paired + one unpaired  → refuse whole op, paired NOT moved
//                                                  (rules out: "some canonical exists")
//   - canonical present                 → merges   (regression)
describe("same-scope mergeInto — stranding refusal (L3)", () => {
  const WS = "33333333-3333-3333-3333-333333333333";
  const OP = {
    op: "mergeInto",
    opKey: "test.merge.note-into-item",
    fromSlugs: ["note"],
    intoSlug: "item",
  } as const;

  async function pod() {
    const db = new PGlite();
    await db.exec(SCHEMA);
    const q = async (text: string, params: unknown[] = []) =>
      (await db.query(text, params)).rows as any[];
    const [wsNote] = await q(
      `INSERT INTO profiles (slug, scope, workspace_id) VALUES ('note','workspace',$1) RETURNING id`,
      [WS]
    );
    return { sql: makePgliteSql(db), q, wsNote: wsNote.id as string };
  }

  it("REFUSES (not ledgered as applied) when a source holds a live entity and has no canonical", async () => {
    const { sql, q, wsNote } = await pod();
    const [ent] = await q(
      `INSERT INTO entities (profile_id, user_id, workspace_id, type) VALUES ($1,$2,$3,'note') RETURNING id`,
      [wsNote, USER, WS]
    );

    const summary = await runConversions(sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(summary.hadError).toBe(true);
    expect(summary.results[0].status).toBe("error");
    const msg = summary.results[0].error ?? "";
    expect(msg).toMatch(/refusing to record a no-op/);
    expect(msg).toContain("test.merge.note-into-item");
    expect(msg).toContain("note (scope=workspace");
    expect(msg).toContain("1 live entity row(s) and 0 live facet row(s)");
    expect(msg).toMatch(/create the 'item' canonical first/);
    // The op is NOT in the applied set → a later run retries it.
    expect(
      await q(`SELECT op_key FROM "_conversions" WHERE error IS NULL`)
    ).toEqual([]);
    const [row] = await q(`SELECT profile_id FROM entities WHERE id = $1`, [
      ent.id,
    ]);
    expect(row.profile_id).toBe(wsNote);

    // The dry run surfaces the same refusal before --apply.
    const dry = await runConversions(sql, manifestOf(OP), {
      dryRun: true,
      destructiveTail: false,
    });
    expect(dry.results[0].status).toBe("error");
    expect(dry.results[0].error).toMatch(/refusing to record a no-op/);
  });

  it("stays a clean ledgered noop when the source has NO live data (soft-deleted only)", async () => {
    const { sql, q, wsNote } = await pod();
    await q(
      `INSERT INTO entities (profile_id, user_id, workspace_id, type, deleted_at) VALUES ($1,$2,$3,'note', now())`,
      [wsNote, USER, WS]
    );
    const summary = await runConversions(sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(summary.hadError).toBe(false);
    expect(summary.results[0].status).toBe("noop");
    expect(
      (await q(`SELECT op_key FROM "_conversions" WHERE error IS NULL`)).map(
        (r) => r.op_key
      )
    ).toEqual(["test.merge.note-into-item"]);
  });

  it("refuses the WHOLE op when one source is paired and another is stranded — nothing moves", async () => {
    const { sql, q, wsNote } = await pod();
    await q(
      `INSERT INTO entities (profile_id, user_id, workspace_id, type) VALUES ($1,$2,$3,'note')`,
      [wsNote, USER, WS]
    );
    const [sysNote] = await q(
      `INSERT INTO profiles (slug, scope) VALUES ('note','system') RETURNING id`
    );
    await q(`INSERT INTO profiles (slug, scope) VALUES ('item','system')`);
    const [paired] = await q(
      `INSERT INTO entities (profile_id, user_id, type) VALUES ($1,$2,'note') RETURNING id`,
      [sysNote.id, USER]
    );

    const summary = await runConversions(sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(summary.hadError).toBe(true);
    expect(summary.results[0].error).toMatch(/refusing to record a no-op/);
    const [row] = await q(`SELECT profile_id FROM entities WHERE id = $1`, [
      paired.id,
    ]);
    expect(row.profile_id).toBe(sysNote.id); // rolled back, not half-applied
    expect(
      await q(`SELECT op_key FROM "_conversions" WHERE error IS NULL`)
    ).toEqual([]);
  });

  it("still merges when the same-scope canonical exists (regression)", async () => {
    const { sql, q, wsNote } = await pod();
    const [ent] = await q(
      `INSERT INTO entities (profile_id, user_id, workspace_id, type) VALUES ($1,$2,$3,'note') RETURNING id`,
      [wsNote, USER, WS]
    );
    const [wsItem] = await q(
      `INSERT INTO profiles (slug, scope, workspace_id) VALUES ('item','workspace',$1) RETURNING id`,
      [WS]
    );
    const summary = await runConversions(sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(summary.hadError).toBe(false);
    expect(summary.results[0].status).toBe("applied");
    expect(summary.results[0].counts.entitiesRepointed).toBe(1);
    const [row] = await q(
      `SELECT profile_id, type FROM entities WHERE id = $1`,
      [ent.id]
    );
    expect(row.profile_id).toBe(wsItem.id);
    expect(row.type).toBe("item");
  });
});

// ─── B0: cross-scope mergeInto into a SYSTEM canonical (intoScope:'system') ──
// The approved fold: workspace-scoped `devplane_decision_record` (Builder) →
// the system `decision` kind. Discriminating inputs:
//   - an EARLIER-created `scope='shared'` decision row → rules out a resolver
//     that ignores the requested scope (it would pick the shared row);
//   - a BASE def (workspace_id NULL) on the workspace source → rules out a
//     restamp that lands it pod-wide on the system row;
//   - canonical missing + live data → rules out ledgering a stranding no-op.
describe("cross-scope mergeInto into a SYSTEM canonical (intoScope:'system')", () => {
  const WS_BUILDER = "44444444-4444-4444-4444-444444444444";
  const OP = {
    op: "mergeInto",
    opKey: "test.merge.devplane-decision-record-into-system-decision",
    fromSlugs: ["devplane_decision_record"],
    intoSlug: "decision",
    intoScope: "system",
  } as const;

  async function pod() {
    const db = new PGlite();
    await db.exec(SCHEMA);
    const q = async (text: string, params: unknown[] = []) =>
      (await db.query(text, params)).rows as any[];
    // Decoy: a shared `decision` row created FIRST (earliest created_at).
    const [sharedDecision] = await q(
      `INSERT INTO profiles (slug, scope, entity_scope, created_at)
       VALUES ('decision','shared','pod', now() - interval '2 days') RETURNING id`
    );
    const [sysDecision] = await q(
      `INSERT INTO profiles (slug, scope, entity_scope, created_at)
       VALUES ('decision','system','pod', now() - interval '1 day') RETURNING id`
    );
    const [src] = await q(
      `INSERT INTO profiles (slug, scope, entity_scope, workspace_id)
       VALUES ('devplane_decision_record','workspace','workspace',$1) RETURNING id`,
      [WS_BUILDER]
    );
    const ents = await q(
      `INSERT INTO entities (profile_id, user_id, workspace_id, type, properties)
       VALUES ($1,$2,$3,'devplane_decision_record','{"title":"one"}'),
              ($1,$2,$3,'devplane_decision_record','{"title":"two"}')
       RETURNING id`,
      [src.id, USER, WS_BUILDER]
    );
    const [facet] = await q(
      `INSERT INTO entity_facets (entity_id, profile_id, user_id, workspace_id, status, properties)
       VALUES ($1,$2,$3,$4,'open','{"k":"v"}') RETURNING id`,
      [ents[0].id, src.id, USER, WS_BUILDER]
    );
    const [def] = await q(
      `INSERT INTO property_defs (profile_id, slug, workspace_id) VALUES ($1,'rationale',NULL) RETURNING id`,
      [src.id]
    );
    const [view] = await q(
      `INSERT INTO views (scope_profile_ids) VALUES (ARRAY[$1::uuid]) RETURNING id`,
      [src.id]
    );
    return {
      sql: makePgliteSql(db),
      q,
      ids: {
        sharedDecision: sharedDecision.id as string,
        sysDecision: sysDecision.id as string,
        src: src.id as string,
        entities: ents.map((e) => e.id as string),
        facet: facet.id as string,
        def: def.id as string,
        view: view.id as string,
      },
    };
  }

  it("repoints entities (+type), facet, def (as the source workspace's OVERLAY) and views onto the SYSTEM row, and ledgers", async () => {
    const { sql, q, ids } = await pod();
    const summary = await runConversions(sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(
      summary.results[0].error ?? null,
      summary.results[0].error ?? ""
    ).toBeNull();
    expect(summary.results[0].status).toBe("applied");
    expect(summary.results[0].counts).toMatchObject({
      entitiesRepointed: 2,
      facetsRepointed: 1,
      propertyDefsRepointed: 1,
      viewsRewritten: 1,
      profilesDeactivated: 1,
    });

    const ents = await q(
      `SELECT profile_id, type, workspace_id FROM entities WHERE id = ANY($1::uuid[])`,
      [ids.entities]
    );
    expect(ents).toHaveLength(2);
    for (const e of ents) {
      expect(e.profile_id).toBe(ids.sysDecision); // NOT the earlier shared decoy
      expect(e.type).toBe("decision");
      // The merge never touches entities.workspace_id (visibility unchanged
      // until a deliberate reconcileEntityScope).
      expect(e.workspace_id).toBe(WS_BUILDER);
    }

    const [f] = await q(
      `SELECT profile_id, workspace_id, status, properties FROM entity_facets WHERE id = $1`,
      [ids.facet]
    );
    expect(f.profile_id).toBe(ids.sysDecision);
    expect(f.workspace_id).toBe(WS_BUILDER);
    expect(f.status).toBe("open");
    expect(f.properties).toEqual({ k: "v" });

    const [d] = await q(
      `SELECT profile_id, workspace_id FROM property_defs WHERE id = $1`,
      [ids.def]
    );
    expect(d.profile_id).toBe(ids.sysDecision);
    expect(d.workspace_id).toBe(WS_BUILDER); // overlay, never pod-wide base
    expect(summary.results[0].planDetail).toEqual([
      expect.objectContaining({
        table: "property_defs",
        slug: "rationale",
        action: "restamped",
        fromWorkspaceId: null,
        toWorkspaceId: WS_BUILDER,
      }),
    ]);

    const [v] = await q(`SELECT scope_profile_ids FROM views WHERE id = $1`, [
      ids.view,
    ]);
    expect(v.scope_profile_ids).toEqual([ids.sysDecision]);

    const [src] = await q(`SELECT is_active FROM profiles WHERE id = $1`, [
      ids.src,
    ]);
    expect(src.is_active).toBe(false);
    const [shared] = await q(`SELECT is_active FROM profiles WHERE id = $1`, [
      ids.sharedDecision,
    ]);
    expect(shared.is_active).toBe(true); // decoy untouched

    expect(await q(`SELECT op_key, error FROM "_conversions"`)).toEqual([
      { op_key: OP.opKey, error: null },
    ]);
  });

  it("dry-run counts equal the apply counts, and the dry run writes nothing", async () => {
    const dryPod = await pod();
    const dry = await runConversions(dryPod.sql, manifestOf(OP), {
      dryRun: true,
      destructiveTail: false,
    });
    expect(dry.results[0].status).toBe("dry-run");
    const [still] = await dryPod.q(
      `SELECT COUNT(*)::int AS n FROM entities WHERE profile_id = $1`,
      [dryPod.ids.src]
    );
    expect(still.n).toBe(2);
    expect(await dryPod.q(`SELECT op_key FROM "_conversions"`)).toEqual([]);

    const applyPod = await pod();
    const applied = await runConversions(applyPod.sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: true,
    });
    // The dry run is not given destructiveTail, so compare everything but the tail.
    const { profilesDeactivated: _tail, ...appliedCounts } =
      applied.results[0].counts;
    const { profilesDeactivated: _dryTail, ...dryCounts } =
      dry.results[0].counts;
    expect(appliedCounts.entitiesRepointed).toBe(2);
    expect(dryCounts).toEqual(appliedCounts);
  });

  it("REFUSES (not ledgered as applied) when the system canonical is missing but live data sits on the source", async () => {
    const { sql, q, ids } = await pod();
    await q(`DELETE FROM profiles WHERE id = $1`, [ids.sysDecision]);

    const summary = await runConversions(sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(summary.hadError).toBe(true);
    expect(summary.results[0].status).toBe("error");
    expect(summary.results[0].error).toMatch(/refusing to record a no-op/);
    expect(summary.results[0].error).toContain("(scope='system') not found");
    expect(
      await q(`SELECT op_key FROM "_conversions" WHERE error IS NULL`)
    ).toEqual([]);
    const [e] = await q(`SELECT profile_id FROM entities WHERE id = $1`, [
      ids.entities[0],
    ]);
    expect(e.profile_id).toBe(ids.src); // not moved onto the shared decoy either
  });
});

/**
 * W2b — the ROLE TWIN collapse: a workspace-scoped `partner` row (CRM) beside
 * the ONE pod-wide shared `partner`. The same slug on both sides is legal for a
 * cross-scope merge (the canonical is resolved by SCOPE and excluded from the
 * moved set), and it is driven by the REAL manifest entry.
 */
describe("cross-scope mergeInto — same-slug role twin (w2b.merge.partner-twin-into-shared)", () => {
  it("repoints the twin's facets onto the shared row, re-stamps its base defs as CRM overlays, retires the twin", async () => {
    const { CONVERSION_MANIFEST } = await import("./manifest.js");
    const { selectManifestOps } = await import("./select.js");
    const db = new PGlite();
    await db.exec(SCHEMA);
    const q = async (text: string, params: unknown[] = []) =>
      (await db.query(text, params)).rows as any[];
    const [shared] = await q(
      `INSERT INTO profiles (slug, display_name, profile_kind, scope, workspace_id, applicable_kinds)
       VALUES ('partner','Partner','role','shared',NULL,ARRAY['company','person']) RETURNING id`
    );
    const [twin] = await q(
      `INSERT INTO profiles (slug, display_name, profile_kind, scope, workspace_id, applicable_kinds)
       VALUES ('partner','Partner (CRM)','role','workspace',$1,ARRAY['company','person']) RETURNING id`,
      [WS_CRM]
    );
    const [facet] = await q(
      `INSERT INTO entity_facets (entity_id, profile_id, user_id, workspace_id, properties)
       VALUES (gen_random_uuid(), $1, $2, $3, '{"tier":"gold"}') RETURNING id`,
      [twin.id, USER, WS_CRM]
    );
    await q(
      `INSERT INTO property_defs (profile_id, slug, workspace_id) VALUES ($1,'tier',NULL)`,
      [twin.id]
    );

    const summary = await runConversions(
      makePgliteSql(db),
      selectManifestOps(CONVERSION_MANIFEST, [
        "w2b.merge.partner-twin-into-shared",
      ]),
      { dryRun: false, destructiveTail: true }
    );
    expect(
      summary.results[0].error ?? null,
      summary.results[0].error ?? ""
    ).toBeNull();
    expect(summary.results[0].counts).toMatchObject({
      facetsRepointed: 1,
      profilesDeactivated: 1,
    });
    const [f] = await q(
      `SELECT profile_id, properties FROM entity_facets WHERE id = $1`,
      [facet.id]
    );
    expect(f.profile_id).toBe(shared.id);
    expect(f.properties).toEqual({ tier: "gold" });
    const [pd] = await q(
      `SELECT profile_id, workspace_id FROM property_defs WHERE slug = 'tier'`
    );
    expect(pd).toEqual({ profile_id: shared.id, workspace_id: WS_CRM });
    const rows = await q(
      `SELECT id, is_active FROM profiles WHERE slug = 'partner' ORDER BY is_active DESC`
    );
    expect(rows).toEqual([
      { id: shared.id, is_active: true },
      { id: twin.id, is_active: false },
    ]);
    await db.close();
  });
});
