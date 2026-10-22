import { describe, expect, it } from "vitest";
import { unlinkSignInNotice } from "./unlink-impact";

describe("unlinkSignInNotice — the lockout is marked only when it is a fact", () => {
  it("marks no way in only for no_way_in", () => {
    expect(unlinkSignInNotice("no_way_in", true, "ada")).toMatchObject({
      kind: "down",
      label: "No way in",
    });
    for (const impact of ["email_recovery_only", "unknown"] as const) {
      const notice = unlinkSignInNotice(impact, true, "ada");
      expect(notice?.kind).not.toBe("down");
      expect(notice?.label).not.toBe("No way in");
    }
  });

  it("marks nothing when they keep a password, passkey or recovery code", () => {
    expect(unlinkSignInNotice("keeps_a_way_in", true, "ada")).toBeNull();
  });

  it("names email recovery as the way back when that is the fact", () => {
    expect(
      unlinkSignInNotice("email_recovery_only", true, "ada")
    ).toMatchObject({
      kind: "stale",
      sentence: expect.stringContaining("recovering by email"),
    });
  });

  it("a failed read says it could not check, never a calm nothing", () => {
    expect(unlinkSignInNotice("unknown", true, "ada")).toMatchObject({
      kind: "unknown",
      sentence: expect.stringContaining("couldn't check"),
    });
  });

  it("another issuer's unlink takes no sign-in method: no mark", () => {
    expect(unlinkSignInNotice("no_way_in", false, "ada")).toBeNull();
  });
});
