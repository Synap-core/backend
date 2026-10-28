/** Every review package, grouping and layout has its words (the floor). */
import { describe, expect, it } from "vitest";
import {
  REVIEW_GROUP_BYS,
  REVIEW_LAYOUTS,
  REVIEW_PACKAGES,
} from "../proposals/review-package.js";
import {
  REVIEW_GROUP_BY_LABELS,
  REVIEW_LAYOUT_LABELS,
  REVIEW_PACKAGE_LABELS,
  resolveReviewPackageLabel,
} from "./index.js";

describe("review words", () => {
  it("every package, grouping and layout has a row — and nothing else does", () => {
    expect(Object.keys(REVIEW_PACKAGE_LABELS).sort()).toEqual(
      [...REVIEW_PACKAGES].sort()
    );
    expect(Object.keys(REVIEW_GROUP_BY_LABELS).sort()).toEqual(
      [...REVIEW_GROUP_BYS].sort()
    );
    expect(Object.keys(REVIEW_LAYOUT_LABELS).sort()).toEqual(
      [...REVIEW_LAYOUTS].sort()
    );
  });
  it("names the founder's packages, and an unknown one humanizes", () => {
    expect(resolveReviewPackageLabel("data-changes")).toBe(
      "Changes to your data"
    );
    expect(resolveReviewPackageLabel("access")).toBe("Access & secrets");
    expect(resolveReviewPackageLabel("new_pkg")).toBe("New pkg");
  });
});
