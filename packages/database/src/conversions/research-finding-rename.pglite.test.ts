/**
 * REAL-POSTGRES (PGlite) test for `research.finding-kind-to-research-finding`
 * (plan b38e5e64 decision 5): a `fromTemplate` renameProfile renames only the
 * `finding` rows research-base installed, driven through the REAL manifest
 * entry (selected by opKey) and `runConversions`, as boot runs it.
 *
 * Each fixture row is chosen to rule a WRONG rule out:
 *   - the pod-wide problem-report `finding` (shared, its row in Pod Admin):
 *     rules out a rename by slug alone — it and its things must keep `finding`;
 *   - a research space stamped only by `settings.packageSlug` (no column):
 *     rules out reading only `package_slug`;
 *   - a CRM space's own `finding` row: rules out "every workspace-scoped row";
 *   - a `research-finding` already beside one research row: rules out a boot
 *     that aborts (that row is left and counted, the others still move).
 * DDL: hand-written, only the columns engine.ts touches (sibling convention).
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
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_slug text,
  settings jsonb DEFAULT '{}'
);
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
`;

const KEY = "research.finding-kind-to-research-finding";
/** Exactly how pod boot runs the manifest (BOOT_CONVERSION_OPTIONS). */
const BOOT: RunOptions = {
  dryRun: false,
  destructiveTail: false,
  deferDestructive: true,
  skipDeferred: true,
};

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
    `DROP TABLE IF EXISTS "_conversions"; TRUNCATE workspaces, profiles, entities;`
  );
});

afterAll(async () => {
  await db?.close();
});

async function space(
  packageSlug: string | null,
  settings: Record<string, unknown> = {}
): Promise<string> {
  const [row] = await q(
    `INSERT INTO workspaces (package_slug, settings) VALUES ($1, $2) RETURNING id`,
    [packageSlug, JSON.stringify(settings)]
  );
  return row.id;
}
async function profile(
  slug: string,
  scope: string,
  workspaceId: string | null
): Promise<string> {
  const [row] = await q(
    `INSERT INTO profiles (slug, display_name, scope, workspace_id) VALUES ($1, 'Finding', $2, $3) RETURNING id`,
    [slug, scope, workspaceId]
  );
  return row.id;
}
async function entity(profileId: string, type: string): Promise<string> {
  const [row] = await q(
    `INSERT INTO entities (profile_id, type) VALUES ($1, $2) RETURNING id`,
    [profileId, type]
  );
  return row.id;
}
const slugOf = async (id: string) =>
  (await q(`SELECT slug FROM profiles WHERE id = $1`, [id]))[0].slug;
const typesOf = async (profileId: string) =>
  (
    await q(`SELECT type FROM entities WHERE profile_id = $1 ORDER BY type`, [
      profileId,
    ])
  ).map((r) => r.type);
const errorsOf = (s: RunSummary) =>
  s.results.filter((r) => r.error).map((r) => `${r.opKey}: ${r.error}`);
const run = (options: RunOptions = BOOT) =>
  runConversions(sql, selectManifestOps(CONVERSION_MANIFEST, [KEY]), options);

describe(KEY, () => {
  it("runs at boot: the manifest entry is not deferred", () => {
    const op = CONVERSION_MANIFEST.ops.find((o) => o.opKey === KEY);
    expect(op).toMatchObject({
      op: "renameProfile",
      slug: "finding",
      toSlug: "research-finding",
      fromTemplate: "research-base",
    });
    expect(op?.deferAtBoot).toBeFalsy();
  });

  it("renames only research-base's rows; the pod-wide problem findings keep `finding`", async () => {
    const podAdmin = await space(null);
    const research = await space("research-base");
    const legacyResearch = await space(null, { packageSlug: "research-base" });
    const crm = await space("crm");

    const problems = await profile("finding", "shared", podAdmin);
    const p1 = await entity(problems, "finding");
    await entity(problems, "finding");
    const facts = await profile("finding", "workspace", research);
    await entity(facts, "finding");
    await entity(facts, "finding");
    await entity(facts, "finding");
    const legacy = await profile("finding", "workspace", legacyResearch);
    await entity(legacy, "finding");
    const crmOwn = await profile("finding", "workspace", crm);
    await entity(crmOwn, "finding");

    const s = await run();
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);
    expect(s.results[0]).toMatchObject({
      status: "applied",
      counts: { profilesUpdated: 2, entitiesRetyped: 4 },
    });

    expect(await slugOf(facts)).toBe("research-finding");
    expect(await typesOf(facts)).toEqual([
      "research-finding",
      "research-finding",
      "research-finding",
    ]);
    expect(await slugOf(legacy)).toBe("research-finding");
    expect(await typesOf(legacy)).toEqual(["research-finding"]);

    expect(await slugOf(problems)).toBe("finding");
    expect(await typesOf(problems)).toEqual(["finding", "finding"]);
    expect(await slugOf(crmOwn)).toBe("finding");
    expect(await typesOf(crmOwn)).toEqual(["finding"]);
    // The row keeps its id: the thing still points at the same profile.
    expect(
      (await q(`SELECT profile_id FROM entities WHERE id = $1`, [p1]))[0]
        .profile_id
    ).toBe(problems);
  });

  it("leaves a row whose `research-finding` twin already exists, never aborting the boot", async () => {
    const early = await space("research-base");
    const late = await space(null, { packageSlug: "research-base" });
    const twinned = await profile("finding", "workspace", early);
    await entity(twinned, "finding");
    await profile("research-finding", "workspace", early);
    const plain = await profile("finding", "workspace", late);
    await entity(plain, "finding");

    const s = await run();
    expect(errorsOf(s), errorsOf(s).join("\n")).toEqual([]);
    expect(s.results[0].counts).toEqual({
      profilesKeptTwin: 1,
      profilesUpdated: 1,
      entitiesRetyped: 1,
    });
    expect(await slugOf(twinned)).toBe("finding");
    expect(await typesOf(twinned)).toEqual(["finding"]);
    expect(await slugOf(plain)).toBe("research-finding");
  });

  it("is a noop on a pod with no research-base space", async () => {
    const podAdmin = await space(null);
    const problems = await profile("finding", "shared", podAdmin);
    await entity(problems, "finding");
    const s = await run();
    expect(errorsOf(s)).toEqual([]);
    expect(s.results[0].counts).toEqual({});
    expect(await slugOf(problems)).toBe("finding");
  });

  it("says which spaces it touches before a person agrees", () => {
    const op = CONVERSION_MANIFEST.ops.find((o) => o.opKey === KEY)!;
    expect(describeConversionOp(op)).toBe(
      'Rename the kind "finding" to "research-finding" in the spaces made from research-base.'
    );
  });
});
