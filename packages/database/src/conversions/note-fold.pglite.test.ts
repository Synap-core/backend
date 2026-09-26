/**
 * REAL-POSTGRES (PGlite) test for the cancelled item→note fold — driven through
 * the REAL `CONVERSION_MANIFEST` and `runConversions`, never a hand-built op.
 *
 * The decision it pins (founder, 2026-09-15 — REVERSES part of 2026-09-14):
 * `item` REMAINS a real kind ("item should still exist") and `note` remains a
 * first-class kind too. The item+capture → note fold is CANCELLED. Concretely:
 *   (a) a FRESH pod — boot CREATES the `item` row (w3a.seed.item is a live
 *       seedKindProfile again), declares `note` protected, and ledgers BOTH
 *       retired folds (w3c note→item and w10 item→note) as keeps; a full operator
 *       `--destructive-tail` pass moves nothing and leaves both kinds active;
 *   (b) an item-CARRYING pod (a live `item` row with entities, alongside note +
 *       capture) — a full operator pass leaves every entity on its own profile
 *       and every kind active. This is the discriminating case: re-enabling the
 *       w10 fold repoints these entities onto note and turns it red.
 *
 * DDL: hand-written like the sibling conversion pglite tests (only the columns
 * engine.ts touches). `profiles` carries `origin`/`lifecycle` exactly as the
 * uncommitted migration 0263 / engine.integration.test.ts declare them, because
 * seedKindProfile (w3a.seed.item and w4.seed.campaign) now INSERTs `origin` —
 * without it this file would go red for a peer's reason.
 *
 * One PGlite per file (tables truncated between tests), not one per test.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { ensureConversionsLedger, runConversions } from "./engine.js";
import type { RunOptions, RunSummary } from "./engine.js";
import { CONVERSION_MANIFEST } from "./manifest.js";

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
  created_at timestamptz DEFAULT now(),
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

describe("item + note are BOTH kinds — (a) a fresh pod seeds item, never folds it", () => {
  it("boot CREATES the item row, declares note protected, keeps both folds; a full operator tail moves nothing", async () => {
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

    // The 2026-09-14 keep flip is REVERSED: the seed is live again.
    expect(resultOf(boot, "w3a.seed.item")).toMatchObject({
      op: "seedKindProfile",
      status: "applied",
    });
    const items = await q(
      `SELECT id, profile_kind, entity_scope, is_active FROM profiles WHERE slug = 'item'`
    );
    expect(items).toHaveLength(1);
    expect(items[0].entity_scope).toBe("pod");
    expect(items[0].is_active).toBe(true);

    // Both directions of the fold are ledgered KEEPS (no-ops) — nothing moves.
    for (const key of ["w3c.merge.note-capture-into-item", MERGE_KEY]) {
      expect(resultOf(boot, key)).toMatchObject({ op: "keep", status: "noop" });
    }
    expect(resultOf(boot, "w10.declare.note")?.status).toBe("applied");
    const [note] = await q(`SELECT ui_hints FROM profiles WHERE id = $1`, [
      noteId,
    ]);
    expect(note.ui_hints.protected).toBe(true);

    // Deliberate operator run over the WHOLE manifest, destructive tail on.
    const operator = await runConversions(
      sql,
      CONVERSION_MANIFEST,
      OPERATOR_TAIL
    );
    expect(errorsOf(operator), errorsOf(operator).join("\n")).toEqual([]);
    expect(operator.hadError).toBe(false);
    // Boot already ledgered the keep, so the operator pass skips it as applied
    // (a keep is a no-op — it never had a destructive tail to defer).
    expect(resultOf(operator, MERGE_KEY)?.status).toBe("skipped");
    // The item row survives the operator pass — still a live kind.
    const [itemAfter] = await q(
      `SELECT is_active, profile_kind FROM profiles WHERE slug = 'item'`
    );
    expect(itemAfter.is_active).toBe(true);
    expect(itemAfter.profile_kind).toBe("kind");
    // Notes are untouched (same rows, same profile, same properties).
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

describe("item + note are BOTH kinds — (b) an item-carrying pod is left alone", () => {
  it("the w10 tail leaves item entities on item, home workspaces intact, all three kinds active", async () => {
    // Live shape: all three system rows share ONE workspace stamp.
    const itemId = await profile("item", { workspaceId: WS_STAMP });
    const noteId = await profile("note", { workspaceId: WS_STAMP });
    const captureId = await profile("capture", {
      entityScope: "workspace",
      workspaceId: WS_STAMP,
    });
    const itemEntity = await entity(itemId, "item", WS_A, {
      content: "an item that must stay an item",
    });
    const noteEntity = await entity(noteId, "note", WS_A);
    const captured = await entity(captureId, "capture", WS_OTHER);

    // Everything before w10 is ledgered, exactly as on the live pod (derived
    // from manifest order, not hand-listed), so the operator pass below runs
    // ONLY the w10 tail. Without this, the pre-existing pod-scope normalisation
    // (`w4.reconcile-entity-scope`, unrelated to this fold) re-nulls every
    // pod-scope entity's workspace stamp and would mask what we are pinning.
    await ensureConversionsLedger(sql);
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

    // The operator runbook that WOULD have folded, had w10 held.
    const pass = await runConversions(sql, CONVERSION_MANIFEST, OPERATOR_TAIL);
    expect(errorsOf(pass), errorsOf(pass).join("\n")).toEqual([]);
    expect(pass.hadError).toBe(false);
    expect(resultOf(pass, "w10.declare.note")?.status).toBe("applied");
    // The discriminating result: the fold is a keep, not a merge.
    expect(resultOf(pass, MERGE_KEY)).toMatchObject({
      op: "keep",
      status: "noop",
    });
    expect(resultOf(pass, "w3c.merge.note-capture-into-item")?.status).toBe(
      "skipped"
    );

    // Nothing was repointed.
    const rows = await q(
      `SELECT id, profile_id, type, workspace_id FROM entities WHERE id = ANY($1::uuid[])`,
      [[itemEntity, noteEntity, captured]]
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[itemEntity]).toMatchObject({
      profile_id: itemId,
      type: "item",
    });
    expect(byId[noteEntity]).toMatchObject({
      profile_id: noteId,
      type: "note",
    });
    expect(byId[captured]).toMatchObject({
      profile_id: captureId,
      type: "capture",
    });
    // Home workspaces survive too — the fold must not re-home anything.
    expect(byId[itemEntity].workspace_id).toBe(WS_A);
    expect(byId[noteEntity].workspace_id).toBe(WS_A);
    expect(byId[captured].workspace_id).toBe(WS_OTHER);

    // Every kind stays active — nothing is retired, nothing is drained.
    const actives = Object.fromEntries(
      (await q(`SELECT slug, is_active FROM profiles`)).map((p) => [
        p.slug,
        p.is_active,
      ])
    );
    expect(actives.item).toBe(true);
    expect(actives.note).toBe(true);
    expect(actives.capture).toBe(true);
  }, 60_000);
});
