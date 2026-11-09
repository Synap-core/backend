/**
 * The `snippet` system kind, driven through the REAL `ensureSystemProfiles()`
 * on PGlite: seeded on a fresh pod, pod-wide, its four fields and its ONE
 * lifecycle (`current` and `retired` are person-only); an existing pod
 * converges without a second row or link; the retired DevPlane prompt snippet
 * is no longer seeded by `ensureDevplaneProfiles`.
 * The cases share ONE pod and run in order: run the file, not `-t`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { decideAgentPolicy } from "@synap/governance-policy";
import { makeLifecyclePglite } from "../services/lifecycle/__tests__/lifecycle-pglite.js";
import * as schema from "../schema/index.js";
import { ProfileScope } from "../schema/profiles.js";
import { ProfileResolutionService } from "../services/profile-resolution-service.js";
import { readStoredEnumOptions } from "./property-enum.js";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../client-pg.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getDb: async () => h.db };
});

import {
  ensureSystemProfiles,
  ensureDevplaneProfiles,
  SYSTEM_PROFILE_SLUGS,
} from "./ensure-system-profiles.js";

let pglite: Awaited<ReturnType<typeof makeLifecyclePglite>>;
let db: any;

beforeAll(async () => {
  pglite = await makeLifecyclePglite();
  db = pglite.db;
  h.db = db;
}, 120_000);
afterAll(async () => pglite?.pg.close());

async function profilesBySlug(slug: string) {
  return db
    .select()
    .from(schema.profiles)
    .where(
      and(
        eq(schema.profiles.slug, slug),
        eq(schema.profiles.scope, ProfileScope.SYSTEM)
      )
    );
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

describe("ensureSystemProfiles: the snippet kind", () => {
  it("seeds snippet on a fresh pod: pod-wide, four fields, one lifecycle", async () => {
    const r = await ensureSystemProfiles();
    expect(r.error, r.error).toBeUndefined();
    expect(r.status).toBe("created");
    expect(SYSTEM_PROFILE_SLUGS.has("snippet")).toBe(true);

    const rows = await profilesBySlug("snippet");
    expect(rows).toHaveLength(1);
    const snippet = rows[0];
    expect(snippet.entityScope).toBe("pod");
    expect(snippet.isActive).toBe(true);

    const links = await linksOf(snippet.id);
    const by = (slug: string) => {
      const hits = links.filter((l: { slug: string }) => l.slug === slug);
      expect(hits, `exactly one ${slug} link on snippet`).toHaveLength(1);
      return hits[0];
    };
    expect(by("body").uiHints.inputType).toBe("textarea");
    expect(by("variables").valueType).toBe("array");
    expect(by("variables").uiHints.inputType).toBe("json");
    expect(by("use").constraints.enum).toEqual([
      "email",
      "message",
      "prompt",
      "reply",
      "other",
    ]);
    expect(by("channel").valueType).toBe("string");

    const status = by("snippetStatus");
    expect(
      readStoredEnumOptions({ constraints: status.constraints })?.map(
        (o) => [o.key, o.category, o.humanOnly === true] as const
      )
    ).toEqual([
      ["draft", "open", false],
      ["current", "done", true],
      ["retired", "lost", true],
    ]);
    const lc = await new ProfileResolutionService(db).getEffectiveLifecycle(
      snippet.id
    );
    expect(lc?.propertySlug).toBe("snippetStatus");
  }, 120_000);

  it("an agent's move to current or retired is proposed; draft is not person-only", async () => {
    const [snippet] = await profilesBySlug("snippet");
    const status = (await linksOf(snippet.id)).find(
      (l: { slug: string }) => l.slug === "snippetStatus"
    );
    const options = readStoredEnumOptions({ constraints: status.constraints })!;
    const move = (key: string) => {
      const o = options.find((x) => x.key === key)!;
      return decideAgentPolicy({
        subjectType: "entity",
        action: "transition",
        lifecycleMove: {
          intoTerminal: o.category === "done" || o.category === "lost",
          humanOnly: o.humanOnly === true,
        },
        governanceRuleVerdict: "auto",
      });
    };
    expect(move("current")).toMatchObject({
      verdict: "propose",
      reasonCode: "HUMAN_ONLY_STATUS",
    });
    expect(move("retired")).toMatchObject({
      verdict: "propose",
      reasonCode: "HUMAN_ONLY_STATUS",
    });
    expect(move("draft").verdict).toBe("execute");
  });

  it("a second pass on the existing pod changes nothing", async () => {
    const before = await profilesBySlug("snippet");
    const linksBefore = await linksOf(before[0].id);
    const r = await ensureSystemProfiles();
    expect(r.error, r.error).toBeUndefined();
    expect(r.status).toBe("exists");
    const after = await profilesBySlug("snippet");
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    const linksAfter = await linksOf(after[0].id);
    expect(linksAfter.map((l: { defId: string }) => l.defId).sort()).toEqual(
      linksBefore.map((l: { defId: string }) => l.defId).sort()
    );
    const defs = await db
      .select()
      .from(schema.propertyDefs)
      .where(eq(schema.propertyDefs.slug, "snippetStatus"));
    expect(defs).toHaveLength(1);
  }, 120_000);

  it("ensureDevplaneProfiles no longer seeds the retired prompt snippet", async () => {
    const r = await ensureDevplaneProfiles();
    expect(r.error, r.error).toBeUndefined();
    expect(await profilesBySlug("devplane_prompt_snippet")).toHaveLength(0);
    expect(await profilesBySlug("devplane_app")).toHaveLength(1);
  }, 120_000);
});
