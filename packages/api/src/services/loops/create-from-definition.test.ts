import { describe, expect, it } from "vitest";
import { resolveLoopApplySource } from "./create-from-definition.js";

describe("resolveLoopApplySource", () => {
  it("keeps a human template installation synchronous", () => {
    expect(resolveLoopApplySource(undefined)).toBe("user");
    expect(resolveLoopApplySource(null)).toBe("user");
  });

  it("keeps an agent template installation under AI governance", () => {
    expect(resolveLoopApplySource("agent-user-id")).toBe("agent");
  });
});
