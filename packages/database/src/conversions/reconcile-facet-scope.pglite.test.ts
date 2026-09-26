/**
 * REAL-POSTGRES (PGlite) test for the W2b ROLE-principle backfill
 * `w2b.reconcile-facet-scope.shared-roles` — driven through the REAL
 * `CONVERSION_MANIFEST` entry (selected by opKey) and `runConversions`.
 *
 * Pinned:
 *  - a lensed facet of a SHARED or SYSTEM role is re-nulled (pod-wide), so the
 *    hat worn in CRM is visible in every lens;
 *  - a WORKSPACE-private role's facet is never touched;
 *  - collision-safe under the live unique key (entity, profile, ctx,
 *    COALESCE(ws)): per group only the EARLIEST lensed row moves, and none
 *    moves when a pod-wide row already exists — the rest are PARKED + counted,
 *    never deleted;
 *  - boot never runs it (deferAtBoot); a dry run writes nothing.
 * The unique index is created exactly as migration 0174 declares it, so a
 * non-collision-safe UPDATE would raise 23505 here.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { runConversions } from "./engine.js";
import type { RunOptions } from "./engine.js";
import { CONVERSION_MANIFEST } from "./manifest.js";
import { selectManifestOps } from "./select.js";

// ─── postgres.js-shaped `Sql` shim over PGlite ───────────────────────────────
// Same contract as engine.integration.test.ts / dedupe-field-plan.pglite.test.ts.
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
  profile_kind text DEFAULT 'kind',
  scope text DEFAULT 'system',
  workspace_id uuid
);
CREATE TABLE entity_facets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid,
  profile_id uuid,
  workspace_id uuid,
  context_entity_id uuid,
  properties jsonb DEFAULT '{}',
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX entity_facets_entity_profile_ctx_ws_uniq ON entity_facets (
  entity_id, profile_id,
  COALESCE(context_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE deleted_at IS NULL;
`;

const OP_KEY = "w2b.reconcile-facet-scope.shared-roles";
const CRM = "f73f40f0-c023-4f2e-b55a-10d3f7539b1f";
const OPS = "708edb59-2299-42d4-9f7b-4c8424aed5c6";
const E1 = "00000000-0000-4000-8000-0000000000e1";
const E2 = "00000000-0000-4000-8000-0000000000e2";
const E3 = "00000000-0000-4000-8000-0000000000e3";

const BOOT: RunOptions = {
  dryRun: false,
  destructiveTail: false,
  deferDestructive: true,
  skipDeferred: true,
};
const OPERATOR: RunOptions = { dryRun: false, destructiveTail: false };
const DRY: RunOptions = { dryRun: true, destructiveTail: false };
const w2b = () => selectManifestOps(CONVERSION_MANIFEST, [OP_KEY]);

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
    `DROP TABLE IF EXISTS "_conversions"; TRUNCATE profiles, entity_facets;`
  );
});
afterAll(async () => {
  await db?.close();
});

async function role(slug: string, scope: string): Promise<string> {
  const [r] = await q(
    `INSERT INTO profiles (slug, profile_kind, scope) VALUES ($1, 'role', $2) RETURNING id`,
    [slug, scope]
  );
  return r.id;
}
async function facet(
  entityId: string,
  profileId: string,
  ws: string | null,
  createdAt: string
): Promise<string> {
  const [r] = await q(
    `INSERT INTO entity_facets (entity_id, profile_id, workspace_id, created_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [entityId, profileId, ws, createdAt]
  );
  return r.id;
}
const wsOf = async (id: string) =>
  (await q(`SELECT workspace_id FROM entity_facets WHERE id = $1`, [id]))[0]
    .workspace_id;

describe("w2b.reconcile-facet-scope.shared-roles", () => {
  it("is in the manifest, deferred at boot", () => {
    const op = CONVERSION_MANIFEST.ops.find((o) => o.opKey === OP_KEY);
    expect(op).toMatchObject({ op: "reconcileFacetScope", deferAtBoot: true });
  });

  it("W2b per-kind entity clean-ups are SLUG-SCOPED and deferred — never an unscoped sweep", () => {
    const w2bEntity = CONVERSION_MANIFEST.ops.filter(
      (o) => o.opKey.startsWith("w2b.") && o.op === "reconcileEntityScope"
    );
    // person, company (W2b) + question, bookmark, document, file, event (W4b).
    expect(w2bEntity.map((o) => (o as { slug?: string }).slug).sort()).toEqual([
      "bookmark",
      "company",
      "document",
      "event",
      "file",
      "person",
      "question",
    ]);
    for (const op of w2bEntity) {
      expect(op, op.opKey).toMatchObject({ deferAtBoot: true });
      expect((op as { slug?: string }).slug, op.opKey).toBeTruthy();
      expect([
        "knowledge",
        "note",
        "task",
        "decision",
        "finding",
        "research",
        // w10 note/item fold keeps items on their home workspace.
        "item",
      ]).not.toContain((op as { slug?: string }).slug);
    }
  });

  it("boot does not run it; a dry run counts without writing", async () => {
    const client = await role("client", "shared");
    const f = await facet(E1, client, CRM, "2026-09-01");
    const boot = await runConversions(sql, w2b(), BOOT);
    expect(boot.results[0].status).toBe("deferred");
    const dry = await runConversions(sql, w2b(), DRY);
    expect(dry.results[0].counts).toMatchObject({ facetsRescoped: 1 });
    expect(await wsOf(f)).toBe(CRM);
  });

  it("re-nulls shared + system role facets, never a workspace-private role's", async () => {
    const client = await role("client", "shared");
    const contact = await role("contact", "system");
    const crmOnly = await role("crm-note", "workspace");
    const fShared = await facet(E1, client, CRM, "2026-09-01");
    const fSystem = await facet(E1, contact, CRM, "2026-09-01");
    const fPrivate = await facet(E1, crmOnly, CRM, "2026-09-01");
    const run = await runConversions(sql, w2b(), OPERATOR);
    expect(run.hadError).toBe(false);
    expect(run.results[0].counts).toMatchObject({ facetsRescoped: 2 });
    expect(await wsOf(fShared)).toBeNull();
    expect(await wsOf(fSystem)).toBeNull();
    expect(await wsOf(fPrivate)).toBe(CRM);
  });

  it("collision-safe: one survivor per group (earliest), parked rows counted, pod-wide twin blocks the move", async () => {
    const client = await role("client", "shared");
    // E2: worn in CRM (earlier) and Operations (later) → CRM row goes pod-wide.
    const early = await facet(E2, client, CRM, "2026-08-01");
    const late = await facet(E2, client, OPS, "2026-09-01");
    // E3: already has a pod-wide client facet → its lensed row must not move.
    const podWide = await facet(E3, client, null, "2026-07-01");
    const blocked = await facet(E3, client, CRM, "2026-09-01");
    const run = await runConversions(sql, w2b(), OPERATOR);
    expect(run.hadError, JSON.stringify(run.results)).toBe(false);
    expect(run.results[0].counts).toMatchObject({
      facetsRescoped: 1,
      facetsParked: 2,
    });
    expect(await wsOf(early)).toBeNull();
    expect(await wsOf(late)).toBe(OPS);
    expect(await wsOf(podWide)).toBeNull();
    expect(await wsOf(blocked)).toBe(CRM);
    const live = await q(
      `SELECT count(*)::int AS n FROM entity_facets WHERE deleted_at IS NULL`
    );
    expect(live[0].n).toBe(4); // nothing deleted
  });
});
