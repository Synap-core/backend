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
      destructiveTail: false,
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
      destructiveTail: false,
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

  it("leaves the legacy profile ACTIVE without --destructive-tail, deactivates it with", async () => {
    const noTail = await setupPod();
    await runConversions(noTail.sql, manifestOf(CROSS_SCOPE_OP), {
      dryRun: false,
      destructiveTail: false,
    });
    const [still] = await noTail.q(
      `SELECT is_active FROM profiles WHERE id = $1`,
      [noTail.ids.crmClient]
    );
    expect(still.is_active).toBe(true);

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
      destructiveTail: false,
    });
    // Fresh manifest object, same opKey → the ledger short-circuits it; drop the
    // ledger row to prove the SQL ITSELF is a no-op the second time.
    await q(`DELETE FROM "_conversions"`);
    const again = await runConversions(sql, manifestOf(CROSS_SCOPE_OP), {
      dryRun: false,
      destructiveTail: false,
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
      destructiveTail: false,
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
      destructiveTail: false,
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
    const { sql, q, ids } = await setupPod();
    const summary = await runConversions(sql, manifestOf(SAME_SCOPE_OP), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(summary.hadError).toBe(false);
    expect(summary.results[0].counts.entitiesRepointed ?? 0).toBe(0);
    expect(summary.results[0].counts.profilesDeactivated ?? 0).toBe(0);

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
