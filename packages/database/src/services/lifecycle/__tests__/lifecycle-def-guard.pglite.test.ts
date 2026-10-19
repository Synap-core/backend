/**
 * The lifecycle guard on a property def (review arch F1, backend F5):
 *  - the generic update may append categorised options and edit labels; it
 *    may not rename the key, remove / rename / recategorise an option, drop
 *    the categories with a bare `enum`, or empty the options;
 *  - the lifecycle door retires an option only with a remap, moves the rows,
 *    and re-projects the columns; a recategorise re-projects the category.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeLifecyclePglite } from "./lifecycle-pglite.js";
import { declareLifecycle } from "../declare-lifecycle.js";
import {
  changeLifecycleOptions,
  checkLifecycleDefUpdate,
  LifecycleDefChangeError,
} from "../lifecycle-def-guard.js";
import { buildStoredConstraints } from "../../../utils/property-enum.js";
import * as schema from "../../../schema/index.js";

const OPTIONS = [
  { key: "draft", category: "open" },
  { key: "negotiating", category: "active" },
  { key: "won", category: "done" },
];
const DEF = {
  slug: "commercialStage",
  valueType: "string",
  constraints: buildStoredConstraints({ enumOptions: OPTIONS }),
};
const refused = (input: Parameters<typeof checkLifecycleDefUpdate>[1]) => {
  try {
    checkLifecycleDefUpdate(DEF, input);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(LifecycleDefChangeError);
    return (e as LifecycleDefChangeError).reasons.join(" | ");
  }
};

describe("checkLifecycleDefUpdate — the generic door", () => {
  it("appends a categorised option and re-projects; a label edit changes no option", () => {
    const r = checkLifecycleDefUpdate(DEF, {
      constraints: {
        enumOptions: [...OPTIONS, { key: "lost", category: "lost" }],
      },
    });
    expect(r.optionsChanged).toBe(true);
    expect(r.constraints?.enum).toEqual([
      "draft",
      "negotiating",
      "won",
      "lost",
    ]);
    const label = checkLifecycleDefUpdate(DEF, {
      constraints: {
        enumOptions: OPTIONS.map((o) => ({ ...o, label: o.key.toUpperCase() })),
      },
    });
    expect(label.optionsChanged).toBe(false);
  });

  it("a bare enum write keeps every category (never drops them)", () => {
    const r = checkLifecycleDefUpdate(DEF, {
      constraints: { enum: ["draft", "negotiating", "won"] },
    });
    expect(r.constraints?.enumOptions).toEqual(OPTIONS);
  });

  it("refuses rename, removal, recategorise, an uncategorised append, emptying and a key rename", () => {
    expect(
      refused({
        constraints: {
          enumOptions: [
            OPTIONS[0],
            { key: "negotiation", category: "active" },
            OPTIONS[2],
          ],
        },
      })
    ).toMatch(/"negotiating" cannot be removed or renamed/);
    expect(
      refused({ constraints: { enumOptions: [OPTIONS[0], OPTIONS[2]] } })
    ).toMatch(/"negotiating" cannot be removed/);
    expect(
      refused({
        constraints: {
          enumOptions: [
            OPTIONS[0],
            { key: "negotiating", category: "paused" },
            OPTIONS[2],
          ],
        },
      })
    ).toMatch(/cannot move from active to paused/);
    expect(
      refused({ constraints: { enumOptions: [...OPTIONS, { key: "cold" }] } })
    ).toMatch(/"cold" needs a category/);
    expect(refused({ constraints: {} })).toMatch(/cannot be emptied/);
    expect(refused({ slug: "stage" })).toMatch(/cannot be renamed/);
  });
});

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;

let db: any;
let defId: string;
let profileId: string;

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
  const [p] = await db
    .insert(schema.profiles)
    .values({ slug: "deal", displayName: "deal", profileKind: "kind" })
    .returning();
  const [d] = await db
    .insert(schema.propertyDefs)
    .values({ ...DEF, profileId: p.id })
    .returning();
  await db
    .insert(schema.profileProperties)
    .values({ profileId: p.id, propertyDefId: d.id });
  await declareLifecycle(db, { profileId: p.id, propertySlug: DEF.slug });
  defId = d.id;
  profileId = p.id;
}, 120_000);
afterAll(async () => h?.pg.close());

async function deal(status: string) {
  const [e] = await db
    .insert(schema.entities)
    .values({
      userId: "u1",
      profileId,
      type: "deal",
      status,
      statusCategory: OPTIONS.find((o) => o.key === status)?.category,
      properties: { commercialStage: status },
    })
    .returning();
  return e.id as string;
}
const rowOf = async (id: string) =>
  (
    await db.select().from(schema.entities).where(eq(schema.entities.id, id))
  )[0];

describe("changeLifecycleOptions — the lifecycle door", () => {
  it("refuses to retire an option without a remap", async () => {
    const r = await changeLifecycleOptions(db, {
      propertyDefId: defId,
      options: [OPTIONS[0], OPTIONS[2]],
    });
    expect(r).toMatchObject({ status: "refused" });
    expect((r as { reason: string }).reason).toMatch(
      /"negotiating" is retired/
    );
  });

  it("retires with a remap: rows move, columns re-project, the def is rewritten", async () => {
    const e = await deal("negotiating");
    const r = await changeLifecycleOptions(db, {
      propertyDefId: defId,
      options: [
        OPTIONS[0],
        { key: "proposed", category: "active" },
        OPTIONS[2],
      ],
      remap: { negotiating: "proposed" },
    });
    expect(r).toEqual({ status: "changed", remapped: 1 });
    const row = await rowOf(e);
    expect(row.properties.commercialStage).toBe("proposed");
    expect(row.status).toBe("proposed");
    expect(row.statusCategory).toBe("active");
    const [def] = await db
      .select()
      .from(schema.propertyDefs)
      .where(eq(schema.propertyDefs.id, defId));
    expect(def.constraints.enum).toEqual(["draft", "proposed", "won"]);
  });

  it("recategorises and re-projects the category", async () => {
    const e = await deal("draft");
    const r = await changeLifecycleOptions(db, {
      propertyDefId: defId,
      options: [
        { key: "draft", category: "active" },
        { key: "proposed", category: "active" },
        OPTIONS[2],
      ],
    });
    expect(r.status).toBe("changed");
    expect((await rowOf(e)).statusCategory).toBe("active");
  });
});
