/**
 * The narrowed Knowledge contract + the `issue` system kind, driven through the
 * REAL `ensureSystemProfiles()` on PGlite (plan 9992207a §5, c-knowledge-schema).
 *
 * Reads back what a pod actually holds — profile rows, defs, links, the
 * declared lifecycle — not the seed's source tables. Two shapes:
 *   1. a fresh pod: everything as specified;
 *   2. a pod seeded by the OLD contract (insight/caution, optional "Summary"
 *      claim, old description): one pass converges it, a second changes nothing.
 * Plus the entity door over the seeded schema. The cases share ONE pod and run
 * in order (2 and the door case read what 1 seeded) — run the file, not `-t`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { makeLifecyclePglite } from "../services/lifecycle/__tests__/lifecycle-pglite.js";
import * as schema from "../schema/index.js";
import { ProfileScope } from "../schema/profiles.js";
import { ProfileResolutionService } from "../services/profile-resolution-service.js";
import { readStoredEnumOptions } from "./property-enum.js";
import { KNOWLEDGE_FORMS } from "./knowledge-contract.js";
import { EntityRepository } from "../repositories/entity-repository.js";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../client-pg.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getDb: async () => h.db };
});

import { ensureSystemProfiles } from "./ensure-system-profiles.js";

let pglite: Awaited<ReturnType<typeof makeLifecyclePglite>>;

let db: any;

beforeAll(async () => {
  pglite = await makeLifecyclePglite();
  db = pglite.db;
  h.db = db;
}, 120_000);
afterAll(async () => pglite?.pg.close());

async function profileBySlug(slug: string) {
  const [p] = await db
    .select()
    .from(schema.profiles)
    .where(
      and(
        eq(schema.profiles.slug, slug),
        eq(schema.profiles.scope, ProfileScope.SYSTEM)
      )
    );
  return p;
}

/** Every link on a profile, joined to its def. */
async function linksOf(profileId: string) {
  return db
    .select({
      slug: schema.propertyDefs.slug,
      defId: schema.propertyDefs.id,
      defProfileId: schema.propertyDefs.profileId,
      targetProfileId: schema.propertyDefs.targetProfileId,
      valueType: schema.propertyDefs.valueType,
      constraints: schema.propertyDefs.constraints,
      uiHints: schema.propertyDefs.uiHints,
      required: schema.profileProperties.required,
    })
    .from(schema.profileProperties)
    .innerJoin(
      schema.propertyDefs,
      eq(schema.propertyDefs.id, schema.profileProperties.propertyDefId)
    )
    .where(eq(schema.profileProperties.profileId, profileId));
}

async function expectSpecifiedContract() {
  const knowledge = await profileBySlug("knowledge");
  expect(knowledge).toBeTruthy();
  const description = (knowledge.uiHints as { description?: string })
    .description;
  expect(description).toMatch(/fact/);
  expect(description).toMatch(/caution/);
  expect(description).toMatch(/convention/);
  // What it is NOT — the routing rule, on the profile itself.
  expect(description).toMatch(/Not knowledge/);
  expect(description).toMatch(/\(issue\)/);
  expect(description).toMatch(/\(decision\)/);

  const links = await linksOf(knowledge.id);
  const by = (slug: string) => {
    const hits = links.filter((l: { slug: string }) => l.slug === slug);
    expect(hits, `exactly one ${slug} link on knowledge`).toHaveLength(1);
    return hits[0];
  };

  expect(by("knowledgeForm").required).toBe(true);
  expect(by("knowledgeForm").constraints.enum).toEqual([
    "fact",
    "caution",
    "convention",
  ]);
  // The seed's literal and the contract's forms are one set.
  expect(by("knowledgeForm").constraints.enum).toEqual([...KNOWLEDGE_FORMS]);

  const claim = by("ek_claim");
  expect(claim.required).toBe(true);
  expect(claim.uiHints.label).toBe("Claim");

  const verifiedAt = by("verifiedAt");
  expect(verifiedAt.valueType).toBe("date");
  expect(verifiedAt.required).toBe(false);

  const supersededBy = by("supersededBy");
  expect(supersededBy.valueType).toBe("entity_id");
  expect(supersededBy.defProfileId).toBe(knowledge.id);
  expect(supersededBy.targetProfileId).toBe(knowledge.id);

  // decision keeps the GLOBAL supersededBy, untargeted.
  const decision = await profileBySlug("decision");
  const decisionSup = (await linksOf(decision.id)).filter(
    (l: { slug: string }) => l.slug === "supersededBy"
  );
  expect(decisionSup).toHaveLength(1);
  expect(decisionSup[0].defProfileId).toBeNull();
  expect(decisionSup[0].targetProfileId).toBeNull();

  // `issue`: a pod-wide SYSTEM kind with its ONE lifecycle.
  const issue = await profileBySlug("issue");
  expect(issue).toBeTruthy();
  expect(issue.entityScope).toBe("pod");
  const issueLinks = await linksOf(issue.id);
  const status = issueLinks.find(
    (l: { slug: string }) => l.slug === "issueStatus"
  );
  expect(status).toBeTruthy();
  expect(
    readStoredEnumOptions({ constraints: status.constraints })?.map(
      (o) => [o.key, o.category] as const
    )
  ).toEqual([
    ["open", "open"],
    ["investigating", "active"],
    ["fixed", "done"],
    ["wont_fix", "lost"],
  ]);
  const lc = await new ProfileResolutionService(db).getEffectiveLifecycle(
    issue.id
  );
  expect(lc?.propertySlug).toBe("issueStatus");
}

describe("ensureSystemProfiles — narrowed Knowledge + issue", () => {
  it("seeds a fresh pod exactly as specified", async () => {
    const r = await ensureSystemProfiles();
    expect(r.error, r.error).toBeUndefined();
    expect(r.status).toBe("created");
    expect((r.lifecycles as { declared?: string[] }).declared ?? []).toContain(
      "issue"
    );
    await expectSpecifiedContract();
  }, 120_000);

  it("converges a pod seeded by the old contract, then changes nothing", async () => {
    const knowledge = await profileBySlug("knowledge");
    // Rewind to the pre-narrowing state the live pods hold.
    await db
      .update(schema.profiles)
      .set({
        uiHints: {
          ...(knowledge.uiHints as object),
          description:
            "Reusable insights and cautions, with evidence and related graph entities.",
        },
      })
      .where(eq(schema.profiles.id, knowledge.id));
    await db
      .update(schema.propertyDefs)
      .set({
        constraints: { enum: ["insight", "caution"] },
        uiHints: { label: "Knowledge form", inputType: "select" },
      })
      .where(
        and(
          eq(schema.propertyDefs.slug, "knowledgeForm"),
          isNull(schema.propertyDefs.profileId)
        )
      );
    await db
      .update(schema.propertyDefs)
      .set({ uiHints: { label: "Summary", inputType: "text" } })
      .where(
        and(
          eq(schema.propertyDefs.slug, "ek_claim"),
          isNull(schema.propertyDefs.profileId)
        )
      );
    const [claimDef] = await db
      .select()
      .from(schema.propertyDefs)
      .where(
        and(
          eq(schema.propertyDefs.slug, "ek_claim"),
          isNull(schema.propertyDefs.profileId)
        )
      );
    await db
      .update(schema.profileProperties)
      .set({ required: false })
      .where(
        and(
          eq(schema.profileProperties.profileId, knowledge.id),
          eq(schema.profileProperties.propertyDefId, claimDef.id)
        )
      );
    // An old pod has no knowledge-scoped supersededBy and no verifiedAt link.
    const scopedSup = await db
      .select()
      .from(schema.propertyDefs)
      .where(
        and(
          eq(schema.propertyDefs.slug, "supersededBy"),
          eq(schema.propertyDefs.profileId, knowledge.id)
        )
      );
    for (const d of scopedSup) {
      await db
        .delete(schema.profileProperties)
        .where(eq(schema.profileProperties.propertyDefId, d.id));
      await db
        .delete(schema.propertyDefs)
        .where(eq(schema.propertyDefs.id, d.id));
    }

    const first = await ensureSystemProfiles();
    expect(first.error, first.error).toBeUndefined();
    await expectSpecifiedContract();

    const defsBefore = await db.select().from(schema.propertyDefs);
    const second = await ensureSystemProfiles();
    expect(second.error, second.error).toBeUndefined();
    expect(second.profilesCreated).toBe(0);
    expect(second.propertiesCreated).toBe(0);
    expect(second.linksCreated).toBe(0);
    const defsAfter = await db.select().from(schema.propertyDefs);
    expect(defsAfter).toHaveLength(defsBefore.length);
    await expectSpecifiedContract();
  }, 120_000);

  it("the entity door: a new claimless write is refused; a historic row stays updatable", async () => {
    const knowledge = await profileBySlug("knowledge");
    const repo = new EntityRepository(db, {
      append: async () => ({ id: "ev" }),
    } as never);
    // A NEW write must carry its claim (the required link).
    const refused = await repo
      .create(
        {
          profileSlug: "knowledge",
          title: "Grants deny by default",
          properties: { knowledgeForm: "fact" },
          skipEvent: true,
        } as never,
        "u1"
      )
      .then(
        () => null,
        (e: unknown) => e
      );
    // The refusal is the REQUIRED claim, not some other failure.
    expect(JSON.stringify(refused)).toMatch(/ek_claim' is required/);
    const ok = await repo.create(
      {
        profileSlug: "knowledge",
        title: "Grants deny by default",
        properties: {
          knowledgeForm: "convention",
          ek_claim: "Every key starts with no grant.",
        },
        skipEvent: true,
      } as never,
      "u1"
    );
    expect(
      (ok as { properties: Record<string, unknown> }).properties
    ).toMatchObject({
      knowledgeForm: "convention",
      ek_claim: "Every key starts with no grant.",
    });

    // A HISTORIC row (old form, no claim) written before the contract.
    const [old] = await db
      .insert(schema.entities)
      .values({
        userId: "u1",
        type: "knowledge",
        profileId: knowledge.id,
        title: "Code-read is not runtime-true",
        properties: { knowledgeForm: "insight" },
      })
      .returning();
    const updated = await repo.update(
      old.id,
      {
        properties: { ek_tags: ["repo:synap-backend"] },
        skipEvent: true,
      } as never,
      "u1"
    );
    expect(
      (updated as { properties: Record<string, unknown> }).properties
    ).toMatchObject({
      knowledgeForm: "fact",
      ek_claim: "Code-read is not runtime-true",
      ek_tags: ["repo:synap-backend"],
    });
  }, 120_000);

  it("never rewrites a user's own Knowledge description", async () => {
    const knowledge = await profileBySlug("knowledge");
    const mine = "My team's lasting notes";
    await db
      .update(schema.profiles)
      .set({
        uiHints: { ...(knowledge.uiHints as object), description: mine },
      })
      .where(eq(schema.profiles.id, knowledge.id));
    await ensureSystemProfiles();
    const after = await profileBySlug("knowledge");
    expect((after.uiHints as { description?: string }).description).toBe(mine);
  }, 120_000);
});
