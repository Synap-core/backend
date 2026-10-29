/**
 * The repair projection of a FAILED entity proposal (decision fa6c8833): what
 * the relay, browser and pod-admin cards draw. Drives the REAL
 * `describeProposalRepair` → the REAL `PropertyValidationService`, with the
 * kind's schema stubbed at the `ProfileResolutionService` boundary.
 *
 * The motivating row: proposal e368ca9e, `uo_category: "preference"` on a
 * field that allows `preferences`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProfileResolutionService,
  type EffectiveProperty,
} from "@synap/database";
import { describeProposalRepair } from "./repair-options.js";

const CATEGORIES = [
  "working_style",
  "communication",
  "focus",
  "preferences",
  "habits",
  "technical",
];

function field(
  slug: string,
  overrides: Partial<EffectiveProperty> = {}
): EffectiveProperty {
  return {
    id: `def-${slug}`,
    slug,
    valueType: "string",
    required: false,
    defaultValue: null,
    displayOrder: 0,
    isLifecycle: false,
    constraints: {},
    uiHints: {},
    ...overrides,
  } as unknown as EffectiveProperty;
}

function failedCreate(
  properties: Record<string, unknown>,
  status = "approval_failed"
) {
  return {
    id: "e368ca9e",
    status,
    targetType: "entity",
    targetId: "t1",
    proposalType: "create",
    workspaceId: null,
    data: {
      data: {
        profileSlug: "user_observation",
        title: "Founder working preference",
        properties,
      },
      failure: { errorClass: "validation" },
    },
  };
}

function stubSchema(fields: EffectiveProperty[]) {
  vi.spyOn(
    ProfileResolutionService.prototype,
    "resolveProfile"
  ).mockResolvedValue({ id: "profile-uo", defaultValues: {} } as never);
  vi.spyOn(
    ProfileResolutionService.prototype,
    "getEffectiveProperties"
  ).mockResolvedValue(fields);
}

afterEach(() => vi.restoreAllMocks());

describe("describeProposalRepair", () => {
  it("names the field, the value it refused and the one it meant", async () => {
    stubSchema([
      field("uo_category", {
        constraints: { enum: CATEGORIES },
        uiHints: { displayName: "Category" },
      }),
    ]);
    const repair = await describeProposalRepair(
      failedCreate({ uo_category: "preference" }),
      "user-1"
    );
    expect(repair).toEqual({
      proposalId: "e368ca9e",
      repairable: true,
      fields: [
        {
          key: "uo_category",
          label: "Category",
          kind: "not_in_options",
          message: expect.stringContaining("not in enum"),
          rejected: ["preference"],
          options: CATEGORIES,
          didYouMean: "preferences",
          canAddOption: false,
          addOptionRefusal: "close_match",
        },
      ],
    });
  });

  it("offers to add a value no allowed one is close to", async () => {
    stubSchema([field("uo_category", { constraints: { enum: CATEGORIES } })]);
    const repair = await describeProposalRepair(
      failedCreate({ uo_category: "rituals" }),
      "user-1"
    );
    expect(repair.fields[0]).toMatchObject({
      rejected: ["rituals"],
      canAddOption: true,
    });
    expect(repair.fields[0]!.didYouMean).toBeUndefined();
  });

  it("never offers to grow the kind's status field", async () => {
    stubSchema([
      field("status", {
        constraints: { enum: ["open", "done"] },
        isLifecycle: true,
      }),
    ]);
    const repair = await describeProposalRepair(
      failedCreate({ status: "archived" }),
      "user-1"
    );
    expect(repair.fields[0]).toMatchObject({
      canAddOption: false,
      addOptionRefusal: "lifecycle",
    });
  });

  it("is not repairable once the payload is valid against the kind as it is now", async () => {
    stubSchema([field("uo_category", { constraints: { enum: CATEGORIES } })]);
    const repair = await describeProposalRepair(
      failedCreate({ uo_category: "preferences" }),
      "user-1"
    );
    expect(repair).toEqual({
      proposalId: "e368ca9e",
      repairable: false,
      fields: [],
    });
  });

  it("names a kind that no longer resolves", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "resolveProfile"
    ).mockResolvedValue(null);
    const repair = await describeProposalRepair(
      failedCreate({ uo_category: "x" }),
      "user-1"
    );
    expect(repair).toMatchObject({
      repairable: false,
      missingKind: "user_observation",
    });
  });

  it("reads nothing for a decided proposal or another kind of proposal", async () => {
    const spy = vi.spyOn(ProfileResolutionService.prototype, "resolveProfile");
    expect(
      (await describeProposalRepair(failedCreate({}, "approved"), "u"))
        .repairable
    ).toBe(false);
    expect(
      (
        await describeProposalRepair(
          { ...failedCreate({}), targetType: "playbook" },
          "u"
        )
      ).repairable
    ).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
