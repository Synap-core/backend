import { describe, expect, it, vi } from "vitest";

vi.mock("@synap-core/core", () => ({
  config: { server: { localMode: false } },
}));

import { isLocalShellAllowed, LOCAL_SHELL_ENV } from "./local-shell-switch.js";

/**
 * The pod-level switch for a shell on the pod host (pre-launch audit
 * 2026-10-28, F2). Off unless the pod is the embedded local pod or the
 * operator set SYNAP_LOCAL_TERMINAL to exactly "1".
 */
describe("isLocalShellAllowed", () => {
  it("is off for a pod started like the cloud compose (no LOCAL_MODE, no switch)", () => {
    expect(isLocalShellAllowed({}, false)).toBe(false);
    // The default reads the real config + process env: off in this test.
    expect(isLocalShellAllowed()).toBe(false);
  });

  it("is on for the embedded local pod", () => {
    expect(isLocalShellAllowed({}, true)).toBe(true);
  });

  it("is on only for the exact string 1", () => {
    expect(isLocalShellAllowed({ [LOCAL_SHELL_ENV]: "1" }, false)).toBe(true);
    for (const value of ["true", "false", "0", "yes", " 1", ""]) {
      expect(isLocalShellAllowed({ [LOCAL_SHELL_ENV]: value }, false)).toBe(
        false
      );
    }
  });
});
