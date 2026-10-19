/**
 * The lifecycle DECLARATION door + its ONE reader, on a real Postgres (PGlite):
 *  - the mapper derives `enum` from option objects (never two lists);
 *  - `withLifecycleOptions` folds profile-level options onto the property and
 *    refuses an authoring error;
 *  - `declareLifecycle` sets the link flag, is idempotent, refuses options
 *    without a category and a lifecycle that shadows an ancestor's;
 *  - `getEffectiveLifecycle` reads the nearest declaration and reports
 *    uncategorized options instead of guessing them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeLifecyclePglite } from "./lifecycle-pglite.js";
import {
  declareLifecycle,
  withLifecycleOptions,
  LifecycleDeclarationError,
} from "../declare-lifecycle.js";
import {
  buildStoredConstraints,
  readStoredEnumOptions,
} from "../../../utils/property-enum.js";
import { ProfileResolutionService } from "../../profile-resolution-service.js";
import * as schema from "../../../schema/index.js";

const DEAL_OPTIONS = [
  { key: "draft", category: "open" },
  { key: "negotiating", category: "active", label: "Negotiating" },
  { key: "won", category: "done", humanOnly: true },
  { key: "lost", category: "lost" },
];

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;

let db: any;

async function profile(slug: string, parentProfileId?: string) {
  const [p] = await db
    .insert(schema.profiles)
    .values({
      slug,
      displayName: slug,
      parentProfileId: parentProfileId ?? null,
    })
    .returning();
  return p.id as string;
}
async function prop(
  profileId: string,
  slug: string,
  constraints: Record<string, unknown>
) {
  const [d] = await db
    .insert(schema.propertyDefs)
    .values({ slug, valueType: "string", constraints, profileId })
    .returning();
  await db
    .insert(schema.profileProperties)
    .values({ profileId, propertyDefId: d.id });
  return d.id as string;
}

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
}, 120_000);
afterAll(async () => h?.pg.close());

describe("the one mapper", () => {
  it("derives `enum` from option objects; options win over enumValues", () => {
    const c = buildStoredConstraints({
      enumValues: ["x"],
      enumOptions: DEAL_OPTIONS,
    });
    expect(c.enum).toEqual(["draft", "negotiating", "won", "lost"]);
    expect(readStoredEnumOptions({ constraints: c })?.[2]).toEqual({
      key: "won",
      category: "done",
      humanOnly: true,
    });
    // bare strings still read as options
    expect(readStoredEnumOptions({ constraints: { enum: ["a"] } })).toEqual([
      { key: "a" },
    ]);
  });
});

describe("withLifecycleOptions", () => {
  it("folds options onto the named property", () => {
    const out = withLifecycleOptions(
      [{ slug: "title" }, { slug: "commercialStage" }],
      { property: "commercialStage", options: DEAL_OPTIONS }
    );
    expect(out[1].enumValues).toEqual(["draft", "negotiating", "won", "lost"]);
    expect(out[0]).toEqual({ slug: "title" });
  });
  it("refuses a missing property or an uncategorized option", () => {
    expect(() =>
      withLifecycleOptions([{ slug: "a" }], {
        property: "b",
        options: DEAL_OPTIONS,
      })
    ).toThrow(LifecycleDeclarationError);
    expect(() =>
      withLifecycleOptions([{ slug: "a" }], {
        property: "a",
        options: [{ key: "x" }],
      })
    ).toThrow(/category/);
  });
});

describe("declareLifecycle + getEffectiveLifecycle", () => {
  it("declares, is idempotent, and is read back by the one reader", async () => {
    const deal = await profile("deal");
    await prop(deal, "title", {});
    const defId = await prop(
      deal,
      "commercialStage",
      buildStoredConstraints({ enumOptions: DEAL_OPTIONS })
    );
    const resolver = new ProfileResolutionService(db);
    expect(await resolver.getEffectiveLifecycle(deal)).toBeNull();

    expect(
      await declareLifecycle(db, {
        profileId: deal,
        propertySlug: "commercialStage",
      })
    ).toEqual({ status: "declared", propertyDefId: defId });
    expect(
      await declareLifecycle(db, {
        profileId: deal,
        propertySlug: "commercialStage",
      })
    ).toEqual({ status: "unchanged", propertyDefId: defId });

    const lc = await resolver.getEffectiveLifecycle(deal);
    expect(lc?.propertySlug).toBe("commercialStage");
    expect(lc?.options.map((o) => `${o.key}:${o.category}`)).toEqual([
      "draft:open",
      "negotiating:active",
      "won:done",
      "lost:lost",
    ]);
    expect(lc?.unclassified).toEqual([]);

    // a child kind inherits it; a child declaring a DIFFERENT one is refused
    const child = await profile("big-deal", deal);
    await prop(
      child,
      "bigStage",
      buildStoredConstraints({ enumOptions: [{ key: "a", category: "open" }] })
    );
    expect((await resolver.getEffectiveLifecycle(child))?.propertySlug).toBe(
      "commercialStage"
    );
    const refused = await declareLifecycle(db, {
      profileId: child,
      propertySlug: "bigStage",
    });
    expect(refused.status).toBe("refused");

    // E5: the effective property defs a client reads carry the SAME answer —
    // `isLifecycle` on the declared property only, inherited by the child.
    for (const id of [deal, child]) {
      const flagged = (await resolver.getEffectiveProperties(id, null))
        .filter((p) => p.isLifecycle)
        .map((p) => p.slug);
      expect(flagged).toEqual([
        (await resolver.getEffectiveLifecycle(id))!.propertySlug,
      ]);
    }

    // The batch reader gives the SAME answer per profile, inheritance
    // included; a profile with no lifecycle is absent.
    const plain = await profile("plain-note");
    const batch = await resolver.getEffectiveLifecycles([deal, child, plain]);
    expect(batch.get(deal)).toEqual(await resolver.getEffectiveLifecycle(deal));
    expect(batch.get(child)).toEqual(
      await resolver.getEffectiveLifecycle(child)
    );
    expect(batch.get(child)?.options[0]?.key).toBe("draft");
    expect(batch.has(plain)).toBe(false);
  });

  it("refuses options without a category and reports uncategorized ones", async () => {
    const task = await profile("task");
    await prop(task, "status", { enum: ["todo", "done"] });
    const r = await declareLifecycle(db, {
      profileId: task,
      propertySlug: "status",
    });
    expect(r.status).toBe("refused");

    // a declared lifecycle whose def later gained an uncategorized option
    const lead = await profile("lead");
    const def = await prop(
      lead,
      "leadStage",
      buildStoredConstraints({
        enumOptions: [{ key: "new", category: "open" }],
      })
    );
    await declareLifecycle(db, { profileId: lead, propertySlug: "leadStage" });
    await db
      .update(schema.propertyDefs)
      .set({
        constraints: buildStoredConstraints({
          enumOptions: [{ key: "new", category: "open" }, { key: "odd" }],
        }),
      })
      .where(eq(schema.propertyDefs.id, def));
    const lc = await new ProfileResolutionService(db).getEffectiveLifecycle(
      lead
    );
    expect(lc?.options.map((o) => o.key)).toEqual(["new"]);
    expect(lc?.unclassified).toEqual(["odd"]);
  });
});
