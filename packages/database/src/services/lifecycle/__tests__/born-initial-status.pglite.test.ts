/**
 * A row whose kind (or role) declares a lifecycle is BORN with a status even
 * when its creator names none: the declaring link's `default_value` is the
 * initial status (PGlite, through the real repository doors).
 *
 * MEASURED DEFECT (finding 8c869510, live 2026-10-29): agent-created tasks —
 * capture graphs and direct creates that sent only `priority` — landed with
 * `status` NULL, in the "no status" column, although `task` declares `todo` as
 * its status default. Only `profiles.default_values` was ever folded in; the
 * lifecycle link's default was not read by any create door.
 *
 * Rows that rule out a wrong rule:
 *  - no status sent ⇒ the declared initial, column + category + projection;
 *  - a status sent ⇒ kept (the initial never overrides the creator);
 *  - no declared initial ⇒ still NULL (nothing is invented);
 *  - a default that is not a declared option ⇒ NULL (never a stray value);
 *  - a role attached with no status ⇒ the role's declared initial;
 *  - a birth writes NO transition (it has no "from").
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeLifecyclePglite } from "./lifecycle-pglite.js";
import { declareLifecycle } from "../declare-lifecycle.js";
import { FacetRepository } from "../../../repositories/facet-repository.js";
import { EntityRepository } from "../../../repositories/entity-repository.js";
import { buildStoredConstraints } from "../../../utils/property-enum.js";
import * as schema from "../../../schema/index.js";

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;

let db: any;
const events = { append: async () => ({ id: "ev" }) } as never;

const CHORE_OPTIONS = [
  { key: "todo", category: "open" },
  { key: "doing", category: "active" },
  { key: "done", category: "done" },
];

async function profile(
  slug: string,
  kind: "kind" | "role",
  prop: string,
  options: unknown[],
  defaultValue?: unknown
) {
  const [p] = await db
    .insert(schema.profiles)
    .values({ slug, displayName: slug, profileKind: kind, scope: "system" })
    .returning();
  const [d] = await db
    .insert(schema.propertyDefs)
    .values({
      slug: prop,
      valueType: "string",
      profileId: p.id,
      constraints: buildStoredConstraints({ enumOptions: options }),
    })
    .returning();
  await db
    .insert(schema.profileProperties)
    .values({ profileId: p.id, propertyDefId: d.id, defaultValue });
  await declareLifecycle(db, { profileId: p.id, propertySlug: prop });
  return p.id as string;
}

const create = (profileSlug: string, properties: Record<string, unknown>) =>
  new EntityRepository(db, events).create(
    {
      profileSlug,
      title: `a ${profileSlug}`,
      properties,
      skipEvent: true,
    } as never,
    "u1"
  ) as Promise<{
    status: string | null;
    statusCategory: string | null;
    properties: Record<string, unknown>;
  }>;

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
  await profile("chore", "kind", "choreStatus", CHORE_OPTIONS, "todo");
  await profile("errand", "kind", "errandStatus", CHORE_OPTIONS);
  await profile("stray", "kind", "strayStatus", CHORE_OPTIONS, "someday");
  await profile(
    "lead",
    "role",
    "leadStage",
    [
      { key: "new", category: "open" },
      { key: "qualified", category: "done" },
    ],
    "new"
  );
}, 120_000);
afterAll(async () => h?.pg.close());

describe("a lifecycle row is born with its declared initial status", () => {
  it("no status sent: the declared initial, with its category and projection", async () => {
    const e = await create("chore", { priority: "low" });
    expect(e.status).toBe("todo");
    expect(e.statusCategory).toBe("open");
    expect(e.properties).toMatchObject({ choreStatus: "todo" });
  });

  it("a status sent is kept", async () => {
    const e = await create("chore", { choreStatus: "doing" });
    expect(e.status).toBe("doing");
    expect(e.statusCategory).toBe("active");
    expect(e.properties).toMatchObject({ choreStatus: "doing" });
  });

  it("no declared initial: still no status", async () => {
    const e = await create("errand", {});
    expect(e.status).toBeNull();
    expect(e.statusCategory).toBeNull();
    expect(e.properties).not.toHaveProperty("errandStatus");
  });

  it("a default that names no declared option is no initial status", async () => {
    const e = await create("stray", {});
    expect(e.status).toBeNull();
    expect(e.properties).not.toHaveProperty("strayStatus");
  });

  it("a role attached with no status gets the role's declared initial", async () => {
    const [person] = await db
      .insert(schema.entities)
      .values({ userId: "u1", type: "person" })
      .returning();
    const f = await new FacetRepository(db, events).attach(
      {
        entityId: person.id,
        profileSlug: "lead",
        properties: {},
        skipValidation: true,
        skipEvent: true,
      },
      "u1"
    );
    expect(f.status).toBe("new");
    expect(f.statusCategory).toBe("open");
    expect(f.properties).toEqual({ leadStage: "new" });
  });

  it("a birth writes no transition", async () => {
    const rows = await db.select().from(schema.lifecycleTransitionOutbox);
    expect(rows).toHaveLength(0);
  });
});
