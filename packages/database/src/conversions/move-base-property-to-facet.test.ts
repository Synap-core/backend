/**
 * REAL-POSTGRES (PGlite) behaviour test for `moveBasePropertyToFacet`
 * (the `crm.person.drive-link-to-client-facet` conversion).
 *
 * WHY A REAL PLANNER: engine.test.ts drives the engine with a FAKE
 * tagged-template `sql` keyed on query substrings — that proves JS
 * orchestration but never sends a byte to a planner, and cannot prove which
 * ROWS the UPDATEs actually match. PGlite is real Postgres compiled to WASM,
 * so the assertions below are about real row state (see
 * engine.integration.test.ts for the fuller rationale on why NOT pg-mem).
 *
 * WHAT IT PROVES:
 *   (a) an entity of `slug` wearing a LIVE facet of `facetSlug` has the base
 *       value copied onto the facet's own `properties[targetKey]` and the base
 *       key stripped;
 *   (b) an entity WITHOUT that facet keeps its base value entirely untouched
 *       (never lost) and is counted as `entitiesSkippedNoFacet`;
 *   (c) an existing facet value for `targetKey` is never clobbered (collision
 *       skip), but the base key is still stripped;
 *   (d) idempotent — a second real run (ledger cleared) is a clean no-op.
 *
 * MUTATION-TESTED: dropping the `EXISTS (... entity_facets ...)` guard on the
 * strip UPDATE turns (b) red — the no-facet entity's base value would be
 * deleted instead of preserved.
 */

import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { runConversions, computeCounts } from "./engine.js";
import type { ConversionManifest } from "./manifest.js";

// ─── postgres.js-shaped `Sql` shim over PGlite (same shim as
// engine.integration.test.ts / merge-cross-scope.test.ts) ────────────────────
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
`;

const USER = "22222222-2222-2222-2222-222222222222";

const OP = {
  op: "moveBasePropertyToFacet",
  opKey: "test.move.driveLink",
  slug: "person",
  sourceKey: "driveLink",
  facetSlug: "client",
  targetKey: "driveLink",
} as const;

function manifestOf(op: ConversionManifest["ops"][number]): ConversionManifest {
  return { version: 1, ops: [op] };
}

async function setupPod() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  const q = async (text: string, params: unknown[] = []) =>
    (await db.query(text, params)).rows as any[];

  const [personProfile] = await q(
    `INSERT INTO profiles (slug, display_name, profile_kind, scope) VALUES ('person','Person','kind','system') RETURNING id`
  );
  const [clientRole] = await q(
    `INSERT INTO profiles (slug, display_name, profile_kind, scope, entity_scope, applicable_kinds)
     VALUES ('client','Client','role','shared','workspace',ARRAY['company','person']) RETURNING id`
  );

  // Alice: a person WITH a live client facet, driveLink on the base row.
  const [alice] = await q(
    `INSERT INTO entities (profile_id, user_id, type, properties)
     VALUES ($1,$2,'person','{"name":"Alice","driveLink":"https://drive/alice"}') RETURNING id`,
    [personProfile.id, USER]
  );
  const [aliceFacet] = await q(
    `INSERT INTO entity_facets (entity_id, profile_id, user_id, status, properties, created_by_kind)
     VALUES ($1,$2,$3,'active','{"clientStatus":"active"}','user') RETURNING id`,
    [alice.id, clientRole.id, USER]
  );

  // Bob: a person WITH driveLink but NO client facet — must be left untouched.
  const [bob] = await q(
    `INSERT INTO entities (profile_id, user_id, type, properties)
     VALUES ($1,$2,'person','{"name":"Bob","driveLink":"https://drive/bob"}') RETURNING id`,
    [personProfile.id, USER]
  );

  return {
    db,
    sql: makePgliteSql(db),
    q,
    ids: {
      personProfile: personProfile.id as string,
      clientRole: clientRole.id as string,
      alice: alice.id as string,
      aliceFacet: aliceFacet.id as string,
      bob: bob.id as string,
    },
  };
}

describe("moveBasePropertyToFacet", () => {
  it("(a) moves the base value onto the client facet and strips the base key", async () => {
    const { sql, q, ids } = await setupPod();

    const summary = await runConversions(sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: false,
    });
    expect(
      summary.results[0].error ?? null,
      summary.results[0].error ?? ""
    ).toBeNull();
    expect(summary.results[0].status).toBe("applied");
    expect(summary.results[0].counts.facetPropertiesMoved).toBe(1);
    expect(summary.results[0].counts.entitiesBasePropertyStripped).toBe(1);
    expect(summary.results[0].counts.entitiesSkippedNoFacet).toBe(1); // Bob

    const [facetRow] = await q(
      `SELECT properties FROM entity_facets WHERE id = $1`,
      [ids.aliceFacet]
    );
    expect(facetRow.properties.driveLink).toBe("https://drive/alice");

    const [aliceRow] = await q(
      `SELECT properties FROM entities WHERE id = $1`,
      [ids.alice]
    );
    expect(aliceRow.properties.driveLink).toBeUndefined();
    expect(aliceRow.properties.name).toBe("Alice"); // untouched sibling key
  });

  it("(b) leaves a person WITHOUT a client facet entirely untouched — never loses the value", async () => {
    const { sql, q, ids } = await setupPod();
    await runConversions(sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: false,
    });

    const [bobRow] = await q(`SELECT properties FROM entities WHERE id = $1`, [
      ids.bob,
    ]);
    expect(bobRow.properties.driveLink).toBe("https://drive/bob");
  });

  it("(c) never clobbers an existing facet value, but still strips the base key", async () => {
    const { sql, q, ids } = await setupPod();
    await q(
      `UPDATE entity_facets SET properties = '{"clientStatus":"active","driveLink":"https://drive/CANONICAL"}' WHERE id = $1`,
      [ids.aliceFacet]
    );

    const summary = await runConversions(sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: false,
    });
    // Collision-skipped: the move itself did not write (facet already had the key).
    expect(summary.results[0].counts.facetPropertiesMoved ?? 0).toBe(0);
    // But the base key is still stripped — the entity wears the facet.
    expect(summary.results[0].counts.entitiesBasePropertyStripped).toBe(1);

    const [facetRow] = await q(
      `SELECT properties FROM entity_facets WHERE id = $1`,
      [ids.aliceFacet]
    );
    expect(facetRow.properties.driveLink).toBe("https://drive/CANONICAL"); // NOT clobbered

    const [aliceRow] = await q(
      `SELECT properties FROM entities WHERE id = $1`,
      [ids.alice]
    );
    expect(aliceRow.properties.driveLink).toBeUndefined();
  });

  it("(d) is idempotent — a second real run touches nothing", async () => {
    const { sql, q, ids } = await setupPod();
    await runConversions(sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: false,
    });
    await q(`DELETE FROM "_conversions"`);
    const again = await runConversions(sql, manifestOf(OP), {
      dryRun: false,
      destructiveTail: false,
    });
    // Alice's base key is already gone → the move+strip selects nothing.
    // Bob still has no facet → still counted as skipped (advisory, non-zero
    // every run until he gets a client facet — see engine.ts OpCounts docs).
    expect(again.results[0].counts.facetPropertiesMoved ?? 0).toBe(0);
    expect(again.results[0].counts.entitiesBasePropertyStripped ?? 0).toBe(0);
    expect(again.results[0].counts.entitiesSkippedNoFacet).toBe(1);

    const [aliceRow] = await q(
      `SELECT properties FROM entities WHERE id = $1`,
      [ids.alice]
    );
    expect(aliceRow.properties.driveLink).toBeUndefined();
  });

  it("dry-run counts the move and skip sets and writes nothing", async () => {
    const { sql, q, ids } = await setupPod();
    const counts = await computeCounts(sql, OP as any, {
      dryRun: true,
      destructiveTail: false,
    });
    expect(counts.facetPropertiesMoved).toBe(1);
    expect(counts.entitiesBasePropertyStripped).toBe(1);
    expect(counts.entitiesSkippedNoFacet).toBe(1);

    // Nothing written.
    const [aliceRow] = await q(
      `SELECT properties FROM entities WHERE id = $1`,
      [ids.alice]
    );
    expect(aliceRow.properties.driveLink).toBe("https://drive/alice");
    const [facetRow] = await q(
      `SELECT properties FROM entity_facets WHERE id = $1`,
      [ids.aliceFacet]
    );
    expect(facetRow.properties.driveLink).toBeUndefined();
  });
});

// ─── B0: renamePropertyKey ───────────────────────────────────────────────────
// Lives in this PGlite-serial file (same shim + schema) rather than a new file,
// because a new pglite file would land in the parallel unit project.
// Discriminating inputs:
//   - TWO `decision` profile rows (system + workspace) → rules out touching only
//     one row of the slug;
//   - a `research` entity carrying the SAME key → rules out a slug-blind UPDATE;
//   - a soft-deleted decision → rules out touching deleted rows (mirrors
//     remapPropertyValues);
//   - a non-string (array) value → rules out a ->> text round-trip;
//   - an entity carrying BOTH keys → the only input where keepTarget and
//     keepSource disagree.
describe("renamePropertyKey", () => {
  const WS = "55555555-5555-5555-5555-555555555555";
  const opOf = (onConflict: "keepTarget" | "keepSource") =>
    ({
      op: "renamePropertyKey",
      opKey: `test.rename.rationale.${onConflict}`,
      slug: "decision",
      sourceKey: "rationale",
      targetKey: "decisionRationale",
      onConflict,
    }) as const;

  async function pod() {
    const db = new PGlite();
    await db.exec(SCHEMA);
    const q = async (text: string, params: unknown[] = []) =>
      (await db.query(text, params)).rows as any[];
    const [sysDecision] = await q(
      `INSERT INTO profiles (slug, scope) VALUES ('decision','system') RETURNING id`
    );
    const [wsDecision] = await q(
      `INSERT INTO profiles (slug, scope, workspace_id) VALUES ('decision','workspace',$1) RETURNING id`,
      [WS]
    );
    const [research] = await q(
      `INSERT INTO profiles (slug, scope) VALUES ('research','system') RETURNING id`
    );
    const ins = async (profileId: string, props: unknown, deleted = false) =>
      (
        await q(
          `INSERT INTO entities (profile_id, user_id, type, properties, deleted_at)
           VALUES ($1,$2,'x',$3::jsonb, ${deleted ? "now()" : "NULL"}) RETURNING id`,
          [profileId, USER, JSON.stringify(props)]
        )
      )[0].id as string;
    return {
      sql: makePgliteSql(db),
      q,
      ids: {
        moved: await ins(sysDecision.id, { title: "a", rationale: ["x", "y"] }),
        conflict: await ins(wsDecision.id, {
          rationale: "SRC",
          decisionRationale: "TGT",
        }),
        deleted: await ins(sysDecision.id, { rationale: "gone" }, true),
        other: await ins(research.id, { rationale: "R" }),
        noKey: await ins(sysDecision.id, { title: "b" }),
      },
    };
  }

  const props = async (
    q: (t: string, p?: unknown[]) => Promise<any[]>,
    id: string
  ) =>
    (await q(`SELECT properties FROM entities WHERE id = $1`, [id]))[0]
      .properties;

  it("moves the key when the target is absent, keepTarget keeps the target on conflict, always strips the source", async () => {
    const { sql, q, ids } = await pod();
    const summary = await runConversions(sql, manifestOf(opOf("keepTarget")), {
      dryRun: false,
      destructiveTail: false,
    });
    expect(
      summary.results[0].error ?? null,
      summary.results[0].error ?? ""
    ).toBeNull();
    expect(summary.results[0].status).toBe("applied");
    expect(summary.results[0].counts).toEqual({
      entitiesKeyRenamed: 2,
      entitiesKeyConflicts: 1,
    });

    expect(await props(q, ids.moved)).toEqual({
      title: "a",
      decisionRationale: ["x", "y"], // verbatim JSON, not text
    });
    expect(await props(q, ids.conflict)).toEqual({ decisionRationale: "TGT" });
    // Untouched: soft-deleted, other slug with the same key, entity without it.
    expect(await props(q, ids.deleted)).toEqual({ rationale: "gone" });
    expect(await props(q, ids.other)).toEqual({ rationale: "R" });
    expect(await props(q, ids.noKey)).toEqual({ title: "b" });
  });

  it("keepSource overwrites the target with the source value on conflict", async () => {
    const { sql, q, ids } = await pod();
    const summary = await runConversions(sql, manifestOf(opOf("keepSource")), {
      dryRun: false,
      destructiveTail: false,
    });
    expect(summary.results[0].counts.entitiesKeyConflicts).toBe(1);
    expect(await props(q, ids.conflict)).toEqual({ decisionRationale: "SRC" });
  });

  it("is idempotent — a second real run (ledger cleared) is a noop and changes nothing", async () => {
    const { sql, q, ids } = await pod();
    await runConversions(sql, manifestOf(opOf("keepTarget")), {
      dryRun: false,
      destructiveTail: false,
    });
    const snapshot = await q(`SELECT id, properties FROM entities ORDER BY id`);
    await q(`DELETE FROM "_conversions"`);
    const again = await runConversions(sql, manifestOf(opOf("keepTarget")), {
      dryRun: false,
      destructiveTail: false,
    });
    expect(again.results[0].status).toBe("noop");
    expect(await q(`SELECT id, properties FROM entities ORDER BY id`)).toEqual(
      snapshot
    );
    expect(await props(q, ids.moved)).toEqual({
      title: "a",
      decisionRationale: ["x", "y"],
    });
  });

  it("dry-run counts equal the apply counts and write nothing", async () => {
    const dryPod = await pod();
    const dry = await runConversions(
      dryPod.sql,
      manifestOf(opOf("keepTarget")),
      {
        dryRun: true,
        destructiveTail: false,
      }
    );
    expect(dry.results[0].status).toBe("dry-run");
    expect(await props(dryPod.q, dryPod.ids.moved)).toEqual({
      title: "a",
      rationale: ["x", "y"],
    });
    expect(await dryPod.q(`SELECT op_key FROM "_conversions"`)).toEqual([]);

    const applyPod = await pod();
    const applied = await runConversions(
      applyPod.sql,
      manifestOf(opOf("keepTarget")),
      { dryRun: false, destructiveTail: false }
    );
    expect(applied.results[0].counts.entitiesKeyRenamed).toBe(2);
    expect(dry.results[0].counts).toEqual(applied.results[0].counts);
  });

  it("deferAtBoot: the boot caller (skipDeferred) defers it — not applied, not ledgered", async () => {
    const { sql, q, ids } = await pod();
    const summary = await runConversions(
      sql,
      manifestOf({ ...opOf("keepTarget"), deferAtBoot: true }),
      {
        dryRun: false,
        destructiveTail: false,
        deferDestructive: true,
        skipDeferred: true,
      }
    );
    expect(summary.results[0].status).toBe("deferred");
    expect(summary.results[0].deferReason).toBe("defer-at-boot");
    expect(await props(q, ids.moved)).toEqual({
      title: "a",
      rationale: ["x", "y"],
    });
    expect(await q(`SELECT op_key FROM "_conversions"`)).toEqual([]);
  });
});
