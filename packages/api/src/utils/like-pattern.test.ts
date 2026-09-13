import { describe, it, expect } from "vitest";
import { escapeLikePattern } from "./like-pattern.js";

describe("escapeLikePattern", () => {
  it("escapes both wildcards so they match literally", () => {
    expect(escapeLikePattern("50%")).toBe("50\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
  });

  it("escapes the escape character itself — the one a hand copy forgets", () => {
    // Without this, a typed backslash would escape whatever follows it and
    // silently change the pattern.
    expect(escapeLikePattern("C:\\path")).toBe("C:\\\\path");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLikePattern("Production readiness sweep")).toBe(
      "Production readiness sweep"
    );
  });
});
