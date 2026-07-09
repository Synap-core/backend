import { describe, it, expect } from "vitest";
import {
  extractIdentitySignals,
  normalizeIdentitySignal,
} from "./identity-resolution-service.js";

describe("extractIdentitySignals", () => {
  it("returns [] for undefined properties", () => {
    expect(extractIdentitySignals(undefined)).toEqual([]);
  });

  it("extracts email, phone, linkedin, website, twitter, github", () => {
    const signals = extractIdentitySignals({
      email: "Alice@Example.com",
      phone: "+1 (555) 123-4567",
      linkedinUrl: "https://www.linkedin.com/in/alice/",
      website: "https://alice.dev",
      twitterHandle: "@alice",
      githubUsername: "alice-dev",
    });

    expect(signals).toContainEqual({
      type: "email",
      value: "Alice@Example.com",
    });
    expect(signals).toContainEqual({
      type: "phone",
      value: "+1 (555) 123-4567",
    });
    expect(signals).toContainEqual({
      type: "linkedin_url",
      value: "https://www.linkedin.com/in/alice/",
    });
    expect(signals).toContainEqual({
      type: "website",
      value: "https://alice.dev",
    });
    expect(signals).toContainEqual({ type: "twitter_handle", value: "@alice" });
    expect(signals).toContainEqual({
      type: "github_username",
      value: "alice-dev",
    });
  });

  it("accepts the kebab-case fallback keys", () => {
    const signals = extractIdentitySignals({
      "linkedin-url": "https://linkedin.com/in/bob",
      "twitter-handle": "bob",
      "github-username": "bob-gh",
    });
    expect(signals).toContainEqual({
      type: "linkedin_url",
      value: "https://linkedin.com/in/bob",
    });
    expect(signals).toContainEqual({ type: "twitter_handle", value: "bob" });
    expect(signals).toContainEqual({
      type: "github_username",
      value: "bob-gh",
    });
  });

  it("rejects malformed values", () => {
    const signals = extractIdentitySignals({
      email: "not-an-email",
      phone: "123",
      linkedinUrl: "https://not-linkedin.com/in/x",
      website: "not-a-url",
    });
    expect(signals).toEqual([]);
  });

  it("NEVER emits a discord-handle signal — frozen policy: weak/advisory only", () => {
    const signals = extractIdentitySignals({
      "discord-handle": "0scr",
      email: "alice@example.com",
    });
    expect(signals.some((s) => s.type === "discord-handle")).toBe(false);
    expect(signals).toEqual([{ type: "email", value: "alice@example.com" }]);
  });

  it("opts.aliases scans the aliases[] array for email/url-looking entries", () => {
    const withoutOpt = extractIdentitySignals({
      aliases: ["alice@example.com", "https://alice.dev", "Al", "  "],
    });
    expect(withoutOpt).toEqual([]);

    const withOpt = extractIdentitySignals(
      { aliases: ["alice@example.com", "https://alice.dev", "Al", "  "] },
      { aliases: true }
    );
    expect(withOpt).toContainEqual({
      type: "email",
      value: "alice@example.com",
    });
    expect(withOpt).toContainEqual({
      type: "website",
      value: "https://alice.dev",
    });
    expect(withOpt).toHaveLength(2);
  });

  it("agrees byte-for-byte with normalizeIdentitySignal (the resolveIdentity lookup door)", () => {
    const [signal] = extractIdentitySignals({ email: "Alice@Example.com" });
    expect(normalizeIdentitySignal(signal.type, signal.value)).toBe(
      "alice@example.com"
    );
  });
});
