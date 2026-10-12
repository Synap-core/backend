/**
 * The row's density step and the being-worked phrase — one rule for web and
 * relay. Fixture rows where a naive rule disagrees: a `happened` row asked at
 * `lens` density (a naive "density wins" rule says roomy).
 */
import { describe, expect, it } from "vitest";
import { LENS_ROW_STEP, lensBeingWorkedLabel, lensRowStep } from "./rows.js";

describe("lens row density", () => {
  it("maps nav · index · lens onto the compact · default · roomy token steps", () => {
    expect(LENS_ROW_STEP).toEqual({
      nav: "compact",
      index: "default",
      lens: "roomy",
    });
  });

  it("a happened row is compact at every density", () => {
    expect(lensRowStep("lens", "happened")).toBe("compact");
    expect(lensRowStep("index", "happened")).toBe("compact");
    expect(lensRowStep("lens", "blocking")).toBe("roomy");
    expect(lensRowStep("index", "happening")).toBe("default");
  });
});

describe("lensBeingWorkedLabel", () => {
  it("names the agent when known, else says an agent", () => {
    expect(lensBeingWorkedLabel({ by: "Writer" })).toBe(
      "Writer is working on this"
    );
    expect(lensBeingWorkedLabel({ by: null })).toBe(
      "An agent is working on this"
    );
    expect(lensBeingWorkedLabel({})).toBe("An agent is working on this");
  });
});
