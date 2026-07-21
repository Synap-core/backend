import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ProfileResolutionService,
  type EffectiveProperty,
} from "../profile-resolution-service.js";
import { PropertyValidationService } from "../property-validation-service.js";
import { PropertyValueType } from "../../schema/property-defs.js";

/** Minimal EffectiveProperty for the validator (only the fields it reads). */
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
    ...overrides,
  } as unknown as EffectiveProperty;
}

/**
 * `validateEntityCreateForProposal` is the PROPOSE-TIME preflight — the SAME
 * required-property validation the materializer (`EntityRepository.create`) runs,
 * invoked BEFORE a proposal is filed so a structurally un-materializable
 * entity-create is rejected at submit instead of failing when the human approves.
 * Effective properties are stubbed at the service boundary (no DB needed).
 */
describe("PropertyValidationService.validateEntityCreateForProposal", () => {
  let svc: PropertyValidationService;

  beforeEach(() => {
    vi.restoreAllMocks();
    svc = new PropertyValidationService(
      new ProfileResolutionService({} as any)
    );
  });

  it("flags a missing required property — the file/storageKey bug that used to surface only at approve", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveProperties"
    ).mockResolvedValue([prop("storageKey", { required: true })]);

    const res = await svc.validateEntityCreateForProposal(
      {},
      "profile-file",
      "ws-1",
      { title: "screenshot.png" }
    );

    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("'storageKey' is required"))).toBe(
      true
    );
  });

  it("passes once the required property is present", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveProperties"
    ).mockResolvedValue([prop("storageKey", { required: true })]);

    const res = await svc.validateEntityCreateForProposal(
      { storageKey: "artifacts/abc.png" },
      "profile-file",
      "ws-1",
      { title: "screenshot.png" }
    );

    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("does NOT false-flag a required property satisfied by the profile's defaultValues (matches the materialize-time merge)", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveProperties"
    ).mockResolvedValue([prop("status", { required: true })]);

    const res = await svc.validateEntityCreateForProposal({}, "p", "ws-1", {
      profileDefaults: { status: "open" },
    });

    expect(res.valid).toBe(true);
  });

  it("does NOT false-flag a required `title` def satisfied by the entity-level title", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveProperties"
    ).mockResolvedValue([prop("title", { required: true })]);

    const res = await svc.validateEntityCreateForProposal({}, "p", "ws-1", {
      title: "My Document",
    });

    expect(res.valid).toBe(true);
  });
});
