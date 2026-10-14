import { describe, it, expect } from "vitest";
import { projectInitials } from "./initials.js";

describe("projectInitials", () => {
  it("takes the first letters of the FIRST TWO words", () => {
    expect(projectInitials("Launch The Architech")).toBe("LT");
    expect(projectInitials("  growth   sprint ")).toBe("GS");
  });

  it("takes the first two letters of a single word", () => {
    expect(projectInitials("synap")).toBe("SY");
    expect(projectInitials("X")).toBe("X");
  });

  it("is never empty", () => {
    expect(projectInitials("")).toBe("P");
    expect(projectInitials("   ")).toBe("P");
    expect(projectInitials(null)).toBe("P");
    expect(projectInitials(undefined)).toBe("P");
  });
});
