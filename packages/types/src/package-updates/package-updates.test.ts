import { describe, expect, it } from "vitest";
import {
  applyPackageUpdateInputSchema,
  contentHashVersion,
  countPackageFields,
  derivePackageUpdateNeeds,
  deriveWholePackageNeeds,
  packageHasUpdate,
  packageUpdateComparedBy,
  packageUpdateReviewPath,
  INSTALLED_PACKAGE_KINDS,
  RENDERER_BUNDLE_SOAK_MS,
  pausePackageUpdatesInputSchema,
} from "./index.js";

describe("packageHasUpdate — THE rule, every kind, every surface", () => {
  it("content-hash versions: any difference is an update (the 2 Nov case)", () => {
    expect(packageHasUpdate("h-ee6503", "h-336546")).toBe(true);
    expect(packageHasUpdate("h-336546", "h-336546")).toBe(false);
  });

  it("a hand-authored semver: only a strictly newer catalog version", () => {
    expect(packageHasUpdate("1.2.0", "1.10.0")).toBe(true);
    expect(packageHasUpdate("1.10.0", "1.2.0")).toBe(false);
    expect(packageHasUpdate("v2.0", "2.0.0")).toBe(false);
  });

  it("no stamp or no catalog version is never an update", () => {
    expect(packageHasUpdate(null, "h-1")).toBe(false);
    expect(packageHasUpdate("h-1", null)).toBe(false);
    expect(packageHasUpdate(undefined, undefined)).toBe(false);
  });

  it("puts a capability's full content hash in the catalog's version form", () => {
    const full = "0123456789abcdef".repeat(4);
    expect(contentHashVersion(full)).toBe("h-0123456789ab");
    expect(contentHashVersion("h-0123456789ab")).toBe("h-0123456789ab");
    expect(contentHashVersion(null)).toBeNull();
    expect(packageHasUpdate(contentHashVersion(full), "h-0123456789ab")).toBe(
      false
    );
  });

  it("a space or a capability is updated as a whole, needing consent only for records", () => {
    expect(packageUpdateComparedBy("workspace")).toBe("package");
    expect(packageUpdateComparedBy("capability")).toBe("package");
    expect(packageUpdateComparedBy("skill")).toBe("field");
    expect(deriveWholePackageNeeds(0)).toBe("review");
    expect(deriveWholePackageNeeds(2)).toBe("consent");
  });
});

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

  // A renderer bundle is applied as a whole through its own install door.
  it("a renderer bundle is an installed kind, updated as a whole", () => {
    expect(INSTALLED_PACKAGE_KINDS).toContain("renderer-bundle");
    expect(packageUpdateComparedBy("renderer-bundle")).toBe("package");
    expect(RENDERER_BUNDLE_SOAK_MS).toEqual({
      fast: 60 * 60 * 1000,
      stable: 24 * 60 * 60 * 1000,
    });
    expect(
      pausePackageUpdatesInputSchema.safeParse({
        slug: "synap-renderers",
        paused: true,
      }).success
    ).toBe(true);
    expect(
      pausePackageUpdatesInputSchema.safeParse({ slug: "", paused: true })
        .success
    ).toBe(false);
  });

  it("the review path is the pod's /open bounce", () => {
    expect(packageUpdateReviewPath("facecam-edit")).toBe(
      "/open/update/facecam-edit"
    );
  });
});
