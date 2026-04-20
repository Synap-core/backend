/**
 * hydration-summary-post — smoke tests for the pure message generator.
 *
 * We test generateHydrationSummary() directly so there's no DB, no pg-boss,
 * and no realtime involvement. Covers:
 *  - primary payload shape (LinkedIn-heavy import)
 *  - multi-source phrasing
 *  - empty payload fallback
 *  - singular vs plural handling
 */

import { describe, it, expect } from "vitest";
import {
  generateHydrationSummary,
  type HydrationSummaryData,
} from "./hydration-summary-post.js";

describe("generateHydrationSummary", () => {
  it("produces a warm, specific message for the LinkedIn + Claude sample", () => {
    const payload: HydrationSummaryData = {
      entitiesByProfile: { person: 312, note: 47 },
      sourcesSummary: { linkedin: 312, claude: 47 },
      propertiesCreated: 3,
      totalCreated: 359,
      totalMatched: 0,
    };

    const msg = generateHydrationSummary(payload);

    // Core counts present
    expect(msg).toContain("359");
    expect(msg).toContain("people");
    // Multi-source phrasing
    expect(msg).toContain("LinkedIn");
    expect(msg).toContain("Claude");
    // Property clause
    expect(msg).toContain("3 new field");
    // Friendly closer
    expect(msg).toContain("Ready when you are");
  });

  it("uses singular phrasing when only one entity was created", () => {
    const payload: HydrationSummaryData = {
      entitiesByProfile: { note: 1 },
      sourcesSummary: { import: 1 },
      propertiesCreated: 1,
      totalCreated: 1,
      totalMatched: 0,
    };

    const msg = generateHydrationSummary(payload);

    expect(msg).toContain("1 new note");
    // Singular "field", not "fields"
    expect(msg).toContain("1 new field ");
    expect(msg).not.toContain("1 new fields");
  });

  it("adds a matched clause when entities were deduped to existing records", () => {
    const payload: HydrationSummaryData = {
      entitiesByProfile: { person: 50 },
      sourcesSummary: { linkedin: 50 },
      propertiesCreated: 0,
      totalCreated: 30,
      totalMatched: 20,
    };

    const msg = generateHydrationSummary(payload);

    expect(msg).toContain("30 new");
    expect(msg).toContain("matched 20");
    expect(msg).toContain("LinkedIn");
    // No property sentence when 0 created
    expect(msg).not.toContain("new field");
  });

  it("falls back to the single-source phrasing when only one source is present", () => {
    const payload: HydrationSummaryData = {
      entitiesByProfile: { person: 100 },
      sourcesSummary: { linkedin: 100 },
      propertiesCreated: 0,
      totalCreated: 100,
      totalMatched: 0,
    };

    const msg = generateHydrationSummary(payload);

    expect(msg).toContain("Mostly from LinkedIn");
    expect(msg).not.toContain("combined data");
  });

  it("returns a safe fallback when there's nothing substantial to summarise", () => {
    const payload: HydrationSummaryData = {
      entitiesByProfile: {},
      sourcesSummary: {},
      propertiesCreated: 0,
      totalCreated: 0,
      totalMatched: 0,
    };

    const msg = generateHydrationSummary(payload);

    expect(msg).toContain("looks light");
    expect(msg).toContain("Ready when you are");
  });
});
