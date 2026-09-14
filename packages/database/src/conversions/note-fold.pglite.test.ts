/**
 * REAL-POSTGRES (PGlite) test for the W10 note fold — driven through the REAL
 * `CONVERSION_MANIFEST` and `runConversions`, never a hand-built op.
 *
 * The decision it pins (founder, 2026-09-14): `note` is a primary kind; `item`
 * is not a kind. Concretely:
 *   (a) a FRESH pod (seeder profiles, note has data, no item) — boot creates no
 *       `item` row and leaves notes alone; a full operator `--destructive-tail`
 *       run does not merge notes anywhere either (the retired w3c op would
 *       have: notes → item, or a stranding refusal halting the run);
 *   (b) a w3c-APPLIED pod (live shape: item/note/capture all `scope=system`
 *       with the SAME workspace stamp, item carrying the former notes) — the
 *       operator runbook moves item + capture entities onto note, rewrites
 *       views, retires item + capture — and a full operator pass afterwards
 *       leaves every entity's home workspace stamp alone;
 *   (c) an UNPAIRED item (no same-scope note canonical) with live data is
 *       REFUSED and not ledgered as applied.
 *
 * DDL: hand-written like the sibling conversion pglite tests (only the columns
 * engine.ts touches). `profiles` carries `origin`/`lifecycle` exactly as the
 * uncommitted migration 0263 / engine.integration.test.ts declare them, because
 * seedKindProfile (w4.seed.campaign, applied on a full run) now INSERTs
 * `origin` — without it this file would go red for a peer's reason.
 *
 * One PGlite per file (tables truncated between tests), not one per test.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { ensureConversionsLedger, runConversions } from "./engine.js";
import type { RunOptions, RunSummary } from "./engine.js";
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
  display_name text,
  profile_kind text DEFAULT 'kind',
  scope text DEFAULT 'system',
  entity_scope text DEFAULT 'pod',
  workspace_id uuid,
  is_active boolean DEFAULT true,
  applicable_kinds text[],
  ui_hints jsonb DEFAULT '{}',
  origin text NOT NULL DEFAULT 'unknown',
  lifecycle text NOT NULL DEFAULT 'active',
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
CREATE UNIQUE INDEX pd_base ON property_defs (slug, profile_id)
  WHERE workspace_id IS NULL AND profile_id IS NOT NULL;
CREATE UNIQUE INDEX pd_overlay ON property_defs (slug, profile_id, workspace_id)
  WHERE workspace_id IS NOT NULL AND profile_id IS NOT NULL;
CREATE TABLE profile_properties (
  profile_id uuid NOT NULL,
  property_def_id uuid NOT NULL,
  PRIMARY KEY (profile_id, property_def_id)
);
CREATE TABLE views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_profile_ids uuid[] DEFAULT '{}'
);
`;

/** The live pod's shared workspace stamp on the system item/note/capture rows. */
const WS_STAMP = "15ec8dcf-b1b5-4f6f-b56b-612d4b0bdfa1";
const WS_A = "808939d1-86b3-4c52-a153-ae06ece2c54e";
const WS_OTHER = "99999999-0000-4000-8000-000000000009";

const MERGE_KEY = "w10.merge.item-capture-into-note";

/** Exactly how pod boot invokes the engine (apps/api startup/boot-status.ts). */
const BOOT: RunOptions = {
  dryRun: false,
  destructiveTail: false,
  deferDestructive: true,
  skipDeferred: true,
};
/** `run-conversions.ts --apply --destructive-tail`. */
const OPERATOR_TAIL: RunOptions = { dryRun: false, destructiveTail: true };

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
  await db.exec(`
    DROP TABLE IF EXISTS "_conversions";
    TRUNCATE profiles, entities, entity_facets, property_defs, profile_properties, views;
  `);
});

afterAll(async () => {
  await db?.close();
});

async function profile(
  slug: string,
  opts: { entityScope?: string; workspaceId?: string | null } = {}
): Promise<string> {
  const [row] = await q(
    `INSERT INTO profiles (slug, display_name, scope, entity_scope, workspace_id)
     VALUES ($1, $1, 'system', $2, $3) RETURNING id`,
    [slug, opts.entityScope ?? "pod", opts.workspaceId ?? null]
  );
  return row.id;
}

async function entity(
  profileId: string,
  type: string,
  workspaceId: string | null = null,
  props: Record<string, unknown> = {}
): Promise<string> {
  const [row] = await q(
    `INSERT INTO entities (profile_id, type, workspace_id, properties)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [profileId, type, workspaceId, JSON.stringify(props)]
  );
  return row.id;
}

const errorsOf = (s: RunSummary) =>
  s.results.filter((r) => r.error).map((r) => `${r.opKey}: ${r.error}`);
const resultOf = (s: RunSummary, opKey: string) =>
  s.results.find((r) => r.opKey === opKey);
const appliedKeys = async () =>
  (
    await q(
      `SELECT op_key FROM "_conversions" WHERE error IS NULL AND dry_run = false`
    )
  ).map((r) => r.op_key as string);
const onlyOps = (...keys: string[]) =>
  selectManifestOps(CONVERSION_MANIFEST, keys);

describe("W10 note fold — (a) fresh pod never grows an `item`", () => {
  it("boot creates no item row, declares note protected, defers the fold; a full operator tail leaves notes alone", async () => {
    const noteId = await profile("note");
    for (const slug of ["person", "company", "task"]) await profile(slug);
    await entity(noteId, "note", null, { content: "first" });
    await entity(noteId, "note", null, { content: "second" });
    const notesBefore = await q(
      `SELECT id, profile_id, type, workspace_id, properties FROM entities ORDER BY id`
    );

    const boot = await runConversions(sql, CONVERSION_MANIFEST, BOOT);
    expect(errorsOf(boot), errorsOf(boot).join("\n")).toEqual([]);
    expect(boot.hadError).toBe(false);
    expect(await q(`SELECT id FROM profiles WHERE slug = 'item'`)).toEqual([]);

    // The retired ops are ledgered keeps (no-ops), not seeds/merges.
    for (const key of ["w3a.seed.item", "w3c.merge.note-capture-into-item"]) {
      expect(resultOf(boot, key)).toMatchObject({ op: "keep", status: "noop" });
    }
    expect(resultOf(boot, "w10.declare.note")?.status).toBe("applied");
    const [note] = await q(`SELECT ui_hints FROM profiles WHERE id = $1`, [
      noteId,
    ]);
    expect(note.ui_hints.protected).toBe(true);
    expect(resultOf(boot, MERGE_KEY)).toMatchObject({
      status: "deferred",
      deferReason: "destructive-tail",
    });

    // Deliberate operator run over the WHOLE manifest, destructive tail on.
    const operator = await runConversions(
      sql,
      CONVERSION_MANIFEST,
      OPERATOR_TAIL
    );
    expect(errorsOf(operator), errorsOf(operator).join("\n")).toEqual([]);
    expect(operator.hadError).toBe(false);
    expect(resultOf(operator, MERGE_KEY)?.status).toBe("noop");
    expect(await q(`SELECT id FROM profiles WHERE slug = 'item'`)).toEqual([]);
    expect(
      await q(
        `SELECT id, profile_id, type, workspace_id, properties FROM entities ORDER BY id`
      )
    ).toEqual(notesBefore);
    const [noteAfter] = await q(
      `SELECT is_active FROM profiles WHERE id = $1`,
      [noteId]
    );
    expect(noteAfter.is_active).toBe(true);
  }, 60_000);
});

describe("W10 note fold — (b) w3c-applied pod folds item + capture into note", () => {
  it("dry run → apply --destructive-tail → full operator pass: entities on note, views rewritten, item + capture retired, home workspaces kept", async () => {
    // Live shape: all three system rows share ONE workspace stamp.
    const itemId = await profile("item", { workspaceId: WS_STAMP });
    const noteId = await profile("note", { workspaceId: WS_STAMP });
    const captureId = await profile("capture", {
      entityScope: "workspace",
      workspaceId: WS_STAMP,
    });
    const formerNote = await entity(itemId, "item", null, {
      content: "Untitled Note",
    });
    const stampedItem = await entity(itemId, "item", WS_A);
    const captured = await entity(captureId, "capture", WS_OTHER);
    // A note created inside a workspace: its home stamp must survive the fold.
    const nativeNote = await entity(noteId, "note", WS_A);
    const [def] = await q(
      `INSERT INTO property_defs (profile_id, slug) VALUES ($1, 'sourceUrl') RETURNING id`,
      [itemId]
    );
    await q(
      `INSERT INTO profile_properties (profile_id, property_def_id) VALUES ($1, $2)`,
      [itemId, def.id]
    );
    const [noteBento] = await q(
      `INSERT INTO views (scope_profile_ids) VALUES (ARRAY[$1]::uuid[]) RETURNING id`,
      [itemId]
    );
    const [activity] = await q(
      `INSERT INTO views (scope_profile_ids) VALUES (ARRAY[$1, $2]::uuid[]) RETURNING id`,
      [captureId, itemId]
    );
    // w3a seed + w3c merge already ledgered, as on the live pod.
    await ensureConversionsLedger(sql);
    await q(
      `INSERT INTO "_conversions" (op_key) VALUES ('w3a.seed.item'), ('w3c.merge.note-capture-into-item')`
    );

    const mergeOnly = onlyOps(MERGE_KEY);
    expect(mergeOnly.ops.map((o) => o.opKey)).toEqual([MERGE_KEY]);

    // Dry run: counts the fold, writes nothing.
    const dry = await runConversions(sql, mergeOnly, {
      dryRun: true,
      destructiveTail: false,
    });
    expect(errorsOf(dry), errorsOf(dry).join("\n")).toEqual([]);
    expect(dry.results[0].counts).toMatchObject({
      entitiesRepointed: 3,
      // Counted per source-slug UPDATE, not per distinct view: "Activity" is
      // scoped to BOTH capture and item, so it is rewritten on each pass (2 views,
      // 3 rewrites). Correctness of the final scope is asserted on the rows below.
      viewsRewritten: 3,
    });
    expect(
      (
        await q(`SELECT profile_id FROM entities WHERE id = $1`, [formerNote])
      )[0].profile_id
    ).toBe(itemId);
    expect(await appliedKeys()).not.toContain(MERGE_KEY);

    // Apply with the destructive tail (repoint + retire as one unit).
    const applied = await runConversions(sql, mergeOnly, OPERATOR_TAIL);
    expect(errorsOf(applied), errorsOf(applied).join("\n")).toEqual([]);
    expect(applied.results[0]).toMatchObject({ status: "applied" });
    expect(applied.results[0].counts).toMatchObject({
      entitiesRepointed: 3,
      // Counted per source-slug UPDATE, not per distinct view: "Activity" is
      // scoped to BOTH capture and item, so it is rewritten on each pass (2 views,
      // 3 rewrites). Correctness of the final scope is asserted on the rows below.
      viewsRewritten: 3,
      profilesDeactivated: 2,
    });

    const rows = await q(
      `SELECT id, profile_id, type FROM entities WHERE id = ANY($1::uuid[])`,
      [[formerNote, stampedItem, captured, nativeNote]]
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.profile_id).toBe(noteId);
      expect(r.type).toBe("note");
    }
    const views = await q(
      `SELECT id, scope_profile_ids FROM views WHERE id = ANY($1::uuid[])`,
      [[noteBento.id, activity.id]]
    );
    for (const v of views) {
      expect(v.scope_profile_ids).not.toContain(itemId);
      expect(v.scope_profile_ids).not.toContain(captureId);
      expect(v.scope_profile_ids).toContain(noteId);
    }
    const actives = Object.fromEntries(
      (await q(`SELECT slug, is_active FROM profiles`)).map((p) => [
        p.slug,
        p.is_active,
      ])
    );
    expect(actives).toEqual({ item: false, capture: false, note: true });
    const [movedDef] = await q(
      `SELECT profile_id FROM property_defs WHERE id = $1`,
      [def.id]
    );
    expect(movedDef.profile_id).toBe(noteId);
    expect(await appliedKeys()).toContain(MERGE_KEY);

    // A later full operator pass (`--apply --destructive-tail`, whole manifest,
    // NO skipDeferred — so a deferAtBoot op runs too) must not erase any
    // entity's home workspace. Everything before w10 is ledgered, as on the live
    // pod (derived from manifest order, not hand-listed), so exactly the ops
    // from w10 onward run.
    const firstW10 = CONVERSION_MANIFEST.ops.findIndex(
      (o) => o.opKey === "w10.declare.note"
    );
    expect(firstW10).toBeGreaterThan(30);
    for (const op of CONVERSION_MANIFEST.ops.slice(0, firstW10)) {
      await q(
        `INSERT INTO "_conversions" (op_key) VALUES ($1) ON CONFLICT (op_key) DO NOTHING`,
        [op.opKey]
      );
    }
    const pass = await runConversions(sql, CONVERSION_MANIFEST, OPERATOR_TAIL);
    expect(errorsOf(pass), errorsOf(pass).join("\n")).toEqual([]);
    expect(resultOf(pass, "w10.declare.note")?.status).toBe("applied");
    expect(resultOf(pass, MERGE_KEY)?.status).toBe("skipped");

    const homes = Object.fromEntries(
      (
        await q(
          `SELECT id, workspace_id FROM entities WHERE id = ANY($1::uuid[])`,
          [[nativeNote, stampedItem, captured]]
        )
      ).map((r) => [r.id, r.workspace_id])
    );
    // The discriminating row: a note that ALREADY had a home workspace keeps it.
    expect(homes[nativeNote]).toBe(WS_A);
    expect(homes[stampedItem]).toBe(WS_A);
    expect(homes[captured]).toBe(WS_OTHER);
  }, 60_000);
});

describe("W10 note fold — (c) an unpaired item is refused, never ledgered", () => {
  const shapes = [
    { name: "no note row at all", noteWorkspace: undefined },
    {
      name: "note stamped with a DIFFERENT workspace",
      noteWorkspace: WS_OTHER,
    },
  ] as const;

  for (const shape of shapes) {
    it(`refuses the fold when ${shape.name}`, async () => {
      const itemId = await profile("item", { workspaceId: WS_STAMP });
      if (shape.noteWorkspace !== undefined) {
        await profile("note", { workspaceId: shape.noteWorkspace });
      }
      const stranded = await entity(itemId, "item");

      const run = await runConversions(sql, onlyOps(MERGE_KEY), OPERATOR_TAIL);
      expect(run.hadError).toBe(true);
      expect(run.results[0]).toMatchObject({
        opKey: MERGE_KEY,
        status: "error",
      });
      expect(run.results[0].error).toMatch(/refusing to record a no-op/);

      const [row] = await q(
        `SELECT profile_id, type FROM entities WHERE id = $1`,
        [stranded]
      );
      expect(row).toEqual({ profile_id: itemId, type: "item" });
      const [item] = await q(`SELECT is_active FROM profiles WHERE id = $1`, [
        itemId,
      ]);
      expect(item.is_active).toBe(true);
      expect(await appliedKeys()).not.toContain(MERGE_KEY);
    }, 60_000);
  }
});
