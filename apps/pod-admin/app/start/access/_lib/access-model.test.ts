import { describe, expect, it } from "vitest";
import { accessContinue } from "./access-model";

describe("accessContinue", () => {
  it("two ways in: Continue", () => {
    expect(
      accessContinue({ kind: "ready", count: 2, enforce: true, enough: true })
    ).toBe("continue");
  });
  it("fewer than two: Skip for now, so the step never pretends it is done", () => {
    expect(
      accessContinue({ kind: "ready", count: 1, enforce: true, enough: false })
    ).toBe("skip");
  });
  it("GUARDRAIL: an unknown or failed count is never 'enough'", () => {
    expect(accessContinue({ kind: "failed" })).toBe("skip");
    expect(accessContinue({ kind: "loading" })).toBe("skip");
  });
});
