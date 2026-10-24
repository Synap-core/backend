import { describe, it, expect } from "vitest";
import { SIGN_IN_WAY_LABELS, resolveSignInWayLabel } from "./index.js";

describe("resolveSignInWayLabel — the ways to make a pod account", () => {
  it("names each way as a chip noun and as a button action", () => {
    expect(resolveSignInWayLabel("passkey")).toBe("Passkey");
    expect(resolveSignInWayLabel("password", "action")).toBe(
      "Create a password"
    );
    expect(resolveSignInWayLabel("synap_cloud", "action")).toBe(
      "Continue with Synap Cloud"
    );
    expect(Object.keys(SIGN_IN_WAY_LABELS)).toEqual([
      "passkey",
      "password",
      "synap_cloud",
    ]);
  });

  it("humanizes an unknown way instead of leaking it, and is empty for none", () => {
    expect(resolveSignInWayLabel("magic_link")).toBe("Magic link");
    expect(resolveSignInWayLabel("")).toBe("");
    expect(resolveSignInWayLabel(null)).toBe("");
  });
});
