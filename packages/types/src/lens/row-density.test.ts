/**
 * The row's density step and the being-worked phrase — one rule for web and
 * relay. Fixture rows where a naive rule disagrees: a `happened` row asked at
 * `lens` density (a naive "density wins" rule says roomy).
 */
import { describe, expect, it } from "vitest";
import {
  LENS_ROW_STEP,
  lensBeingWorkedLabel,
  lensBeingWorkedOf,
  lensRowStep,
} from "./rows.js";

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

describe("lensBeingWorkedOf", () => {
  it("only a LIVE session marks a thing; the live one is the door", () => {
    expect(lensBeingWorkedOf(undefined)).toBeNull();
    expect(lensBeingWorkedOf([])).toBeNull();
    // An open but idle session is NOT being worked (a naive "any entry" rule says it is).
    expect(
      lensBeingWorkedOf([{ sessionId: "s1", kind: "session", live: false }])
    ).toBeNull();
    expect(
      lensBeingWorkedOf([
        { sessionId: "s1", kind: "session", live: false },
        { sessionId: "s2", kind: "worker", live: true },
      ])
    ).toEqual({ sessionId: "s2" });
  });
});
