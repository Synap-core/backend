import { describe, expect, it } from "vitest";
import {
  accountLinkRequesterView,
  accountLinkReview,
} from "./requester-account";

const VERIFIED = {
  status: "verified" as const,
  email: "ada@example.test",
  issuerHost: "api.synap.live",
  issuerName: null,
  verifiedAt: "2026-10-19T20:00:00.000Z",
};
const MEMBER = { name: "Ada Lovelace", email: "ada@example.test" };

describe("accountLinkReview", () => {
  it("asks whether the verified account may sign in as the member", () => {
    const review = accountLinkReview(VERIFIED, MEMBER);
    expect(review.heading).toBe(
      "Let ada@example.test sign in as Ada Lovelace?"
    );
    expect(review.body).toBe(
      "They'll see and do everything Ada Lovelace can on this Pod."
    );
    expect(review.account).toEqual({
      verified: true,
      title: "ada@example.test",
      mark: "Verified",
      tone: "success",
      verifiedBy: "Verified by api.synap.live",
    });
    expect(review.differentEmail).toBe(false);
  });

  it("names the issuer by its Pod name when it has one", () => {
    expect(
      accountLinkReview({ ...VERIFIED, issuerName: "Synap" }, MEMBER).account
        .verifiedBy
    ).toBe("Verified by Synap");
  });

  it("flags a member address that differs from the account's", () => {
    expect(
      accountLinkReview(VERIFIED, { name: "Ada", email: "ada@pod.test" })
        .differentEmail
    ).toBe(true);
  });

  it("says plainly when nobody vouched for the account", () => {
    const review = accountLinkReview({ status: "unverified" }, MEMBER);
    expect(review.heading).toBe(
      "Let an unverified account sign in as Ada Lovelace?"
    );
    expect(review.account).toMatchObject({
      verified: false,
      mark: "Not verified",
      tone: "warning",
      verifiedBy: null,
    });
  });

  it("falls back to the member's email, then to plain words", () => {
    expect(
      accountLinkReview(VERIFIED, { name: null, email: "ada@pod.test" }).member
        .label
    ).toBe("ada@pod.test");
    expect(accountLinkReview(VERIFIED, null).member.label).toBe(
      "this Pod member"
    );
  });
});

describe("accountLinkRequesterView", () => {
  it("tells the requester who waits on whom, with their own address", () => {
    expect(
      accountLinkRequesterView({
        account: VERIFIED,
        appName: "Studio",
        linked: false,
      })
    ).toEqual({
      state: "waiting",
      heading: "Waiting for the Pod owner",
      body: "We asked the Pod owner to link ada@example.test to your Pod account. You can close this page. Studio finishes on its own once they approve.",
      email: "ada@example.test",
    });
  });

  it("says Linked once the invite (or an owner) approved", () => {
    expect(
      accountLinkRequesterView({
        account: VERIFIED,
        appName: "Studio",
        linked: true,
      })
    ).toMatchObject({ state: "linked", heading: "Linked" });
  });
});
