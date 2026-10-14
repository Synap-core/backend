/**
 * The definition doors judge `presentation` with the ONE parser, and every
 * system-kind presentation the pod backfills parses under it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SYSTEM_PROFILE_PRESENTATIONS } from "@synap/database";
import { parseProfilePresentation } from "@synap-core/types/presentation";
import { profilePresentationSchema } from "./profile-presentation-schema.js";

const profile = z.object({
  slug: z.string(),
  presentation: profilePresentationSchema.optional(),
  uiHints: z
    .object({
      icon: z.string().optional(),
      presentation: profilePresentationSchema.optional(),
    })
    .optional(),
});

describe("profilePresentationSchema", () => {
  it("keeps a valid declaration (normalised) instead of stripping it", () => {
    const out = profile.parse({
      slug: "brand-asset",
      presentation: {
        family: "media",
        media: { source: { property: "asset-document-id" } },
        extra: 1,
      },
      uiHints: { icon: "image", presentation: { family: "link" } },
    });
    expect(out.presentation).toEqual({
      family: "media",
      media: { source: { property: "asset-document-id" }, kind: "auto" },
    });
    expect(out.uiHints?.presentation).toEqual({ family: "link" });
  });

  it("refuses an invalid one with the parser's issues", () => {
    const r = profile.safeParse({
      slug: "x",
      presentation: { family: "gallery" },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/presentation\.family/);
    const nested = profile.safeParse({
      slug: "x",
      uiHints: { presentation: { family: "media", media: { source: {} } } },
    });
    expect(nested.success).toBe(false);
  });

  it("absent stays absent", () => {
    expect(profile.parse({ slug: "x" }).presentation).toBeUndefined();
  });
});

describe("SYSTEM_PROFILE_PRESENTATIONS", () => {
  it("every system-kind presentation parses under the ONE parser", () => {
    const entries = Object.entries(SYSTEM_PROFILE_PRESENTATIONS);
    expect(entries.length).toBeGreaterThanOrEqual(8);
    for (const [slug, p] of entries)
      expect(parseProfilePresentation(p).ok, slug).toBe(true);
  });
});
