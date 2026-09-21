/**
 * `users.updateFeedPreferences` must accept the USER'S OWN vocabulary.
 *
 * `persona` and `goal` used to be closed `z.enum`s of seven / five hardcoded
 * domain strings, so a user who is a teacher, a vigneron or a solo-dev was
 * REJECTED with a 400 at the API boundary — the exact opposite of the
 * agnosticity Synap sells. They are now bounded free strings.
 *
 * SEAM: these assertions drive the ROUTER'S OWN declared input parser
 * (`_def.procedures.updateFeedPreferences._def.inputs[0]`), not a hand-rebuilt
 * copy of the schema — so loosening the validator in the test file alone could
 * never make them pass.
 */

import { describe, it, expect } from "vitest";
import type { ZodTypeAny } from "zod";
import { usersRouter } from "./users.js";

/** The real input parser tRPC will run on the wire payload. */
function updateFeedPreferencesInput(): ZodTypeAny {
  const proc = (
    usersRouter as unknown as {
      _def: {
        procedures: Record<string, { _def: { inputs: ZodTypeAny[] } }>;
      };
    }
  )._def.procedures.updateFeedPreferences;
  const parser = proc?._def?.inputs?.[0];
  // Non-vacuity: if tRPC ever stops exposing the parser here, this test must
  // fail loudly rather than silently assert nothing.
  if (
    !parser ||
    typeof (parser as { safeParse?: unknown }).safeParse !== "function"
  ) {
    throw new Error(
      "updateFeedPreferences input parser not reachable — this guard is blind, fix the accessor"
    );
  }
  return parser;
}

const basePrefs = {
  interests: ["ai"],
  dislikedTopics: [],
  frequency: "hourly" as const,
  sources: [],
  relevanceThreshold: 50,
  notifications: true,
  autoCreateEntities: false,
  onboardingCompleted: true,
};

const parse = (preferences: Record<string, unknown>) =>
  updateFeedPreferencesInput().safeParse({ preferences });

describe("users.updateFeedPreferences — persona is the user's own word", () => {
  it("accepts a persona outside the old seven-value enum", () => {
    // The discriminating input: rejected by the enum, accepted by a free string.
    for (const persona of [
      "teacher",
      "vigneron",
      "solo-dev",
      "Chief of Staff",
    ]) {
      const r = parse({ ...basePrefs, persona });
      expect(r.success, `persona ${persona} should be accepted`).toBe(true);
    }
  });

  it("still accepts every persona the old enum allowed (no regression)", () => {
    for (const persona of [
      "cto",
      "marketing",
      "sales",
      "project-manager",
      "founder",
      "researcher",
      "general",
    ]) {
      expect(parse({ ...basePrefs, persona }).success).toBe(true);
    }
  });

  it("accepts a goal outside the old five-value enum, and the old ones", () => {
    for (const goal of [
      "harvest-planning", // never in the enum
      "teach-better", // never in the enum
      "trend-monitoring", // was in the enum
      "startup-leads", // was in the enum
    ]) {
      expect(parse({ ...basePrefs, persona: "general", goal }).success).toBe(
        true
      );
    }
  });

  it("goal stays optional", () => {
    expect(parse({ ...basePrefs, persona: "general" }).success).toBe(true);
  });

  it("is still BOUNDED — empty/blank and over-long are rejected", () => {
    // Free does not mean unvalidated: persisted into a JSONB preferences blob,
    // so it keeps a length cap and must not be blank.
    expect(parse({ ...basePrefs, persona: "" }).success).toBe(false);
    expect(parse({ ...basePrefs, persona: "   " }).success).toBe(false);
    expect(parse({ ...basePrefs, persona: "x".repeat(65) }).success).toBe(
      false
    );
    expect(
      parse({ ...basePrefs, persona: "general", goal: "x".repeat(65) }).success
    ).toBe(false);
  });

  it("trims surrounding whitespace before persisting", () => {
    const r = parse({ ...basePrefs, persona: "  vigneron  " });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(
        (r.data as { preferences: { persona: string } }).preferences.persona
      ).toBe("vigneron");
    }
  });

  it("persona is still required", () => {
    expect(parse({ ...basePrefs }).success).toBe(false);
  });
});
