/**
 * The account-trust mark (Pod Admin's connection review). Pinned apart from
 * the connection-state words because both tables key `unverified`, with
 * different meanings: a shared lookup would tell a reviewer the pod "Couldn't
 * check" an account that simply was not vouched for.
 */
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_TRUST_LABELS,
  resolveAccountTrustLabel,
  resolveConnectionStateLabel,
} from "./index.js";

describe("account trust labels", () => {
  it("names both states", () => {
    expect(resolveAccountTrustLabel("verified")).toBe("Verified");
    expect(resolveAccountTrustLabel("unverified")).toBe("Not verified");
    expect(Object.keys(ACCOUNT_TRUST_LABELS)).toEqual([
      "verified",
      "unverified",
    ]);
  });

  it("never borrows the connection-state word for the same token", () => {
    expect(resolveConnectionStateLabel("unverified")).toBe("Couldn't check");
    expect(resolveAccountTrustLabel("unverified")).not.toBe(
      resolveConnectionStateLabel("unverified")
    );
  });

  it("humanizes an unknown state, never leaks it", () => {
    expect(resolveAccountTrustLabel("vouched_by_owner")).toBe(
      "Vouched by owner"
    );
    expect(resolveAccountTrustLabel(null)).toBe("");
  });
});
