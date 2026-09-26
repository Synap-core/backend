/**
 * Founder decision D2 (2026-09-26): a proactive AI alert NEVER counts in
 * Needs-you. Every `ai.proactive.*` type is a SUGGESTION — uncounted, marked
 * as AI, dismissible. When an agent needs the person, it asks a QUESTION in the
 * session room (post kind 'question' → `session.needs_you`), which is a
 * different type with its own role.
 *
 * The set is DERIVED from the registry by prefix, so a new `ai.proactive.*`
 * type joins the scan by existing. It is read through `needsYouRole()` — the
 * same resolver the needs-you union classifies rows with — so an omitted
 * `needsYou` (which resolves to "item") fails here too, not only a wrong one.
 *
 * NOT covered, measured: a proactive producer that writes a type OUTSIDE the
 * `ai.proactive.` prefix. The prefix is the contract this test pins.
 */
import { describe, it, expect } from "vitest";

import { NOTIFICATION_REGISTRY, needsYouRole } from "../registry.js";

const PROACTIVE_PREFIX = "ai.proactive.";

const proactiveTypes = NOTIFICATION_REGISTRY.map((def) => def.type).filter(
  (type) => type.startsWith(PROACTIVE_PREFIX)
);

describe("ai.proactive.* never counts in Needs-you (D2)", () => {
  it("the scan sees the proactive family (non-vacuity)", () => {
    // Seven today: morning_briefing, weekly_digest, health_check, insight,
    // nudge, suggestion, alert. A floor of 5 fails loudly if the prefix
    // drifts or the registry import stops resolving.
    expect(proactiveTypes.length).toBeGreaterThanOrEqual(5);
    expect(proactiveTypes).toContain("ai.proactive.alert");
  });

  it.each(proactiveTypes)("%s resolves to the 'suggestion' role", (type) => {
    expect(needsYouRole(type)).toBe("suggestion");
  });
});
