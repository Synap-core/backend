/**
 * A facet BORN with no status starts in its role lifecycle's initial status
 * (status-first wave, doors audit 1bb7b083 bug 6), exactly as an entity birth
 * does: column, category and the `properties[<slug>]` mirror together. A
 * terminal or person-only initial is NOT filled (the birth rule). A
 * lens-collapsed re-attach never writes the lifecycle mirror without the column.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeLifecyclePglite } from "./lifecycle-pglite.js";
import { declareLifecycle } from "../declare-lifecycle.js";
import { setLifecycleInitialStatus } from "../lifecycle-def-guard.js";
import { FacetRepository } from "../../../repositories/facet-repository.js";
import { buildStoredConstraints } from "../../../utils/property-enum.js";
import * as schema from "../../../schema/index.js";

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;
let db: any;
const events = { append: async () => ({ id: "ev" }) } as never;
const personIds: string[] = [];

async function role(slug: string, prop: string, options: unknown[], initial: string) {
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
      constraints: buildStoredConstraints({ enumOptions: options }),
    })
    .returning();
  await db
    .insert(schema.profileProperties)
    .values({ profileId: p.id, propertyDefId: d.id });
  await declareLifecycle(db, { profileId: p.id, propertySlug: prop });
  await setLifecycleInitialStatus(db, { propertyDefId: d.id, initialStatus: initial });
}

async function person() {
  const [e] = await db
    .insert(schema.entities)
    .values({ userId: "u1", type: "person" })
    .returning();
  personIds.push(e.id);
  return e.id as string;
}

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
  await role(
    "lead",
    "leadStage",
    [
      { key: "new", category: "open" },
      { key: "engaged", category: "active" },
      { key: "converted", category: "done" },
    ],
    "new"
  );
  await role(
    "pact",
    "pactStage",
    [
      { key: "open", category: "open" },
      { key: "signed", category: "done" },
    ],
    "signed"
  );
}, 120_000);
afterAll(async () => h?.pg.close());

const attach = (entityId: string, profileSlug: string, extra: object = {}) =>
  new FacetRepository(db, events).attach(
    { entityId, profileSlug, properties: {}, skipValidation: true, skipEvent: true, ...extra },
    "u1"
  );

describe("facet birth fills the initial status", () => {
  it("a facet born with no status starts in the initial status, column and mirror together", async () => {
    const f = await attach(await person(), "lead");
    expect(f.status).toBe("new");
    expect(f.statusCategory).toBe("open");
    expect(f.properties).toEqual({ leadStage: "new" });
  });

  it("a status the creator names is kept (as `status` or as the property)", async () => {
    const a = await attach(await person(), "lead", { status: "engaged" });
    expect(a.status).toBe("engaged");
    expect(a.properties).toEqual({ leadStage: "engaged" });
    const b = await attach(await person(), "lead", { properties: { leadStage: "engaged" } });
    expect(b.status).toBe("engaged");
  });

  it("a terminal initial status is not filled: the facet stays unborn-status", async () => {
    const f = await attach(await person(), "pact");
    expect(f.status).toBeNull();
    expect(f.properties).toEqual({});
  });
});

describe("a lens-collapsed re-attach", () => {
  it("never writes the lifecycle mirror without the column", async () => {
    const f = await attach(await person(), "pact"); // status null
    const repo = new FacetRepository(db, events) as any;
    const out = await repo.fillMissingProperties(
      f,
      { pactStage: "open", note: "kept" },
      "u1",
      true,
      "pactStage"
    );
    expect(out.properties).toEqual({ note: "kept" });
    expect(out.status).toBeNull();
  });
});
