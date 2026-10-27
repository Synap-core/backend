import { describe, expect, it } from "vitest";
import {
  lensRowExpiry,
  proposalFateConsequence,
  proposalFateLine,
} from "./index.js";

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

describe("proposalFateConsequence — what ignoring it does", () => {
  it("a row in Review later says it is out of the count and stays", () => {
    const line = proposalFateConsequence({ kind: "review_later", since: inHours(-1) });
    expect(line).toBe("Out of your count. It stays until you decide.");
    expect(line).not.toContain("In Review later");
  });

  it("objectWork still waiting says when it leaves the count, and that it never expires", () => {
    expect(
      proposalFateConsequence({ kind: "until_decided" }, { proposalClass: "objectWork" })
    ).toBe("Leaves your count after 7 days untouched. It never expires.");
  });

  it("every other fate's line is already its consequence", () => {
    expect(
      proposalFateConsequence({ kind: "until_decided" }, { proposalClass: "governance" })
    ).toBe(proposalFateLine({ kind: "until_decided" }, NOW));
    expect(
      proposalFateConsequence(
        { kind: "expires", expiresAt: inHours(6), orSessionEnd: false },
        { now: NOW }
      )
    ).toBe("Expires in 6h");
  });

  it("says it with no em dash", () => {
    for (const fate of [
      { kind: "review_later", since: inHours(-1) },
      { kind: "until_decided" },
    ] as const) {
      expect(proposalFateConsequence(fate, { proposalClass: "objectWork" })).not.toContain("—");
    }
  });
});
