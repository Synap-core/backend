import { describe, expect, it } from "vitest";
import { lensRowExpiry, proposalFateLine } from "./index.js";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

describe("proposalFateLine", () => {
  it("an expiry reads exactly as the row's age slot", () => {
    const expiresAt = inHours(6);
    expect(
      proposalFateLine({ kind: "expires", expiresAt, orSessionEnd: false }, NOW)
    ).toBe(lensRowExpiry({ expiresAt }, NOW)?.label);
    expect(
      proposalFateLine({ kind: "expires", expiresAt, orSessionEnd: false }, NOW)
    ).toBe("Expires in 6h");
  });

  it("names the session end when it can come first, never once expired", () => {
    expect(
      proposalFateLine({ kind: "expires", expiresAt: inHours(6), orSessionEnd: true }, NOW)
    ).toBe("Expires in 6h, or when the session ends");
    expect(
      proposalFateLine({ kind: "expires", expiresAt: inHours(-1), orSessionEnd: true }, NOW)
    ).toBe(lensRowExpiry({ expiresAt: inHours(-1) }, NOW)?.label);
  });

  it("the three other fates", () => {
    expect(proposalFateLine({ kind: "dies_with_session" }, NOW)).toBe(
      "Ends with the session"
    );
    expect(proposalFateLine({ kind: "until_decided" }, NOW)).toBe(
      "Stays until you decide"
    );
    const line = proposalFateLine(
      { kind: "review_later", since: "2026-10-19T12:00:00.000Z" },
      NOW
    );
    expect(line).toMatch(/^In Review later since \S/);
    expect(line).toContain("19");
    expect(proposalFateLine({ kind: "review_later", since: "nope" }, NOW)).toBe(
      "In Review later"
    );
  });

  it("an unreadable expiry never claims a countdown", () => {
    expect(
      proposalFateLine({ kind: "expires", expiresAt: "nope", orSessionEnd: false }, NOW)
    ).toBe("Stays until you decide");
  });
});
