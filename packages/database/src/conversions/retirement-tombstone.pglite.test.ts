/**
 * Conversion destructive tails + the retirement backfill stamp the
 * `ui_hints.retired` tombstone — against a REAL Postgres (PGlite), the REAL
 * engine, the REAL ProfileRepository and the REAL resolveProfileForApply.
 *
 * Pinned:
 *  (tail) mergeInto same-scope, mergeInto cross-scope and dedupeProfileRows
 *         under destructiveTail stamp `{ at, reason: "conversion:<opKey>",
 *         mergedInto: <canonical id> }` jsonb-MERGED into ui_hints; the merged
 *         slug's workspace seat is then NOT revived by resolveProfileForApply.
 *  (parity) the engine's raw-SQL tombstone reads through readProfileRetirement
 *         identically to markProfileRetired's drizzle one.
 *  (backfill) a LEDGERED op's inactive un-tombstoned source is stamped; second
 *         call stamps 0; an ACTIVE same-slug row, an un-ledgered op's row, an
 *         errored-ledger op's row, an already-tombstoned row and a row with no
 *         canonical are untouched (the last one reported); dry run writes nothing;
 *         runConversions runs the backfill even when the op itself is skipped.
 *
 * Discrimination note: the resolver assertion is discriminating only for the
 * DIFFERENT-slug merge (crm-lead → lead). For the same-slug dedupe the active
 * canonical is resolved before the seat probe runs, so the tombstone assertion
 * itself is what goes red there.
 *
 * ENGINE: one PGlite for the file; every table created from its drizzle
 * definition (enums as text, constraints dropped). Rows truncated per test.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";
import * as schema from "../schema/index.js";
import { profiles, profileWorkspaceAccess } from "../schema/profiles.js";
import { entities } from "../schema/entities.js";
import { entityFacets } from "../schema/entity-facets.js";
import { propertyDefs } from "../schema/property-defs.js";
import { profileProperties } from "../schema/profile-properties.js";
import { views } from "../schema/views.js";
import {
  ProfileRepository,
  markProfileRetired,
} from "../repositories/profile-repository.js";
import {
  readProfileRetirement,
  resolveProfileForApply,
} from "../utils/resolve-profile-for-apply.js";
import {
  conversionRetirement,
  ensureConversionsLedger,
  runConversions,
  tombstoneInactiveProfiles,
} from "./engine.js";
import { backfillConversionRetirements } from "./retirement-backfill.js";
import type { ConversionManifest, ConversionOp } from "./manifest.js";

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

// ─── postgres.js-shaped `Sql` shim over PGlite (same contract as the other engine tests) ──
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

const WS = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const WS3 = "33333333-3333-4333-8333-333333333333";
const WS4 = "44444444-4444-4444-8444-444444444444";
const USER = "99999999-9999-4999-8999-999999999999";

let pg: PGlite;
let sql: Sql;
let repo: ProfileRepository;

async function seed(row: {
  slug: string;
  scope: string;
  workspaceId?: string | null;
  isActive?: boolean;
  uiHints?: Record<string, unknown>;
  ageDays?: number;
}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into profiles (slug, display_name, scope, workspace_id, user_id,
       profile_kind, is_active, ui_hints, created_at)
     values ($1, $1, $2, $3, $4, 'kind', $5, $6::jsonb, now() - ($7 || ' days')::interval)
     returning id`,
    [
      row.slug,
      row.scope,
      row.workspaceId ?? null,
      USER,
      row.isActive ?? true,
      JSON.stringify(row.uiHints ?? {}),
      String(row.ageDays ?? 0),
    ]
  );
  return r.rows[0]!.id;
}

async function row(id: string) {
  const p = await repo.getById(id);
  if (!p) throw new Error(`no profile ${id}`);
  return p;
}

async function ledger(opKey: string, error: string | null = null) {
  await ensureConversionsLedger(sql);
  await pg.query(
    `insert into "_conversions" (op_key, dry_run, counts, error) values ($1, false, '{}'::jsonb, $2)`,
    [opKey, error]
  );
}

const manifestOf = (...ops: ConversionOp[]): ConversionManifest => ({
  version: 1,
  ops,
});
const TAIL = { dryRun: false, destructiveTail: true } as const;

const MERGE_LEAD: ConversionOp = {
  op: "mergeInto",
  opKey: "test.merge.crm-lead-into-lead",
  fromSlugs: ["crm-lead"],
  intoSlug: "lead",
};
const MERGE_CLIENT_SHARED: ConversionOp = {
  op: "mergeInto",
  opKey: "test.merge.crm-client-into-shared-client",
  fromSlugs: ["crm-client"],
  intoSlug: "client",
  intoScope: "shared",
};
const DEDUPE_KNOWLEDGE: ConversionOp = {
  op: "dedupeProfileRows",
  opKey: "test.dedupe.knowledge",
  slug: "knowledge",
  canonical: "system",
};
const MERGE_DEAL_UNLEDGERED: ConversionOp = {
  op: "mergeInto",
  opKey: "test.merge.crm-deal-into-deal",
  fromSlugs: ["crm-deal"],
  intoSlug: "deal",
};
const DEDUPE_CAMPAIGN_ERRORED: ConversionOp = {
  op: "dedupeProfileRows",
  opKey: "test.dedupe.campaign",
  slug: "campaign",
  canonical: "system",
};

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [
    profiles,
    profileWorkspaceAccess,
    entities,
    entityFacets,
    propertyDefs,
    profileProperties,
    views,
  ]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  sql = makePgliteSql(pg);
  repo = new ProfileRepository(drizzle(pg, { schema }) as never);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(`
    DROP TABLE IF EXISTS "_conversions";
    TRUNCATE profiles, profile_workspace_access, entities, entity_facets, property_defs, profile_properties, views;
  `);
});

const TOMBSTONE_KEYS = ["at", "mergedInto", "reason"];

describe(
  "destructive tails stamp the retirement tombstone",
  { timeout: 60_000 },
  () => {
    it("mergeInto same-scope: drained row carries conversion:<opKey> → its canonical, and its seat is not revived", async () => {
      const lead = await seed({
        slug: "lead",
        scope: "workspace",
        workspaceId: WS,
      });
      const crmLead = await seed({
        slug: "crm-lead",
        scope: "workspace",
        workspaceId: WS,
        uiHints: { icon: "target" },
      });

      const summary = await runConversions(sql, manifestOf(MERGE_LEAD), TAIL);
      expect(summary.hadError).toBe(false);
      expect(summary.results[0]!.counts.profilesDeactivated).toBe(1);

      const drained = await row(crmLead);
      expect(drained.isActive).toBe(false);
      const t = readProfileRetirement(drained);
      expect(t).toEqual({
        at: expect.any(String),
        reason: "conversion:test.merge.crm-lead-into-lead",
        mergedInto: lead,
      });
      expect(new Date(t!.at).toISOString()).toBe(t!.at);
      expect((drained.uiHints as Record<string, unknown>).icon).toBe("target");

      const r = await resolveProfileForApply(repo, {
        slug: "crm-lead",
        declaredScope: "workspace",
        declaredKind: "kind",
        workspaceId: WS,
        actorUserId: USER,
      } as never);
      expect((await row(crmLead)).isActive).toBe(false);
      expect(r.profile?.id).toBe(lead);
    });

    it("mergeInto cross-scope: drained workspace row → the shared canonical", async () => {
      const client = await seed({ slug: "client", scope: "shared" });
      const crmClient = await seed({
        slug: "crm-client",
        scope: "workspace",
        workspaceId: WS,
      });

      const summary = await runConversions(
        sql,
        manifestOf(MERGE_CLIENT_SHARED),
        TAIL
      );
      expect(summary.hadError).toBe(false);

      const drained = await row(crmClient);
      expect(drained.isActive).toBe(false);
      expect(readProfileRetirement(drained)).toEqual({
        at: expect.any(String),
        reason: "conversion:test.merge.crm-client-into-shared-client",
        mergedInto: client,
      });
    });

    it("dedupeProfileRows: the workspace twin carries conversion:<opKey> → the system row", async () => {
      const system = await seed({
        slug: "knowledge",
        scope: "system",
        ageDays: 2,
      });
      const twin = await seed({
        slug: "knowledge",
        scope: "workspace",
        workspaceId: WS,
        uiHints: { color: "green" },
      });

      const summary = await runConversions(
        sql,
        manifestOf(DEDUPE_KNOWLEDGE),
        TAIL
      );
      expect(summary.hadError).toBe(false);
      expect(summary.results[0]!.counts.profilesDeactivated).toBe(1);

      const drained = await row(twin);
      expect(drained.isActive).toBe(false);
      expect(readProfileRetirement(drained)).toEqual({
        at: expect.any(String),
        reason: "conversion:test.dedupe.knowledge",
        mergedInto: system,
      });
      expect((drained.uiHints as Record<string, unknown>).color).toBe("green");
      expect((await row(system)).isActive).toBe(true);

      await resolveProfileForApply(repo, {
        slug: "knowledge",
        declaredScope: "workspace",
        declaredKind: "kind",
        workspaceId: WS,
        actorUserId: USER,
      } as never);
      expect((await row(twin)).isActive).toBe(false);
    });

    it("parity: the engine's raw tombstone reads identically to markProfileRetired's", async () => {
      const canonical = await seed({
        slug: "lead",
        scope: "workspace",
        workspaceId: WS,
      });
      const viaEngine = await seed({
        slug: "crm-lead",
        scope: "workspace",
        workspaceId: WS2,
        isActive: false,
        uiHints: { icon: "x" },
      });
      const viaRepo = await seed({
        slug: "crm-lead",
        scope: "workspace",
        workspaceId: WS3,
        uiHints: { icon: "x" },
      });
      const at = new Date("2026-09-14T01:02:03.456Z");
      const opKey = "test.parity";

      expect(
        await tombstoneInactiveProfiles(
          sql,
          [viaEngine],
          conversionRetirement(opKey, canonical, at)
        )
      ).toBe(1);
      await markProfileRetired(drizzle(pg, { schema }) as never, viaRepo, {
        reason: `conversion:${opKey}`,
        mergedInto: canonical,
        at,
      });

      const a = await row(viaEngine);
      const b = await row(viaRepo);
      expect(readProfileRetirement(a)).toEqual(readProfileRetirement(b));
      expect(Object.keys(readProfileRetirement(a)!).sort()).toEqual(
        TOMBSTONE_KEYS
      );
      expect(a.uiHints).toEqual(b.uiHints);
      expect(a.isActive).toBe(b.isActive);
    });
  }
);

describe("backfillConversionRetirements", { timeout: 60_000 }, () => {
  async function seedBackfillWorld() {
    // Ledgered same-scope merge: one drained row (stamp), one ACTIVE same-slug
    // row with its own canonical (untouched), one drained row with no canonical
    // (unresolved), one already-tombstoned drained row (untouched).
    const lead = await seed({
      slug: "lead",
      scope: "workspace",
      workspaceId: WS,
    });
    const drainedLead = await seed({
      slug: "crm-lead",
      scope: "workspace",
      workspaceId: WS,
      isActive: false,
      uiHints: { icon: "target" },
    });
    await seed({ slug: "lead", scope: "workspace", workspaceId: WS2 });
    const activeLead = await seed({
      slug: "crm-lead",
      scope: "workspace",
      workspaceId: WS2,
    });
    const orphanLead = await seed({
      slug: "crm-lead",
      scope: "workspace",
      workspaceId: WS3,
      isActive: false,
    });
    await seed({ slug: "lead", scope: "workspace", workspaceId: WS4 });
    const priorTomb = { at: "2026-01-01T00:00:00.000Z", reason: "deleted" };
    const tombLead = await seed({
      slug: "crm-lead",
      scope: "workspace",
      workspaceId: WS4,
      isActive: false,
      uiHints: { retired: priorTomb },
    });
    // Ledgered dedupe: inactive twin → system canonical.
    const system = await seed({
      slug: "knowledge",
      scope: "system",
      ageDays: 2,
    });
    const twin = await seed({
      slug: "knowledge",
      scope: "workspace",
      workspaceId: WS,
      isActive: false,
    });
    // NOT ledgered merge: inactive source with a canonical → untouched.
    await seed({ slug: "deal", scope: "workspace", workspaceId: WS });
    const deal = await seed({
      slug: "crm-deal",
      scope: "workspace",
      workspaceId: WS,
      isActive: false,
    });
    // Ledger row WITH an error: not applied → untouched.
    await seed({ slug: "campaign", scope: "system", ageDays: 2 });
    const campaignTwin = await seed({
      slug: "campaign",
      scope: "workspace",
      workspaceId: WS,
      isActive: false,
    });

    await ledger(MERGE_LEAD.opKey);
    await ledger(DEDUPE_KNOWLEDGE.opKey);
    await ledger(DEDUPE_CAMPAIGN_ERRORED.opKey, "boom");

    return {
      lead,
      drainedLead,
      activeLead,
      orphanLead,
      tombLead,
      priorTomb,
      system,
      twin,
      deal,
      campaignTwin,
    };
  }

  const ALL = manifestOf(
    MERGE_LEAD,
    DEDUPE_KNOWLEDGE,
    MERGE_DEAL_UNLEDGERED,
    DEDUPE_CAMPAIGN_ERRORED
  );

  it("stamps only ledgered ops' inactive un-tombstoned sources; idempotent; reports the unresolved", async () => {
    const w = await seedBackfillWorld();

    const dry = await backfillConversionRetirements(sql, ALL, { dryRun: true });
    expect(dry).toMatchObject({
      dryRun: true,
      eligible: 2,
      stamped: 0,
      unresolved: 1,
    });
    expect(readProfileRetirement(await row(w.drainedLead))).toBeNull();

    const first = await backfillConversionRetirements(sql, ALL, {
      dryRun: false,
    });
    expect(first).toMatchObject({ eligible: 2, stamped: 2, unresolved: 1 });
    expect(
      first.ops.find((o) => o.opKey === MERGE_LEAD.opKey)!.unresolvedProfileIds
    ).toEqual([w.orphanLead]);
    expect(first.ops.map((o) => o.opKey).sort()).toEqual(
      [MERGE_LEAD.opKey, DEDUPE_KNOWLEDGE.opKey].sort()
    );

    const lead = await row(w.drainedLead);
    expect(lead.isActive).toBe(false);
    expect(readProfileRetirement(lead)).toEqual({
      at: expect.any(String),
      reason: `conversion:${MERGE_LEAD.opKey}`,
      mergedInto: w.lead,
    });
    expect((lead.uiHints as Record<string, unknown>).icon).toBe("target");
    expect(readProfileRetirement(await row(w.twin))).toMatchObject({
      reason: `conversion:${DEDUPE_KNOWLEDGE.opKey}`,
      mergedInto: w.system,
    });

    // Discriminating rows: untouched.
    const active = await row(w.activeLead);
    expect(active.isActive).toBe(true);
    expect(readProfileRetirement(active)).toBeNull();
    expect(readProfileRetirement(await row(w.orphanLead))).toBeNull();
    expect(readProfileRetirement(await row(w.deal))).toBeNull();
    expect(readProfileRetirement(await row(w.campaignTwin))).toBeNull();
    expect(readProfileRetirement(await row(w.tombLead))).toEqual(w.priorTomb);

    const second = await backfillConversionRetirements(sql, ALL, {
      dryRun: false,
    });
    expect(second).toMatchObject({ eligible: 0, stamped: 0, unresolved: 1 });
  });

  it("runConversions runs the backfill before the loop, even though the ledgered op itself is skipped", async () => {
    const w = await seedBackfillWorld();

    const summary = await runConversions(sql, manifestOf(MERGE_LEAD), {
      dryRun: false,
      destructiveTail: false,
    });
    expect(summary.results[0]!.status).toBe("skipped");
    expect(summary.retirementBackfill).toMatchObject({
      stamped: 1,
      unresolved: 1,
    });
    expect(readProfileRetirement(await row(w.drainedLead))).toMatchObject({
      reason: `conversion:${MERGE_LEAD.opKey}`,
      mergedInto: w.lead,
    });

    // …and the seat it protects is not revived by the template apply. (This
    // world also holds an ACTIVE crm-lead in WS2, so the resolver takes its
    // candidate path, not the clean seat probe — the clean-world resolver
    // outcome is pinned by the same-scope tail test above.)
    const r = await resolveProfileForApply(repo, {
      slug: "crm-lead",
      declaredScope: "workspace",
      declaredKind: "kind",
      workspaceId: WS,
      actorUserId: USER,
    } as never);
    expect((await row(w.drainedLead)).isActive).toBe(false);
    expect(r.profile?.id).not.toBe(w.drainedLead);
  });
});
