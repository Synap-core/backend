import { describe, it, expect } from "vitest";
import { classifySettingSensitivity } from "./index.js";

/**
 * The settings-door sensitivity ladder: loosening → always a human decision
 * (propose), tightening → auto (safe), benign → trust-scaled. The classifier is
 * conservative — anything it cannot confidently call tightening/benign is
 * loosening, so under-classifying (auto-applying a loosening) is impossible.
 */
describe("classifySettingSensitivity", () => {
  it("setting/raising a ceiling is loosening (always human)", () => {
    expect(
      classifySettingSensitivity({ store: "governance_ceilings", op: "set" })
    ).toBe("loosening");
  });

  it("widen a rule to `auto` is loosening", () => {
    expect(
      classifySettingSensitivity({
        store: "governance_rules",
        op: "set",
        spec: { verdict: "auto" },
      })
    ).toBe("loosening");
  });

  it("tighten a rule to `propose` is tightening", () => {
    expect(
      classifySettingSensitivity({
        store: "governance_rules",
        op: "set",
        spec: { verdict: "propose" },
      })
    ).toBe("tightening");
  });

  it("a guideline with posture:auto is loosening", () => {
    expect(
      classifySettingSensitivity({
        store: "config_settings",
        op: "set",
        spec: { posture: "auto" },
      })
    ).toBe("loosening");
  });

  it("plain guideline text is benign", () => {
    expect(
      classifySettingSensitivity({
        store: "config_settings",
        op: "set",
        spec: {},
      })
    ).toBe("benign");
  });

  it("any revoke is loosening (safe default — a revoke can loosen or tighten)", () => {
    expect(
      classifySettingSensitivity({ store: "governance_rules", op: "revoke" })
    ).toBe("loosening");
    expect(
      classifySettingSensitivity({ store: "config_settings", op: "revoke" })
    ).toBe("loosening");
  });

  it("an unknown store falls to loosening (safe default)", () => {
    expect(
      classifySettingSensitivity({ store: "bogus" as never, op: "set" })
    ).toBe("loosening");
  });
});
