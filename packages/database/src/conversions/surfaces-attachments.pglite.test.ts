/**
 * REAL-POSTGRES (PGlite) test for the Surfaces P3 conversions
 * (`p3.surfaces.*`, `foldAnchorsIntoAttachments`), driven through the REAL
 * manifest entries and `runConversions`. Every legacy per-object UI anchor
 * becomes ONE `attaches` link; what cannot move is left and counted.
 *
 * Each fixture row rules a wrong rule out:
 *   - entity-renderer: e1's cell override → a new cell instance in its space,
 *     attached in slot `detail`; e2's override has no space → kept, counted
 *     (rules out "invent a space"); e3 deleted → untouched.
 *   - renderer-binding: a playbook's per-object cell binding → a cell
 *     instance + edge; its view binding → the view itself; a VIEW's own
 *     binding → kept (a view is no anchor kind); a revoked one → nothing;
 *     a KIND binding (no subject_id) → nothing (renders stay kind-level).
 *   - entity-bento: e1's bento → that view; a dangling bento id → kept.
 *   - cell-relation: c1 → e1 attached; two relations naming the same pair →
 *     ONE edge.
 * Then: the legacy values are still where they were (additive), and a second
 * run is skipped by the ledger and writes nothing (idempotent).
 * Counts are asserted before (dry run) and after (apply): they match.
 * DDL: the sibling convention, plus ATTACHMENT_FOLD_TEST_SCHEMA.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LIFECYCLE_PROJECTION_TEST_SCHEMA } from "./lifecycle-projection-test-schema.js";
import { ATTACHMENT_FOLD_TEST_SCHEMA } from "./attachment-fold-test-schema.js";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { runConversions } from "./engine.js";
import type { RunOptions, RunSummary } from "./engine.js";
import { CONVERSION_MANIFEST } from "./manifest.js";
import { selectManifestOps } from "./select.js";

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
  is_active boolean DEFAULT true
);
`;

const KEYS = [
  "p3.surfaces.entity-renderer",
  "p3.surfaces.renderer-binding",
  "p3.surfaces.entity-bento",
  "p3.surfaces.cell-relation",
];
const WS = "6eb9e938-8a0b-44bb-b4f1-f37b0296308b";
const USER = "user-1";
const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const E3 = "33333333-3333-4333-8333-333333333333";
const PB = "44444444-4444-4444-8444-444444444444";
const V_BENTO = "55555555-5555-4555-8555-555555555555";
const V_PB = "66666666-6666-4666-8666-666666666666";
const V_OTHER = "77777777-7777-4777-8777-777777777777";
const C1 = "88888888-8888-4888-8888-888888888888";

let db: PGlite;
let sql: Sql;
const q = async (text: string, params: unknown[] = []) =>
  (await db.query(text, params)).rows as any[];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    SCHEMA + LIFECYCLE_PROJECTION_TEST_SCHEMA + ATTACHMENT_FOLD_TEST_SCHEMA
  );
  sql = makePgliteSql(db);
  const cell = (cellKey: string, props?: object) =>
    JSON.stringify({ renderer: { kind: "cell", cellKey, ...(props ? { props } : {}) } });
  await q(
    `INSERT INTO entities (id, user_id, workspace_id, system_data, deleted_at) VALUES
      ($1, $4, $5, $6::jsonb, NULL),
      ($2, $4, NULL, $7::jsonb, NULL),
      ($3, $4, $5, $8::jsonb, now())`,
    [
      E1, E2, E3, USER, WS,
      JSON.stringify({
        ...JSON.parse(cell("deal-cockpit", { compact: true })),
        bentoViewId: V_BENTO,
        viewMode: "bento",
      }),
      JSON.stringify({
        ...JSON.parse(cell("person-card")),
        bentoViewId: "99999999-9999-4999-8999-999999999999",
      }),
      cell("ghost"),
    ]
  );
  await q(`INSERT INTO views (id) VALUES ($1), ($2), ($3)`, [V_BENTO, V_PB, V_OTHER]);
  await q(`INSERT INTO playbooks (id, workspace_id) VALUES ($1, $2)`, [PB, WS]);
  await q(
    `INSERT INTO renderer_bindings (scope_kind, workspace_id, subject_kind, subject_id, content_kind, ref, created_by, revoked_at) VALUES
      ('pod', NULL, 'playbook', $1, 'entity-detail', $2::jsonb, $5, NULL),
      ('user', NULL, 'playbook', $1, 'entity-card', $3::jsonb, $5, NULL),
      ('pod', NULL, 'view', $4, 'entity-detail', $2::jsonb, $5, NULL),
      ('pod', NULL, 'playbook', $1, 'entity-profile', $2::jsonb, $5, now()),
      ('pod', NULL, 'task', NULL, 'entity-card', $2::jsonb, $5, NULL)`,
    [
      PB,
      JSON.stringify({ kind: "cell", cellKey: "playbook-cockpit" }),
      JSON.stringify({ kind: "view", viewId: V_PB }),
      V_OTHER,
      USER,
    ]
  );
  await q(
    `INSERT INTO cell_instances (id, workspace_id, user_id, cell_type) VALUES ($1, $2, $3, 'note')`,
    [C1, WS, USER]
  );
  await q(
    `INSERT INTO relations (user_id, source_kind, source_cell_id, target_entity_id) VALUES
      ($1, 'cell', $2, $3), ($1, 'cell', $2, $3)`,
    [USER, C1, E1]
  );
}, 120_000);
afterAll(async () => {
  await db?.close();
});

const errorsOf = (s: RunSummary) =>
  s.results.filter((r) => r.error).map((r) => `${r.opKey}: ${r.error}`);
const run = (options: RunOptions) =>
  runConversions(sql, selectManifestOps(CONVERSION_MANIFEST, KEYS), options);
const countsOf = (s: RunSummary) =>
  Object.fromEntries(s.results.map((r) => [r.opKey, r.counts]));
const edges = () =>
  q(
    `SELECT from_type, from_id, to_type, to_id, metadata FROM links WHERE link_type = 'attaches' ORDER BY from_id, to_type, to_id`
  );

const EXPECTED_COUNTS = {
  "p3.surfaces.entity-renderer": {
    attachmentsCreated: 1,
    cellInstancesCreated: 1,
    anchorsKept: 1,
  },
  "p3.surfaces.renderer-binding": {
    attachmentsCreated: 2,
    cellInstancesCreated: 1,
    anchorsKept: 1,
  },
  "p3.surfaces.entity-bento": { attachmentsCreated: 1, anchorsKept: 1 },
  "p3.surfaces.cell-relation": { attachmentsCreated: 1 },
};

describe("p3.surfaces.* (foldAnchorsIntoAttachments)", () => {
  it("moves every legacy anchor onto `attaches`, counts what stays, matches the dry run", async () => {
    const preview = await run({ dryRun: true, destructiveTail: false });
    expect(errorsOf(preview), errorsOf(preview).join("\n")).toEqual([]);
    expect(countsOf(preview)).toMatchObject(EXPECTED_COUNTS);
    // The dry run wrote nothing.
    expect(await edges()).toEqual([]);

    const applied = await run({ dryRun: false, destructiveTail: false });
    expect(errorsOf(applied), errorsOf(applied).join("\n")).toEqual([]);
    expect(countsOf(applied)).toMatchObject(EXPECTED_COUNTS);

    const all = await edges();
    expect(all).toHaveLength(5);
    // e1's cell look: a NEW instance in e1's space, slot detail.
    const look = all.find(
      (e) => e.from_id === E1 && e.metadata.migratedFrom === "entity-renderer"
    );
    expect(look).toMatchObject({ from_type: "entity", to_type: "cell_instance" });
    expect(look.metadata.slot).toBe("detail");
    const [made] = await q(
      `SELECT workspace_id, user_id, cell_type, config FROM cell_instances WHERE id = $1`,
      [look.to_id]
    );
    expect(made).toEqual({
      workspace_id: WS,
      user_id: USER,
      cell_type: "deal-cockpit",
      config: { compact: true },
    });
    // e1's bento and its linked cell: the same view / instance, no slot.
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from_id: E1, to_type: "view", to_id: V_BENTO }),
        expect.objectContaining({ from_id: E1, to_type: "cell_instance", to_id: C1 }),
        expect.objectContaining({ from_type: "playbook", from_id: PB, to_type: "view", to_id: V_PB }),
        expect.objectContaining({ from_type: "playbook", from_id: PB, to_type: "cell_instance" }),
      ])
    );
    // Nothing for the deleted entity, the space-less override, the view's own
    // binding, the revoked binding or the kind binding.
    expect(all.some((e) => e.from_id === E2 || e.from_id === E3)).toBe(false);
    expect(all.some((e) => e.from_id === V_OTHER)).toBe(false);
    // Positions order each anchor's surfaces.
    const e1Positions = all
      .filter((e) => e.from_id === E1)
      .map((e) => e.metadata.position)
      .sort();
    expect(new Set(e1Positions).size).toBe(3);

    // Additive: the legacy values are still there for clients that read them.
    const [e1] = await q(`SELECT system_data FROM entities WHERE id = $1`, [E1]);
    expect(e1.system_data.renderer.cellKey).toBe("deal-cockpit");
    expect(e1.system_data.bentoViewId).toBe(V_BENTO);

    // Idempotent: the ledger skips a second run; nothing more is written.
    const again = await run({ dryRun: false, destructiveTail: false });
    expect(again.results.map((r) => r.status)).toEqual(
      KEYS.map(() => "skipped")
    );
    expect(await edges()).toHaveLength(5);
  });
});
