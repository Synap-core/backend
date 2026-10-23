import { describe, expect, it } from "vitest";
import {
  DESTINATIONS,
  DESTINATION_LABELS,
  resolveDestinationLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "./index.js";
import { NOT_IN_A_PROJECT } from "../projects/places.js";

/**
 * Founder decision 2A (2026-10-19): the shell's destination words, through the
 * ONE door (`@synap-core/types/vocabulary`). The Inbox filters' words are
 * `NEEDS_YOU_BUCKET_LABELS` (needs-you/buckets.test.ts).
 */
describe("destination words (2A)", () => {
  it("the sidebar reads Home · Inbox · Work · Library · Projects · Spaces · Agents", () => {
    expect(DESTINATIONS.map(resolveDestinationLabel)).toEqual([
      "Home",
      "Inbox",
      "Work",
      "Library",
      "Projects",
      "Spaces",
      "Agents",
      "Unfiled",
      "Getting started",
      "Plan and credits",
    ]);
  });

  it("a destination that lists objects says their registry plural (never a second word)", () => {
    expect(DESTINATION_LABELS.projects).toBe(
      resolveObjectNounPlural("project")
    );
    expect(DESTINATION_LABELS.spaces).toBe(
      resolveObjectNounPlural("workspace")
    );
    expect(DESTINATION_LABELS.agents).toBe(resolveObjectNounPlural("agent"));
    // Work keeps the vocabulary's word (the manifest's name for `sessions`).
    expect(DESTINATION_LABELS.work).toBe(resolveObjectNoun("work"));
  });

  it("the unfiled bucket is Unfiled, and the shared place word follows it", () => {
    expect(resolveDestinationLabel("unfiled")).toBe("Unfiled");
    expect(NOT_IN_A_PROJECT).toBe("Unfiled");
  });

  it("the plan and the credits are ONE place, one word on desktop and phone", () => {
    expect(resolveDestinationLabel("credits")).toBe("Plan and credits");
  });

  it("an id spelled with a dash resolves the same", () => {
    expect(resolveDestinationLabel("getting-started")).toBe("Getting started");
  });

  it("unknown values humanize, never leak", () => {
    expect(resolveDestinationLabel("night_shift")).toBe("Night shift");
    expect(resolveDestinationLabel(undefined)).toBe("");
  });
});
