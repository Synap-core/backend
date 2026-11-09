/**
 * The two status-first heals through the REAL engine on PGlite:
 *  - `fillFacetInitialStatus`: a status-less facet of a role with a lifecycle
 *    gets the initial status (column, category, mirror); a facet that has a
 *    status, a terminal initial, or no lifecycle is left alone.
 *  - `deriveLifecycleLists`: a lifecycle def's stale `uiHints.enumValues` and
 *    `constraints.defaultValue` are rewritten from `enumOptions` + the link
 *    default; a def that stored neither is not given one.
 * Both: dry run writes nothing; a second run changes nothing.
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

const FILL = "sf1.lifecycle.fill-facet-initial-status";
const DERIVE = "sf1.lifecycle.derive-option-lists";
const ops = (k: string) => selectManifestOps(CONVERSION_MANIFEST, [k]);
const OPERATOR: RunOptions = { dryRun: false, destructiveTail: false };
const DRY: RunOptions = { dryRun: true, destructiveTail: false };

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;
let sql: Sql;
let nullLead: string;
let movedLead: string;
let nullPact: string;
let nullPlain: string;
let leadDef: string;
let plainDef: string;

beforeAll(async () => {
  h = await makeLifecyclePglite();
  sql = makePgliteSql(h.pg);
  const db = h.db as any;
  const mkRole = async (
    slug: string,
    prop: string,
    options: unknown[],
    initial: string | null,
    extra: { uiHints?: unknown; constraints?: Record<string, unknown> } = {}
  ) => {
    const [p] = await db
      .insert(schema.profiles)
      .values({ slug, displayName: slug, profileKind: "role", scope: "system" })
      .returning();
    const [d] = await db
      .insert(schema.propertyDefs)
      .values({
        slug: prop,
        valueType: "string",
        profileId: p.id,
        constraints: {
          ...buildStoredConstraints({ enumOptions: options }),
          ...(extra.constraints ?? {}),
        },
        ...(extra.uiHints ? { uiHints: extra.uiHints } : {}),
      })
      .returning();
    await db.insert(schema.profileProperties).values({
      profileId: p.id,
      propertyDefId: d.id,
      isLifecycle: true,
      defaultValue: initial,
    });
    return { profileId: p.id as string, defId: d.id as string };
  };
  const lead = await mkRole(
    "lead",
    "leadStage",
    [
      { key: "new", category: "open" },
      { key: "engaged", category: "active" },
      { key: "prospect" }, // uncategorised: never offered
    ],
    "new",
    {
      uiHints: { enumValues: ["prospect", "qualified"] },
      constraints: { defaultValue: "prospect" },
    }
  );
  leadDef = lead.defId;
  const pact = await mkRole(
    "pact",
    "pactStage",
    [
      { key: "open", category: "open" },
      { key: "signed", category: "done" },
    ],
    "signed"
  );
  const plain = await mkRole(
    "plain",
    "plainStage",
    [{ key: "a", category: "open" }],
    "a"
  );
  plainDef = plain.defId;
  const person = (
    await db.insert(schema.entities).values({ userId: "u1", type: "person" }).returning()
  )[0].id as string;
  const facet = async (profileId: string, extra: object = {}) =>
    (
      await db
        .insert(schema.entityFacets)
        .values({ entityId: person, profileId, userId: "u1", properties: {}, ...extra })
        .returning()
    )[0].id as string;
  nullLead = await facet(lead.profileId);
  movedLead = await facet(lead.profileId, {
    status: "engaged",
    statusCategory: "active",
    properties: { leadStage: "engaged" },
  });
  nullPact = await facet(pact.profileId);
  nullPlain = await facet(plain.profileId);
}, 120_000);
afterAll(async () => h?.pg.close());

const facetRow = async (id: string) =>
  (
    await h.pg.query(
      "select status, status_category, properties from entity_facets where id = $1",
      [id]
    )
  ).rows[0];
const defRow = async (id: string) =>
  (await h.pg.query("select ui_hints, constraints from property_defs where id = $1", [id]))
    .rows[0];

describe("fillFacetInitialStatus", () => {
  it("dry run counts and writes nothing", async () => {
    const r = await runConversions(sql, ops(FILL), DRY);
    expect(r.results[0]).toMatchObject({
      status: "dry-run",
      counts: { facetsInitialStatusFilled: 2 },
    });
    expect((await facetRow(nullLead)).status).toBeNull();
  });

  it("fills a status-less facet with the initial status; leaves the rest", async () => {
    await runConversions(sql, ops(FILL), OPERATOR);
    expect(await facetRow(nullLead)).toEqual({
      status: "new",
      status_category: "open",
      properties: { leadStage: "new" },
    });
    expect((await facetRow(movedLead)).status).toBe("engaged");
    // terminal initial: not filled
    expect((await facetRow(nullPact)).status).toBeNull();
    // the plain role's initial `a` IS non-terminal: filled
    expect((await facetRow(nullPlain)).status).toBe("a");
  });

  it("a second run changes nothing", async () => {
    const again = await runConversions(sql, ops(FILL), OPERATOR);
    expect(again.results[0]?.status).not.toBe("applied");
  });
});

describe("deriveLifecycleLists", () => {
  it("rewrites a stale stored list and default from the one declaration", async () => {
    const dry = await runConversions(sql, ops(DERIVE), DRY);
    expect(dry.results[0]).toMatchObject({ counts: { lifecycleListsHealed: 1 } });
    expect((await defRow(leadDef)).ui_hints.enumValues).toEqual(["prospect", "qualified"]);

    await runConversions(sql, ops(DERIVE), OPERATOR);
    const lead = await defRow(leadDef);
    expect(lead.ui_hints.enumValues).toEqual(["new", "engaged"]);
    expect(lead.constraints.defaultValue).toBe("new");
    // the declaration itself is untouched
    expect(lead.constraints.enumOptions).toHaveLength(3);
    // a def that stored neither is not given one
    const plain = await defRow(plainDef);
    expect(plain.ui_hints?.enumValues).toBeUndefined();
    expect(plain.constraints.defaultValue).toBeUndefined();
  });

  it("a second run changes nothing", async () => {
    const again = await runConversions(sql, ops(DERIVE), OPERATOR);
    expect(again.results[0]?.status).not.toBe("applied");
  });
});
