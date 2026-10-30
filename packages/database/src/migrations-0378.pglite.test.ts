/**
 * REAL-POSTGRES (PGlite) test for migration 0378 — rows of a lifecycle kind
 * (or role) born with no status get the declaring link's `default_value`
 * (finding 8c869510):
 *  - a NULL-status row with no projection gets the initial status, its
 *    category, and the projection, in one write;
 *  - a kind inheriting the declaration is filled too (nearest declaration);
 *  - a role facet is filled the same way;
 *  - untouched: a row with a status, a row whose projection holds any value,
 *    a deleted row, a kind with no declared initial, a default that names no
 *    categorized option, a done/lost or person-only initial;
 *  - no transition is written, `updated_at` is kept;
 *  - idempotent (applied twice).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { makeLifecyclePglite } from "./services/lifecycle/__tests__/lifecycle-pglite.js";
import { declareLifecycle } from "./services/lifecycle/declare-lifecycle.js";
import { buildStoredConstraints } from "./utils/property-enum.js";
import * as schema from "./schema/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../migrations/0378_lifecycle_initial_status_backfill.sql"),
  "utf8"
);

const OPTIONS = [
  { key: "todo", category: "open" },
  { key: "doing", category: "active" },
  { key: "done", category: "done" },
  { key: "signed", category: "active", humanOnly: true },
];
const LONG_AGO = new Date("2026-10-01T00:00:00Z");

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;

let db: any;
const ids: Record<string, string> = {};

async function profile(
  slug: string,
  kind: "kind" | "role",
  prop: string | null,
  defaultValue?: unknown,
  parentProfileId?: string
) {
  const [p] = await db
    .insert(schema.profiles)
    .values({
      slug,
      displayName: slug,
      profileKind: kind,
      scope: "system",
      parentProfileId,
    })
    .returning();
  if (prop) {
    const [d] = await db
      .insert(schema.propertyDefs)
      .values({
        slug: prop,
        valueType: "string",
        profileId: p.id,
        constraints: buildStoredConstraints({ enumOptions: OPTIONS }),
      })
      .returning();
    await db
      .insert(schema.profileProperties)
      .values({ profileId: p.id, propertyDefId: d.id, defaultValue });
    await declareLifecycle(db, { profileId: p.id, propertySlug: prop });
  }
  return p.id as string;
}

async function entity(
  name: string,
  profileId: string,
  row: {
    status?: string;
    properties?: Record<string, unknown>;
    deletedAt?: Date;
  } = {}
) {
  const [e] = await db
    .insert(schema.entities)
    .values({
      userId: "u1",
      type: "thing",
      profileId,
      title: name,
      properties: row.properties ?? { priority: "low" },
      status: row.status ?? null,
      statusCategory: row.status ? "active" : null,
      deletedAt: row.deletedAt ?? null,
      updatedAt: LONG_AGO,
    })
    .returning();
  ids[name] = e.id;
}

const read = async (name: string) => {
  const [e] = await db
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.id, ids[name]));
  return e;
};

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
  const task = await profile("task", "kind", "status", "todo");
  const subtask = await profile("subtask", "kind", null, undefined, task);
  const errand = await profile("errand", "kind", "errandStatus");
  const stray = await profile("stray", "kind", "strayStatus", "someday");
  const lead = await profile("lead", "role", "leadStage", "todo");
  const verdict = await profile("verdict", "kind", "verdictStatus", "done");
  const contract = await profile(
    "contract",
    "kind",
    "contractStatus",
    "signed"
  );

  await entity("born-null", task);
  await entity("inherits", subtask);
  await entity("has-status", task, {
    status: "doing",
    properties: { status: "doing" },
  });
  await entity("odd-projection", task, { properties: { status: "weird" } });
  await entity("deleted", task, { deletedAt: LONG_AGO });
  await entity("no-initial", errand);
  await entity("stray-default", stray);
  await entity("terminal-initial", verdict);
  await entity("person-only-initial", contract);

  const [person] = await db
    .insert(schema.entities)
    .values({ userId: "u1", type: "person" })
    .returning();
  const [facet] = await db
    .insert(schema.entityFacets)
    .values({ entityId: person.id, profileId: lead, userId: "u1" })
    .returning();
  ids.facet = facet.id;

  await h.pg.exec(MIGRATION);
  await h.pg.exec(MIGRATION); // idempotent
}, 120_000);
afterAll(async () => h?.pg.close());

describe("0378 lifecycle initial status backfill", () => {
  it("fills a NULL-status row: status, category and projection together", async () => {
    const e = await read("born-null");
    expect(e.status).toBe("todo");
    expect(e.statusCategory).toBe("open");
    expect(e.properties).toEqual({ priority: "low", status: "todo" });
    expect(e.updatedAt).toEqual(LONG_AGO);
  });

  it("fills a kind that inherits the declaration", async () => {
    const e = await read("inherits");
    expect(e.status).toBe("todo");
    expect(e.properties).toMatchObject({ status: "todo" });
  });

  it("fills a role facet from the role's declared initial", async () => {
    const [f] = await db
      .select()
      .from(schema.entityFacets)
      .where(eq(schema.entityFacets.id, ids.facet));
    expect(f.status).toBe("todo");
    expect(f.statusCategory).toBe("open");
    expect(f.properties).toMatchObject({ leadStage: "todo" });
  });

  it("leaves rows that hold a value, deleted rows, and kinds with no valid initial", async () => {
    expect((await read("has-status")).status).toBe("doing");
    const odd = await read("odd-projection");
    expect(odd.status).toBeNull();
    expect(odd.properties).toEqual({ status: "weird" });
    expect((await read("deleted")).status).toBeNull();
    const none = await read("no-initial");
    expect(none.status).toBeNull();
    expect(none.properties).toEqual({ priority: "low" });
    expect((await read("stray-default")).status).toBeNull();
  });

  it("leaves a done/lost or person-only initial to a person", async () => {
    expect((await read("terminal-initial")).status).toBeNull();
    expect((await read("person-only-initial")).status).toBeNull();
  });

  it("writes no transition", async () => {
    const rows = await db.select().from(schema.lifecycleTransitionOutbox);
    expect(rows).toHaveLength(0);
  });
});
