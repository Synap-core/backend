import { describe, expect, it } from "vitest";
import { unlinkSignInNotice } from "./unlink-impact";

describe("unlinkSignInNotice — the lockout is stated only when it is a fact", () => {
  it("says there is no way to sign in only for no_way_in", () => {
    expect(unlinkSignInNotice("no_way_in", true, "ada@example.test")).toEqual({
      tone: "danger",
      text: expect.stringContaining("they have no way to sign in"),
    });
    for (const impact of [
      "keeps_a_way_in",
      "email_recovery_only",
      "unknown",
    ] as const) {
      expect(
        unlinkSignInNotice(impact, true, "ada@example.test")?.text ?? ""
      ).not.toContain("no way to sign in");
    }
  });

  it("says nothing when they keep a password, passkey or recovery code", () => {
    expect(unlinkSignInNotice("keeps_a_way_in", true, "ada")).toBeNull();
  });

  it("names email recovery as the only way back when that is the fact", () => {
    expect(unlinkSignInNotice("email_recovery_only", true, "ada")).toEqual({
      tone: "warning",
      text: expect.stringContaining(
        "only by recovering their account by email"
      ),
    });
  });

  it("a failed read says it could not check, never a calm nothing", () => {
    expect(unlinkSignInNotice("unknown", true, "ada")?.text).toContain(
      "We couldn't check"
    );
  });

  it("another issuer's unlink takes no sign-in method: no callout", () => {
    expect(unlinkSignInNotice("no_way_in", false, "ada")).toBeNull();
  });
});
