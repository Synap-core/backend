/**
 * Every intent an app may ask to run (`capability.<intent>.run`, decision 2A,
 * 2026-10-28) has words on the consent screen. Rules out: a new intent slug
 * reaching consent as its raw slug.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITY_INTENTS, intentRunLabel } from "./index.js";

describe("intentRunLabel", () => {
  it.each(CAPABILITY_INTENTS)("%s has its own words", (slug) => {
    const label = intentRunLabel(slug);
    expect(label).not.toContain(slug);
    expect(label).toMatch(/^[A-Z]/);
  });

  it("publish_post reads as the founder's example", () => {
    expect(intentRunLabel("publish_post")).toBe(
      "Publish posts with your tools"
    );
  });

  it("edit_video reads as the founder's sentence (decision ac1ba2b6)", () => {
    expect(intentRunLabel("edit_video")).toBe("Edit videos with your tools");
  });

  it("an unknown slug still reads as a sentence, never a bare slug", () => {
    expect(intentRunLabel("make_coffee")).toBe("Run your tools to make coffee");
  });
});
