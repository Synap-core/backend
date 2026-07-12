/**
 * validateDeps — the npm-package-name/version guard `/cells/define` enforces
 * via zod, reused by `/cells/install` for marketplace-sourced deps (Wave 1
 * door repair: the install path never passed through that schema).
 */

import { describe, it, expect } from "vitest";
import { validateDeps } from "./cells.js";

describe("validateDeps", () => {
  it("accepts undefined deps", () => {
    expect(validateDeps(undefined)).toBeNull();
  });

  it("accepts a valid scoped and unscoped package name + semver range", () => {
    expect(
      validateDeps({ "@synap-core/spatial-ui": "^1.2.0", lodash: "latest" })
    ).toBeNull();
  });

  it("rejects a package name containing a URL/protocol", () => {
    expect(validateDeps({ "https://evil.example/pkg": "1.0.0" })).toMatch(
      /Invalid package name/
    );
  });

  it("rejects a blank version string", () => {
    expect(validateDeps({ lodash: "" })).toMatch(/Invalid version string/);
  });

  it("rejects more than 30 dep entries", () => {
    const deps = Object.fromEntries(
      Array.from({ length: 31 }, (_, i) => [`pkg-${i}`, "1.0.0"])
    );
    expect(validateDeps(deps)).toMatch(/at most 30 entries/);
  });
});
