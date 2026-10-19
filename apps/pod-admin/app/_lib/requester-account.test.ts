import { describe, expect, it } from "vitest";
import { requesterAccountLine } from "./requester-account";

describe("requesterAccountLine", () => {
  it("names the verified account and who verified it", () => {
    expect(
      requesterAccountLine({
        status: "verified",
        email: "ada@example.test",
        issuerHost: "api.synap.live",
        verifiedAt: "2026-10-19T20:00:00.000Z",
      })
    ).toEqual({
      tone: "success",
      mark: "Verified",
      title: "ada@example.test",
      detail: "Synap account, verified by api.synap.live",
    });
  });

  it("says plainly when nobody vouched for the account", () => {
    expect(requesterAccountLine({ status: "unverified" })).toMatchObject({
      tone: "warning",
      mark: "Not verified",
      title: "Account not verified",
    });
  });

  it("shows nothing to a reader who may not review", () => {
    expect(requesterAccountLine(null)).toBeNull();
  });
});
