import { describe, it, expect } from "vitest";
import { describeCapabilityRun } from "./execute-capability.js";

/**
 * A proposed capability run must say WHAT it will do.
 *
 * Found 2026-09-06 by dogfooding the agent install door through MCP: the run
 * came back `kind:"proposed"` correctly, but the queue row read only
 * "capability.run proposal on capability is pending". The payload carried
 * `parameters.slug` and `parameters.kind` all along — nothing produced a
 * `data.summary`, and every other proposal type has one.
 *
 * That is the review-theatre failure already logged for rules ("a reviewer
 * would see that a rule is proposed but not WHICH rule"), landing on the
 * marketplace's central promise: an installed package proposes, and you
 * approve. Approving what you cannot read is not approval.
 */
describe("describeCapabilityRun", () => {
  it("names the package AND its kind for a marketplace install", () => {
    expect(
      describeCapabilityRun("market.install", {
        slug: "arch-client-intelligence",
        kind: "capability",
      })
    ).toBe('Install Capability "arch-client-intelligence"');
  });

  it("uses the vocabulary SSOT, not the raw token", () => {
    // `cell` is **Card** and `workflow` is **Automation** in the registry; a
    // hand-written label map here would fork the product's nouns.
    expect(
      describeCapabilityRun("market.install", { slug: "probe", kind: "cell" })
    ).toBe('Install Card "probe"');
    expect(
      describeCapabilityRun("market.install", {
        slug: "nudges",
        kind: "workflow",
      })
    ).toBe('Install Automation "nudges"');
  });

  it("degrades honestly when the payload is thin", () => {
    // An unknown kind humanizes rather than leaking a token.
    expect(
      describeCapabilityRun("market.install", { slug: "x", kind: "renderer" })
    ).toBe('Install Renderer "x"');
    // No kind at all — still name the package.
    expect(describeCapabilityRun("market.install", { slug: "x" })).toBe(
      'Install package "x"'
    );
    // Not an install: name the verb rather than inventing detail.
    expect(describeCapabilityRun("gmail_send", { to: "a@b.c" })).toBe(
      "Run gmail_send"
    );
    expect(describeCapabilityRun(null, {})).toBe("Run capability");
  });

  it("never returns an empty string", () => {
    for (const [verb, params] of [
      ["market.install", {}],
      ["", {}],
      [null, { slug: "" }],
    ] as [string | null, Record<string, unknown>][]) {
      expect(describeCapabilityRun(verb, params).length).toBeGreaterThan(0);
    }
  });
});
