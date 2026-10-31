import { describe, expect, it } from "vitest";
import {
  applyPackageUpdateInputSchema,
  countPackageFields,
  derivePackageUpdateNeeds,
  packageUpdateReviewPath,
} from "./index.js";

describe("package updates contract", () => {
  it("counts fields per state", () => {
    expect(
      countPackageFields([
        { state: "both" },
        { state: "same" },
        { state: "same" },
      ])
    ).toEqual({ updates: 0, yours: 0, both: 1, same: 2 });
  });

  it("an update needs the most urgent thing any field needs", () => {
    const c = { updates: 1, yours: 1, both: 1, same: 0 };
    expect(derivePackageUpdateNeeds(c, 2)).toBe("consent");
    expect(derivePackageUpdateNeeds(c)).toBe("choice");
    expect(derivePackageUpdateNeeds({ ...c, both: 0 })).toBe("review");
    expect(
      derivePackageUpdateNeeds({ updates: 0, yours: 3, both: 0, same: 1 })
    ).toBe("nothing");
  });

  it("accepts named choices and a value, and refuses anything else", () => {
    const ok = applyPackageUpdateInputSchema.parse({
      slug: "facecam-edit",
      expectedVersion: "h-2",
      choices: { "a:body": "catalog", "a:name": { value: "Mine" } },
    });
    expect(ok.choices["a:name"]).toEqual({ value: "Mine" });
    expect(
      applyPackageUpdateInputSchema.safeParse({
        slug: "x",
        expectedVersion: "h",
        choices: { "a:body": "theirs" },
      }).success
    ).toBe(false);
  });

  it("the review path is the pod's /open bounce", () => {
    expect(packageUpdateReviewPath("facecam-edit")).toBe(
      "/open/update/facecam-edit"
    );
  });
});
