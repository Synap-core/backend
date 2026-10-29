import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ProfileResolutionService,
  type EffectiveProperty,
} from "../profile-resolution-service.js";
import { PropertyValidationService } from "../property-validation-service.js";
import { PropertyValueType } from "../../schema/property-defs.js";

/**
 * `issues` is the STRUCTURED twin of `errors`: what a failed proposal's repair
 * card is drawn from (`services/proposals/repair-options.ts` in @synap/api).
 * The case that motivated it (decision fa6c8833): `uo_category: "preference"`
 * on a field that allows `preferences` — five founder preferences failed at
 * approve, and the card had only a sentence to show.
 */
function prop(
  slug: string,
  overrides: Partial<EffectiveProperty> = {}
): EffectiveProperty {
  return {
    slug,
    valueType: PropertyValueType.STRING,
    required: false,
    defaultValue: null,
    constraints: {},
    displayOrder: 0,
    isLifecycle: false,
    ...overrides,
  } as unknown as EffectiveProperty;
}

const CATEGORIES = [
  "working_style",
  "communication",
  "focus",
  "preferences",
  "habits",
  "technical",
];

describe("PropertyValidationService — structured issues", () => {
  let svc: PropertyValidationService;

  beforeEach(() => {
    vi.restoreAllMocks();
    svc = new PropertyValidationService(
      new ProfileResolutionService({} as any)
    );
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveProperties"
    ).mockResolvedValue([
      prop("uo_category", { constraints: { enum: CATEGORIES } }),
      prop("tags", {
        valueType: PropertyValueType.ARRAY,
        constraints: { enum: ["a", "b"] },
      }),
      prop("summary", { constraints: { maxLength: 5 } }),
      prop("storageKey", { required: true }),
    ]);
  });

  it("names the rejected value and the allowed one it meant", async () => {
    const res = await svc.validateEntityCreateForProposal(
      { uo_category: "preference", storageKey: "k" },
      "p",
      null
    );
    expect(res.valid).toBe(false);
    expect(res.issues).toEqual([
      {
        key: "uo_category",
        kind: "not_in_options",
        message: expect.stringContaining("not in enum"),
        rejected: ["preference"],
        didYouMean: "preferences",
      },
    ]);
  });

  it("lists every rejected element of a multi-value field, with no guess", async () => {
    const res = await svc.validateProperties(
      { tags: ["a", "x", "y"] },
      "p",
      null,
      { enforceRequired: false }
    );
    expect(res.issues).toEqual([
      {
        key: "tags",
        kind: "not_in_options",
        message: expect.any(String),
        rejected: ["x", "y"],
      },
    ]);
  });

  it("keeps a missing required field and a broken limit apart from a closed set", async () => {
    const res = await svc.validateEntityCreateForProposal(
      { summary: "too long" },
      "p",
      null
    );
    expect(res.issues.map((i) => [i.key, i.kind])).toEqual([
      ["storageKey", "required"],
      ["summary", "invalid"],
    ]);
    // One issue per error: the two lists describe the same refusals.
    expect(res.issues.map((i) => i.message)).toEqual(res.errors);
  });

  it("is empty when the write is valid", async () => {
    const res = await svc.validateEntityCreateForProposal(
      { uo_category: "preferences", storageKey: "k" },
      "p",
      null
    );
    expect(res.valid).toBe(true);
    expect(res.issues).toEqual([]);
  });
});
