import { describe, expect, it } from "vitest";
import {
  DEPRECATED_IN_HOSTS,
  deprecatedInHost,
  isDeprecatedInHost,
} from "../hosts/index.js";
import {
  DEPRECATED_SURFACES,
  deprecatedSurfacesFor,
  isDeprecatedSurface,
} from "./index.js";

// The host-app registry moved to `@synap-core/types/hosts` (founder, 23 Nov
// 2026: "surface" means UI anchored to an object). Its old names, still
// imported by browser and relay, answer exactly as the new ones.
describe("the old surfaces names are aliases of the hosts registry", () => {
  it("is the same registry", () => {
    expect(DEPRECATED_SURFACES).toBe(DEPRECATED_IN_HOSTS);
    expect(DEPRECATED_SURFACES.length).toBeGreaterThanOrEqual(8);
  });

  it("answers as the new functions", () => {
    expect(deprecatedSurfacesFor("relay")).toEqual(deprecatedInHost("relay"));
    expect(deprecatedSurfacesFor("browser").length).toBeGreaterThan(0);
    expect(isDeprecatedSurface("browser", "governance")).toBe(
      isDeprecatedInHost("browser", "governance")
    );
    expect(isDeprecatedSurface("browser", "governance")).toBe(true);
    expect(isDeprecatedSurface("browser", "sessions")).toBe(false);
  });
});
