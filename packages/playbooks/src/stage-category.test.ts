/**
 * PlaybookStage category resolution — the BACKWARD-COMPATIBILITY half.
 *
 * `resolveStageCategory` is the ONE place a stage's rollup category is
 * defaulted. It is pure (no zod), so it lives with the type in this
 * dependency-free contract package; the zod WRITE-boundary schema is tested at
 * the door in @synap/api (src/schemas/playbook-stage.test.ts).
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLAYBOOK_STAGE_CATEGORY,
  PLAYBOOK_STAGE_CATEGORIES,
  resolveStageCategory,
  type PlaybookStage,
} from "./index.js";

const validStage = { key: "qualify", name: "Qualify", category: "started" };

describe("resolveStageCategory — backward compatibility", () => {
  it("resolves a legacy category-less stage to the documented default", () => {
    // Exactly the shape stored before the category existed.
    const legacy = { key: "nurture", name: "Nurture", goal: "Warm the lead" };
    expect(resolveStageCategory(legacy)).toBe("started");
    expect(resolveStageCategory(legacy)).toBe(DEFAULT_PLAYBOOK_STAGE_CATEGORY);
  });

  it("does not throw on anything a jsonb column can hold", () => {
    for (const junk of [undefined, null, {}, [], "started", 42]) {
      expect(() => resolveStageCategory(junk)).not.toThrow();
      expect(resolveStageCategory(junk)).toBe(DEFAULT_PLAYBOOK_STAGE_CATEGORY);
    }
  });

  it("returns the DECLARED category when one is present", () => {
    for (const category of PLAYBOOK_STAGE_CATEGORIES) {
      expect(resolveStageCategory({ ...validStage, category })).toBe(category);
    }
  });

  it("falls back rather than trusting an unknown stored category string", () => {
    expect(
      resolveStageCategory({ ...validStage, category: "in-progress" })
    ).toBe(DEFAULT_PLAYBOOK_STAGE_CATEGORY);
  });
});

describe("PlaybookStage interface", () => {
  it("still permits a category-less stage (legacy stored rows)", () => {
    const legacy: PlaybookStage = { key: "nurture", name: "Nurture" };
    expect(resolveStageCategory(legacy)).toBe(DEFAULT_PLAYBOOK_STAGE_CATEGORY);
  });
});
