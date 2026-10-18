/**
 * The column FILL from the read projection (PGlite):
 *  - declaring a lifecycle fills the columns of rows that existed before, for
 *    the profile AND every profile inheriting from it, entities and facets;
 *  - a value no option declares keeps its status with NO category (never a
 *    guessed one); an empty value leaves the column NULL;
 *  - the boot statements (no root) are idempotent: a second pass changes 0 rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeLifecyclePglite } from "./lifecycle-pglite.js";
import { declareLifecycle } from "../declare-lifecycle.js";
import { lifecycleProjectionQueries } from "../project-lifecycle-columns.js";
import { buildStoredConstraints } from "../../../utils/property-enum.js";
import * as schema from "../../../schema/index.js";

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;

let db: any;

async function entity(profileId: string, props: Record<string, unknown>) {
  const [e] = await db
    .insert(schema.entities)
    .values({ userId: "u1", type: "x", profileId, properties: props })
    .returning();
  return e.id as string;
}
async function cols(id: string) {
  const r = await h.pg.query<{
    status: string | null;
    status_category: string | null;
  }>(`select status, status_category from entities where id = $1`, [id]);
  return r.rows[0];
}

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
}, 120_000);
afterAll(async () => h?.pg.close());

describe("projectLifecycleColumns", () => {
  it("declaring fills existing rows (kind, child kind, facet); never guesses", async () => {
    const [deal] = await db
      .insert(schema.profiles)
      .values({ slug: "deal", displayName: "Deal" })
      .returning();
    const [bigDeal] = await db
      .insert(schema.profiles)
      .values({
        slug: "big-deal",
        displayName: "Big",
        parentProfileId: deal.id,
      })
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
    await db
      .insert(schema.profileProperties)
      .values({ profileId: deal.id, propertyDefId: d.id });

    const won = await entity(deal.id, { commercialStage: "won" });
    const odd = await entity(deal.id, { commercialStage: "legacy-x" });
    const empty = await entity(deal.id, { commercialStage: "" });
    const child = await entity(bigDeal.id, { commercialStage: "draft" });
    const [facet] = await db
      .insert(schema.entityFacets)
      .values({
        entityId: won,
        profileId: deal.id,
        userId: "u1",
        properties: { commercialStage: "draft" },
      })
      .returning();

    await declareLifecycle(db, {
      profileId: deal.id,
      propertySlug: "commercialStage",
    });

    expect(await cols(won)).toEqual({ status: "won", status_category: "done" });
    expect(await cols(odd)).toEqual({
      status: "legacy-x",
      status_category: null,
    });
    expect(await cols(empty)).toEqual({ status: null, status_category: null });
    expect(await cols(child)).toEqual({
      status: "draft",
      status_category: "open",
    });
    const f = await h.pg.query<{ status: string; status_category: string }>(
      `select status, status_category from entity_facets where id = $1`,
      [facet.id]
    );
    expect(f.rows[0]).toEqual({ status: "draft", status_category: "open" });

    // boot pass: idempotent (nothing left to change)
    for (const q of lifecycleProjectionQueries()) {
      const r = await h.pg.query(q.text, q.params as unknown[]);
      expect(r.rows, q.table).toEqual([]);
    }
  });
});
