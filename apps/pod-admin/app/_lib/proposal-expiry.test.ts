import { describe, expect, it } from "vitest";
import { proposalExpiresAt, proposalLapsed } from "./proposal-expiry";

const AT = "2026-10-27T00:00:00.000Z";
const HOUR = 3_600_000;

describe("proposalExpiresAt", () => {
  it("asked-at plus the class lifetime", () => {
    expect(proposalExpiresAt(AT, 24)).toBe("2026-10-28T00:00:00.000Z");
    expect(proposalExpiresAt(new Date(AT), 1)).toBe("2026-10-27T01:00:00.000Z");
  });

  it("a class that never expires, or no asked-at time: null", () => {
    expect(proposalExpiresAt(AT, null)).toBeNull();
    expect(proposalExpiresAt(AT, undefined)).toBeNull();
    expect(proposalExpiresAt(null, 24)).toBeNull();
    expect(proposalExpiresAt("not a date", 24)).toBeNull();
  });
});

describe("proposalLapsed", () => {
  const ends = proposalExpiresAt(AT, 1);
  it("past its instant it is history", () => {
    expect(proposalLapsed(ends, Date.parse(AT) + 2 * HOUR)).toBe(true);
  });
  it("before it, and when it never expires, it is still a decision", () => {
    expect(proposalLapsed(ends, Date.parse(AT) + HOUR / 2)).toBe(false);
    expect(proposalLapsed(null)).toBe(false);
  });
});
