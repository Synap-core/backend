/**
 * The `projectLifecycleColumns` conversion op (0319, work model L1/L2) through
 * the REAL engine on PGlite: the dry run reports what the apply would fill and
 * writes nothing; the apply fills status/status_category from the read
 * projection (an undeclared value keeps its status with no category); the
 * ledger then holds it, so a second boot does nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Sql } from "postgres";
import { runConversions } from "./engine.js";
import type { RunOptions } from "./engine.js";
import { CONVERSION_MANIFEST } from "./manifest.js";
import { selectManifestOps } from "./select.js";
import { makeLifecyclePglite } from "../services/lifecycle/__tests__/lifecycle-pglite.js";
import { buildStoredConstraints } from "../utils/property-enum.js";
import * as schema from "../schema/index.js";
import type { PGlite } from "@electric-sql/pglite";

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
  sql.unsafe = (text: string, params: unknown[] = []) => exec(text, params);
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

const OP_KEY = "w12.lifecycle.project-columns";
const ops = () => selectManifestOps(CONVERSION_MANIFEST, [OP_KEY]);
const OPERATOR: RunOptions = { dryRun: false, destructiveTail: false };
const DRY: RunOptions = { dryRun: true, destructiveTail: false };

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;
let sql: Sql;
let won: string;
let odd: string;

beforeAll(async () => {
  h = await makeLifecyclePglite();
  sql = makePgliteSql(h.pg);
  const db = h.db as any;
  const [deal] = await db
    .insert(schema.profiles)
    .values({ slug: "deal", displayName: "Deal" })
    .returning();
  const [d] = await db
    .insert(schema.propertyDefs)
    .values({
      slug: "commercialStage",
      valueType: "string",
      profileId: deal.id,
      constraints: buildStoredConstraints({
        enumOptions: [
          { key: "draft", category: "open" },
          { key: "won", category: "done" },
        ],
      }),
    })
    .returning();
  // Declared directly in the table (a pre-door pod): no fill happened yet.
  await db
    .insert(schema.profileProperties)
    .values({ profileId: deal.id, propertyDefId: d.id, isLifecycle: true });
  const mk = async (v: string) =>
    (
      await db
        .insert(schema.entities)
        .values({
          userId: "u1",
          type: "deal",
          profileId: deal.id,
          properties: { commercialStage: v },
        })
        .returning()
    )[0].id as string;
  won = await mk("won");
  odd = await mk("legacy-x");
}, 120_000);
afterAll(async () => h?.pg.close());

const cols = async (id: string) =>
  (
    await h.pg.query(
      "select status, status_category from entities where id = $1",
      [id]
    )
  ).rows[0];

describe("projectLifecycleColumns op", () => {
  it("dry run counts and writes nothing", async () => {
    const r = await runConversions(sql, ops(), DRY);
    expect(r.results[0]).toMatchObject({
      status: "dry-run",
      counts: { lifecycleColumnsProjected: 2, lifecycleUncategorized: 1 },
    });
    expect(await cols(won)).toEqual({ status: null, status_category: null });
  });

  it("apply fills from the projection, never guesses; a second run is a no-op", async () => {
    const r = await runConversions(sql, ops(), OPERATOR);
    expect(r.results[0]).toMatchObject({
      counts: { lifecycleColumnsProjected: 2, lifecycleUncategorized: 1 },
    });
    expect(await cols(won)).toEqual({ status: "won", status_category: "done" });
    expect(await cols(odd)).toEqual({
      status: "legacy-x",
      status_category: null,
    });
    const again = await runConversions(sql, ops(), OPERATOR);
    expect(again.results[0]?.status).not.toBe("applied");
  });
});
