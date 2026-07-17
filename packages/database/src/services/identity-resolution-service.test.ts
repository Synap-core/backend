import { describe, it, expect } from "vitest";
import {
  extractIdentitySignals,
  externalRefSignal,
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

  it("NEVER emits external_id — it is not derived from any property key", () => {
    // The invariant that keeps the identity axis honest: external_id can only be
    // minted from an explicit (system, id) pair, never inferred from a property.
    // A property named `externalId` must not become a strong identity atom.
    const signals = extractIdentitySignals({
      externalId: "not-a-signal",
      external_id: "also-not-a-signal",
      system: "nope",
      email: "alice@example.com",
    });
    expect(signals.every((s) => s.type !== "external_id")).toBe(true);
  });
});

describe("externalRefSignal", () => {
  it("mints the `${system}:${id}` external_id atom", () => {
    expect(externalRefSignal({ system: "acme-crm", id: "REC-42" })).toEqual({
      type: "external_id",
      value: "acme-crm:REC-42",
    });
  });

  it("agrees byte-for-byte with the format EntityUpsertService registers", () => {
    // EntityUpsertService's cross-source lookup historically built this key
    // inline as `${input.source}:${input.externalId}`. Both now mint through
    // this door — if the format ever drifts, the two stop converging on the same
    // entity_identity_signals row and re-imports silently duplicate.
    const source = "acme-crm";
    const externalId = "REC-42";
    expect(externalRefSignal({ system: source, id: externalId }).value).toBe(
      `${source}:${externalId}`
    );
  });

  it("survives normalizeIdentitySignal with its case INTACT (opaque provider id)", () => {
    // external_id is the one strong atom that must not be lowercased: an opaque
    // id may carry a case-significant hash/base64 segment, and lowercasing on
    // read (but not write, or vice-versa) would silently never match.
    const signal = externalRefSignal({ system: "Acme-CRM", id: "aB9xYz==" });
    expect(normalizeIdentitySignal(signal.type, signal.value)).toBe(
      "Acme-CRM:aB9xYz=="
    );
  });

  it("normalizes away a trailing space so it cannot fork identity", () => {
    // Trimming happens at the wire codec; normalize is the second belt, so a
    // padded value read back still hits the row written by the clean one.
    const padded = externalRefSignal({ system: "acme-crm", id: "REC-42 " });
    expect(normalizeIdentitySignal(padded.type, padded.value)).toBe(
      normalizeIdentitySignal("external_id", "acme-crm:REC-42")
    );
  });
});
