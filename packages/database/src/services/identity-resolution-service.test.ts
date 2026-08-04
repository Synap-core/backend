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

/**
 * Strong-signal race (documented residual).
 *
 * TOCTOU: two concurrent creates with the same strong signal can both see
 * resolveIdentity match:null, both insert entities, then registerIdentitySignals
 * races on unique (signal_type, signal_value). onConflictDoNothing means only
 * ONE entity owns the signal; the loser has the email in properties but is
 * invisible to future strong resolves.
 *
 * Mitigations in place:
 *   - EntityRepository.create AWAITS signal registration (was fire-and-forget)
 *   - unique index is the last line of defence
 *
 * NOT fixed (FK blocks claim-before-insert: entity_identity_signals.entity_id
 * references entities.id). A full fix would need a deferred claim table or a
 * single transaction that rolls back the loser — out of scope for Phase 1.
 *
 * This pure test pins the policy contracts the race depends on; live concurrent
 * inserts are covered when PG is available by the unique-index behavior of
 * registerIdentitySignals itself.
 */
describe("strong-signal race (documented residual)", () => {
  it("normalizeIdentitySignal is the shared door — concurrent writers agree on the collision key", () => {
    const a = normalizeIdentitySignal("email", "Race@Example.com");
    const b = normalizeIdentitySignal("email", "race@example.com ");
    expect(a).toBe(b);
    expect(a).toBe("race@example.com");
  });

  it("extractIdentitySignals feeds the same key registerIdentitySignals stores", () => {
    const signals = extractIdentitySignals({ email: "Race@Example.com" });
    expect(signals).toHaveLength(1);
    expect(normalizeIdentitySignal(signals[0].type, signals[0].value)).toBe(
      "race@example.com"
    );
  });
});
