/**
 * The repository FLOOR of the one door (PGlite):
 *  - a facet BORN with a lifecycle value gets its columns (status + category)
 *    and the read projection agrees;
 *  - a generic facet update that would MOVE the role's status — as `status` or
 *    as the property — is refused; re-sending the current value passes;
 *  - a generic entity update that would move the kind's status is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeLifecyclePglite } from "./lifecycle-pglite.js";
import { declareLifecycle } from "../declare-lifecycle.js";
import { LifecycleWriteOutsideDoorError } from "../lifecycle-columns.js";
import { FacetRepository } from "../../../repositories/facet-repository.js";
import { EntityRepository } from "../../../repositories/entity-repository.js";
import { buildStoredConstraints } from "../../../utils/property-enum.js";
import * as schema from "../../../schema/index.js";

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
const events = { append: async () => ({ id: "ev" }) } as never;
let personId: string;
let dealProfile: string;

async function profile(
  slug: string,
  kind: "kind" | "role",
  prop: string,
  options: unknown[]
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
    .values({ profileId: p.id, propertyDefId: d.id });
  await declareLifecycle(db, { profileId: p.id, propertySlug: prop });
  return p.id as string;
}

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
  await profile("lead", "role", "leadStage", [
    { key: "new", category: "open" },
    { key: "qualified", category: "done" },
  ]);
  dealProfile = await profile("deal", "kind", "commercialStage", [
    { key: "draft", category: "open" },
    { key: "won", category: "done" },
  ]);
  const [person] = await db
    .insert(schema.entities)
    .values({ userId: "u1", type: "person" })
    .returning();
  personId = person.id;
}, 120_000);
afterAll(async () => h?.pg.close());

describe("repository floor", () => {
  it("a facet is born with its lifecycle columns and an agreeing projection", async () => {
    const repo = new FacetRepository(db, events);
    const f = await repo.attach(
      {
        entityId: personId,
        profileSlug: "lead",
        properties: { leadStage: "new" },
        skipValidation: true,
        skipEvent: true,
      },
      "u1"
    );
    expect(f.status).toBe("new");
    expect(f.statusCategory).toBe("open");
    expect(f.properties).toEqual({ leadStage: "new" });

    // a generic update that MOVES the status is refused, both spellings
    await expect(
      repo.update(f.id, { status: "qualified" }, "u1")
    ).rejects.toBeInstanceOf(LifecycleWriteOutsideDoorError);
    await expect(
      repo.update(f.id, { properties: { leadStage: "qualified" } }, "u1")
    ).rejects.toBeInstanceOf(LifecycleWriteOutsideDoorError);
    // re-sending the current value passes
    const same = await repo.update(
      f.id,
      { properties: { leadStage: "new" } },
      "u1"
    );
    expect(same.status).toBe("new");
  });

  it("a generic entity update that moves the kind's status is refused", async () => {
    const [deal] = await db
      .insert(schema.entities)
      .values({
        userId: "u1",
        type: "deal",
        profileId: dealProfile,
        status: "draft",
        statusCategory: "open",
        properties: { commercialStage: "draft" },
      })
      .returning();
    const repo = new EntityRepository(db, events);
    await expect(
      repo.update(deal.id, { properties: { commercialStage: "won" } }, "u1")
    ).rejects.toBeInstanceOf(LifecycleWriteOutsideDoorError);
    await expect(
      repo.update(deal.id, { deleteProperties: ["commercialStage"] }, "u1")
    ).rejects.toBeInstanceOf(LifecycleWriteOutsideDoorError);
  });
});
