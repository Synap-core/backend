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

  it.each([
    ["expose_http", "Make your services reachable at a web address"],
    ["tunnel", "Connect your computers to the internet edge, outbound only"],
    ["dns_record", "Change DNS records in your domains"],
    ["tls_cert", "Get and renew certificates for your web addresses"],
    ["render_video", "Render videos with your tools"],
  ])("%s (0398) has its own sentence, not the fallback", (slug, label) => {
    expect(intentRunLabel(slug)).toBe(label);
    expect(intentRunLabel(slug)).not.toMatch(/^Run your tools to /);
  });

  it("an unknown slug still reads as a sentence, never a bare slug", () => {
    expect(intentRunLabel("make_coffee")).toBe("Run your tools to make coffee");
  });
});
