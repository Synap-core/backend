/**
 * The APPROVED `profile/merge` door on a real Postgres (PGlite) through the
 * REAL conversions engine — no `runConversions` mock.
 *
 * Why this file exists: `pod-hygiene.pglite.test.ts` stubs the engine, so it
 * never met the engine's LEDGER TRAP (a real run of a destructive-tail op
 * without `destructiveTail` is refused, status 'error'). `applyProfileMerge`
 * ran with `destructiveTail: false`, so EVERY approved merge threw
 * PRECONDITION_FAILED while that suite stayed green.
 *
 * Pinned: an approved merge APPLIES — entities repointed onto the canonical
 * row, the drained twin deactivated + tombstoned (`mergedInto` = canonical),
 * the proposal-scoped opKey ledgered, and a re-approve is a ledger skip.
 *
 * Stubbed, and why:
 *  - `sql` — the engine takes a postgres.js `Sql`; swapped for the same
 *    PGlite shim the engine's own suites use (`retirement-tombstone.pglite`).
 *  - `isPodAdmin` — the authority flag has its own suite; true here.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  pg: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  h.pg = pg as unknown as typeof h.pg;

  // postgres.js-shaped `Sql` over PGlite (same contract as the engine tests).
  class Frag {
    constructor(
      readonly strings: readonly string[],
      readonly values: unknown[]
    ) {}
  }
  const flatten = (frag: Frag) => {
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
  };
  const exec = async (text: string, params: unknown[]) => {
    const res = await pg.query(text, params);
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
  sql.begin = async (fn: (tx: unknown) => Promise<unknown>) => {
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
  return { ...actual, sql };
});
vi.mock("../../../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: vi.fn(async () => true),
}));

import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  profiles,
  profileWorkspaceAccess,
  entities,
  entityFacets,
  propertyDefs,
  profileProperties,
  views,
  readProfileRetirement,
} from "@synap/database";
import { applyProfileMerge, type MergeSuggestion } from "../retire-profile.js";

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

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "99999999-9999-4999-8999-999999999999";
const PROPOSAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function seedProfile(row: {
  slug: string;
  scope: string;
  workspaceId?: string | null;
  ageDays?: number;
}): Promise<string> {
  const r = await h.pg!.query<{ id: string }>(
    `insert into profiles (slug, display_name, scope, workspace_id, user_id,
       profile_kind, is_active, ui_hints, created_at)
     values ($1, $1, $2, $3, $4, 'kind', true, '{}'::jsonb, now() - ($5 || ' days')::interval)
     returning id`,
    [
      row.slug,
      row.scope,
      row.workspaceId ?? null,
      USER,
      String(row.ageDays ?? 0),
    ]
  );
  return r.rows[0]!.id;
}

async function seedEntity(profileId: string, type: string): Promise<string> {
  const r = await h.pg!.query<{ id: string }>(
    `insert into entities (profile_id, workspace_id, user_id, type, properties)
     values ($1, $2, $3, $4, '{}'::jsonb) returning id`,
    [profileId, WS, USER, type]
  );
  return r.rows[0]!.id;
}

async function profileRow(id: string) {
  const r = await h.pg!.query<{ is_active: boolean; ui_hints: unknown }>(
    `select is_active, ui_hints from profiles where id = $1`,
    [id]
  );
  const p = r.rows[0]!;
  return { isActive: p.is_active, uiHints: p.ui_hints };
}

async function entityProfiles(ids: string[]): Promise<string[]> {
  const r = await h.pg!.query<{ profile_id: string }>(
    `select profile_id from entities where id = any($1::uuid[])`,
    [ids]
  );
  return r.rows.map((x) => x.profile_id);
}

async function ledgered(opKey: string) {
  const r = await h.pg!.query<{ op_key: string; error: string | null }>(
    `select op_key, error from "_conversions" where op_key = $1 and dry_run = false`,
    [opKey]
  );
  return r.rows;
}

beforeAll(async () => {
  for (const t of [
    profiles,
    profileWorkspaceAccess,
    entities,
    entityFacets,
    propertyDefs,
    profileProperties,
    views,
  ]) {
    await h.pg!.exec(ddlFor(t as unknown as PgTable));
  }
}, 120_000);

beforeEach(async () => {
  await h.pg!.exec(`
    DROP TABLE IF EXISTS "_conversions";
    TRUNCATE profiles, profile_workspace_access, entities, entity_facets, property_defs, profile_properties, views;
  `);
});

describe(
  "applyProfileMerge runs the real conversions engine",
  { timeout: 60_000 },
  () => {
    it("dedupeProfileRows: repoints the twin's records, retires the twin, ledgers the opKey", async () => {
      const canonical = await seedProfile({
        slug: "knowledge",
        scope: "system",
        ageDays: 2,
      });
      const twin = await seedProfile({
        slug: "knowledge",
        scope: "workspace",
        workspaceId: WS,
      });
      const onTwin = [
        await seedEntity(twin, "knowledge"),
        await seedEntity(twin, "knowledge"),
      ];
      const suggestion: MergeSuggestion = {
        op: "dedupeProfileRows",
        slug: "knowledge",
        canonical: "system",
        canonicalProfileId: canonical,
      };

      const result = await applyProfileMerge({
        proposalId: PROPOSAL,
        approverUserId: USER,
        suggestion,
      });

      expect(result.status).toBe("applied");
      expect(result.counts.entitiesRepointed).toBe(2);
      expect(result.counts.profilesDeactivated).toBe(1);
      expect(await entityProfiles(onTwin)).toEqual([canonical, canonical]);

      const drained = await profileRow(twin);
      expect(drained.isActive).toBe(false);
      expect(readProfileRetirement(drained as never)?.mergedInto).toBe(
        canonical
      );
      expect((await profileRow(canonical)).isActive).toBe(true);

      expect(await ledgered(`pod-hygiene.merge.${PROPOSAL}`)).toEqual([
        { op_key: `pod-hygiene.merge.${PROPOSAL}`, error: null },
      ]);

      // A re-approve is a ledger skip, never a second rewrite or a throw.
      const again = await applyProfileMerge({
        proposalId: PROPOSAL,
        approverUserId: USER,
        suggestion,
      });
      expect(again.status).toBe("skipped");
    });

    it("mergeInto: moves the source kind's records into the target and retires the source", async () => {
      const lead = await seedProfile({
        slug: "lead",
        scope: "workspace",
        workspaceId: WS,
      });
      const crmLead = await seedProfile({
        slug: "crm-lead",
        scope: "workspace",
        workspaceId: WS,
      });
      const onSource = [await seedEntity(crmLead, "crm-lead")];

      const result = await applyProfileMerge({
        proposalId: PROPOSAL,
        approverUserId: USER,
        suggestion: {
          op: "mergeInto",
          fromSlug: "crm-lead",
          intoSlug: "lead",
          intoProfileId: lead,
        },
      });

      expect(result.status).toBe("applied");
      expect(await entityProfiles(onSource)).toEqual([lead]);
      const drained = await profileRow(crmLead);
      expect(drained.isActive).toBe(false);
      expect(readProfileRetirement(drained as never)?.mergedInto).toBe(lead);
      expect(await ledgered(`pod-hygiene.merge.${PROPOSAL}`)).toHaveLength(1);
    });
  }
);
