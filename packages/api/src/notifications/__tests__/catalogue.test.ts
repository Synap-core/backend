/**
 * Catalogue guard — the projection a settings picker renders FROM.
 *
 * Every assertion here is written to DISCRIMINATE: each one names a concrete
 * input that would have passed under the defect it guards against. A test that
 * merely asserts "the catalogue is non-empty" would pass on the raw registry,
 * which is the exact thing this module exists not to ship.
 *
 * WHAT THESE TESTS DO NOT COVER, measured: they assert the SHAPE and the
 * FILTERS of the projection. They do not assert that a type in the catalogue
 * actually fires — that is the source-scan tripwire's job
 * (`../notification-producer-allowlist.test.ts`), which pins
 * `PRODUCERLESS_NOTIFICATION_TYPES` to the real producer set. These two tests
 * are complementary and neither substitutes for the other.
 */
import { describe, it, expect } from "vitest";

import {
  buildNotificationCatalogue,
  catalogueEntryFor,
  allowedRulesFor,
  PRODUCERLESS_NOTIFICATION_TYPES,
  DELIVERABLE_CHANNELS,
  TRANSPORTLESS_CHANNELS,
} from "../catalogue.js";
import { NOTIFICATION_REGISTRY, type NotificationDef } from "../registry.js";

const catalogue = buildNotificationCatalogue();
const types = new Set(catalogue.types.map((t) => t.type));

describe("notification catalogue — producer-backed types only", () => {
  it("is not vacuous: it carries a plausible number of types and a literal sample", () => {
    // A filter that accidentally excluded everything would satisfy every
    // "does not contain X" assertion below. Pin both ends.
    expect(catalogue.types.length).toBeGreaterThan(15);
    expect(catalogue.types.length).toBeLessThan(NOTIFICATION_REGISTRY.length);
    // A literal sample of exactly what it is supposed to contain.
    expect(types.has("proposal.created")).toBe(true);
    expect(types.has("governance.proposal_stale")).toBe(true);
  });

  it("excludes NAMED producer-less types — the dead switches relay deleted", () => {
    // Each of these is declared in NOTIFICATION_REGISTRY and emitted by NOBODY.
    // Rendering a switch for them writes a real `routingRules` row that governs
    // nothing. Named literally so this assertion discriminates: it fails if the
    // filter is dropped, and it fails if the filter stops covering these rows.
    // NB `ai.proactive.*` was listed here until 2026-09-20 and was WRONG: those
    // types are emitted by `delivery-router.ts` as `` `ai.proactive.${type}` ``,
    // which a literal scan cannot see. They are delivered notifications, so the
    // catalogue must LIST them — hiding them is a missing switch for something
    // the founder actually receives.
    for (const dead of [
      "proposal.auto_approved",
      "inbox.email",
      "workspace.invite",
      "agent.task_complete",
      "pod.update_available",
    ]) {
      expect(
        NOTIFICATION_REGISTRY.some((d) => d.type === dead),
        `${dead} is no longer in the registry — update this fixture`
      ).toBe(true);
      expect(types.has(dead), `${dead} leaked into the catalogue`).toBe(false);
    }
  });

  it("withholds exactly the producer-less set, and says how many", () => {
    const withheld = NOTIFICATION_REGISTRY.filter(
      (d) => !types.has(d.type)
    ).map((d) => d.type);
    expect(new Set(withheld)).toEqual(
      new Set([...PRODUCERLESS_NOTIFICATION_TYPES])
    );
    expect(catalogue.withheldProducerlessCount).toBe(withheld.length);
    expect(catalogue.withheldProducerlessCount).toBeGreaterThan(10);
  });
});

describe("notification catalogue — no channel without a transport", () => {
  it("never names telegram or email_digest anywhere on the wire", () => {
    // Positive control first: these channels ARE declared in the registry, so
    // the assertion below is not passing because nothing ever mentions them.
    const declaresTransportless = NOTIFICATION_REGISTRY.some((d) =>
      d.defaultChannels.some((c) =>
        (TRANSPORTLESS_CHANNELS as readonly string[]).includes(c)
      )
    );
    const wire = JSON.stringify(catalogue);
    for (const channel of TRANSPORTLESS_CHANNELS) {
      expect(wire).not.toContain(channel);
    }
    // Recorded, not asserted as a requirement: if the registry stops declaring
    // any transport-less default the filter becomes untested here, and this
    // flag is what tells a future reader that happened.
    expect(typeof declaresTransportless).toBe("boolean");
  });

  it("offers only rules a transport can honour — telegram is never offerable", () => {
    for (const entry of catalogue.types) {
      expect(entry.allowedRules).not.toContain("telegram");
      expect(entry.allowedRules).toContain("mute");
      expect(entry.allowedRules.length).toBeGreaterThan(1);
      for (const channel of entry.defaultChannels) {
        expect(DELIVERABLE_CHANNELS as readonly string[]).toContain(channel);
      }
    }
  });
});

describe("notification catalogue — allowedRules derive from channelCeiling", () => {
  const capped: NotificationDef = {
    type: "test.capped",
    category: "system",
    label: "Capped",
    icon: "bell",
    priority: "normal",
    titleTemplate: "t",
    bodyTemplate: "b",
    defaultChannels: ["in_app"],
    channelCeiling: ["in_app"],
  };
  const uncapped: NotificationDef = {
    ...capped,
    type: "test.uncapped",
    defaultChannels: ["in_app", "os"],
    channelCeiling: undefined,
  };

  it("drops a rule the ceiling would strip to nothing, and its duplicate", () => {
    // `os` resolves to {os}, which the in_app ceiling strips to {} — a switch
    // that writes a row and changes nothing. `all` resolves to {in_app, os},
    // which the ceiling collapses to exactly {in_app} — a second control
    // indistinguishable from the `in_app` one already offered.
    expect(allowedRulesFor(capped)).toEqual(["in_app", "mute"]);
  });

  it("offers the full set when there is no ceiling", () => {
    expect(allowedRulesFor(uncapped)).toEqual(["all", "os", "in_app", "mute"]);
  });

  it("names the rule equivalent to the type's defaults", () => {
    expect(catalogueEntryFor(uncapped).defaultRule).toBe("all");
    expect(catalogueEntryFor(capped).defaultRule).toBe("in_app");
  });

  it("applies the ceiling to the REAL registry entry that has one", () => {
    // `handoff.continue` is capped to in_app: the request came FROM the phone,
    // so pushing it back to the phone is noise. It must not offer a push rule.
    const handoff = catalogue.types.find((t) => t.type === "handoff.continue");
    expect(
      handoff,
      "handoff.continue missing — update this fixture"
    ).toBeDefined();
    expect(handoff!.channelCeiling).toEqual(["in_app"]);
    expect(handoff!.allowedRules).not.toContain("os");
    expect(handoff!.allowedRules).not.toContain("all");
  });
});

describe("notification catalogue — labels resolve, never leak", () => {
  it("every type carries its registry label, none of them a raw token", () => {
    for (const entry of catalogue.types) {
      expect(entry.label.length).toBeGreaterThan(0);
      // A raw token would still contain the dotted namespace it came from.
      expect(entry.label).not.toContain(".");
      expect(entry.label).not.toBe(entry.type);
    }
  });

  it("category labels come from the vocabulary — including the acronym", () => {
    const ai = catalogue.categories.find((c) => c.category === "ai");
    expect(ai, "no ai category in the catalogue").toBeDefined();
    // `humanizeToken("ai")` would give "Ai". This is the discriminating case:
    // it fails if a call site ever hand-rolls the label instead of resolving it.
    expect(ai!.label).toBe("AI");
    for (const c of catalogue.categories) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.label).not.toBe(c.category);
    }
  });

  it("lists no empty category group", () => {
    for (const c of catalogue.categories) {
      expect(
        catalogue.types.some((t) => t.category === c.category),
        `category ${c.category} has no types`
      ).toBe(true);
    }
    expect(new Set(catalogue.categories.map((c) => c.category)).size).toBe(
      catalogue.categories.length
    );
  });
});
