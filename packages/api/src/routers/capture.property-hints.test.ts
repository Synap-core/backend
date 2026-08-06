/**
 * Property vocabulary reaching the structuring prompt.
 *
 * ROOT CAUSE this pins: `buildAvailableProfiles` reads `p.effectiveProperties`,
 * but its only upstream — `ProfileResolutionService.getAccessibleProfiles` —
 * returns bare `profiles` rows that have never carried that field. Every call
 * site cast the rows (`as unknown as AccessibleProfileLike[]`), so the code
 * type-checked clean while `propertyHints` was ALWAYS undefined: the model was
 * told which profile slugs exist and never which properties they require, and
 * returned titles with `properties: {}`.
 *
 * `withEffectiveProperties` is the one door that attaches the REAL schema.
 * These tests assert the hint STRING the IS renders into the prompt
 * (`. Props: { … }`), including the `*` required marker.
 */

import { describe, it, expect } from "vitest";
import {
  buildAvailableProfiles,
  withEffectiveProperties,
  type AccessibleProfileLike,
} from "./capture.js";

const KNOWLEDGE_ID = "aaaaaaaa-0000-0000-0000-000000000001";

describe("buildAvailableProfiles — propertyHints", () => {
  it("emits typed hints with a `*` marker on required properties", () => {
    const [hint] = buildAvailableProfiles([
      {
        id: KNOWLEDGE_ID,
        slug: "knowledge",
        displayName: "Knowledge",
        effectiveProperties: [
          {
            slug: "knowledgeForm",
            valueType: "string",
            required: true,
            constraints: { enum: ["insight", "caution"] },
          },
          { slug: "ek_claim", valueType: "string", required: false },
          { slug: "ek_confidence", valueType: "number", required: false },
        ],
      },
    ]);

    expect(hint.propertyHints).toBe(
      "knowledgeForm:enum(insight|caution)*, ek_claim:string, ek_confidence:number"
    );
  });

  it("is undefined when no effective properties are attached (the bug's signature)", () => {
    const [hint] = buildAvailableProfiles([
      { id: KNOWLEDGE_ID, slug: "knowledge", displayName: "Knowledge" },
    ]);
    expect(hint.propertyHints).toBeUndefined();
  });

  it("orders required properties first so the cap can never drop one", () => {
    const many: AccessibleProfileLike["effectiveProperties"] = [];
    for (let i = 0; i < 40; i++)
      many!.push({ slug: `opt_${i}`, valueType: "string", required: false });
    many!.push({ slug: "must_have", valueType: "string", required: true });

    const [hint] = buildAvailableProfiles([
      {
        id: KNOWLEDGE_ID,
        slug: "wide",
        displayName: "Wide",
        effectiveProperties: many,
      },
    ]);

    const slugs = hint.propertyHints!.split(", ");
    expect(slugs[0]).toBe("must_have:string*");
    // Capped, but the required prop survived the cap.
    expect(slugs.length).toBe(30);
  });
});

describe("withEffectiveProperties", () => {
  const profileService = {
    getEffectiveProperties: async (profileId: string) =>
      profileId === KNOWLEDGE_ID
        ? [
            { slug: "knowledgeForm", valueType: "string", required: true },
            { slug: "ek_claim", valueType: "string", required: false },
          ]
        : [],
  };

  it("attaches the real schema so propertyHints becomes non-empty", async () => {
    const enriched = await withEffectiveProperties(
      profileService as never,
      [{ id: KNOWLEDGE_ID, slug: "knowledge", displayName: "Knowledge" }],
      null
    );
    const [hint] = buildAvailableProfiles(enriched);
    expect(hint.propertyHints).toBe("knowledgeForm:string*, ek_claim:string");
  });

  it("degrades to no hints for a profile whose resolution throws — never fails the import", async () => {
    const throwing = {
      getEffectiveProperties: async () => {
        throw new Error("cold profile lens");
      },
    };
    const enriched = await withEffectiveProperties(
      throwing as never,
      [{ id: KNOWLEDGE_ID, slug: "knowledge", displayName: "Knowledge" }],
      null
    );
    expect(enriched).toHaveLength(1);
    expect(buildAvailableProfiles(enriched)[0].propertyHints).toBeUndefined();
  });
});
