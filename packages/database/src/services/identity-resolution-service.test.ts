import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  URL_IDENTITY_KINDS,
  canonicalizeUrl,
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

/**
 * URL identity atom (D8): the same URL captured twice must canonicalise to ONE
 * key, so the second capture resolves to the first bookmark.
 */
describe("canonicalizeUrl / url-type normalisation", () => {
  const table: Array<[string, string, string]> = [
    ["www dropped", "https://www.x.com/a", "https://x.com/a"],
    ["host lowercased", "https://WWW.X.COM/a", "https://x.com/a"],
    ["fragment dropped", "https://x.com/a#section-2", "https://x.com/a"],
    ["trailing slash", "https://x.com/a/", "https://x.com/a"],
    ["bare host slash", "https://x.com/", "https://x.com"],
    [
      "utm_* dropped",
      "https://x.com/a?utm_source=y&utm_medium=email",
      "https://x.com/a",
    ],
    ["fbclid dropped", "https://x.com/a?fbclid=IwAR0", "https://x.com/a"],
    ["gclid dropped", "https://x.com/a?gclid=Cj0K", "https://x.com/a"],
    [
      "keeps v= (identity), drops tracking around it",
      "https://www.youtube.com/watch?utm_source=tw&v=dQw4w9WgXcQ&fbclid=1",
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
    ],
    [
      "keeps path + query case",
      "https://x.com/Path/To?Id=AbC",
      "https://x.com/Path/To?Id=AbC",
    ],
    [
      "everything at once",
      "https://www.x.com/a?utm_source=y#z",
      "https://x.com/a",
    ],
  ];
  it.each(table)("%s", (_label, input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
    expect(normalizeIdentitySignal("url", input)).toBe(expected);
  });

  it("a non-URL value is trimmed + slash-stripped, never thrown on", () => {
    expect(canonicalizeUrl("  not a url/ ")).toBe("not a url");
  });

  it("linkedin_url / website get the same canonical form, then case-folded", () => {
    expect(
      normalizeIdentitySignal(
        "linkedin_url",
        "https://www.linkedin.com/in/Alice/?utm_source=share#x"
      )
    ).toBe("https://linkedin.com/in/alice");
    expect(
      normalizeIdentitySignal("website", "https://WWW.Acme.com/?gclid=1")
    ).toBe("https://acme.com");
  });
});

describe("extractIdentitySignals — url atom is kind-gated", () => {
  it("emits a url atom for every URL_IDENTITY_KINDS kind", () => {
    for (const kind of URL_IDENTITY_KINDS) {
      expect(
        extractIdentitySignals({ url: "https://x.com/a" }, { kind })
      ).toEqual([{ type: "url", value: "https://x.com/a" }]);
    }
  });

  it("a person's url is NOT identity", () => {
    expect(
      extractIdentitySignals({ url: "https://x.com/a" }, { kind: "person" })
    ).toEqual([]);
  });

  it("no kind ⇒ no url atom (callers that do not pass a kind are unchanged)", () => {
    expect(extractIdentitySignals({ url: "https://x.com/a" })).toEqual([]);
  });

  it("a non-http url value is ignored", () => {
    expect(
      extractIdentitySignals({ url: "obsidian://open?x" }, { kind: "bookmark" })
    ).toEqual([]);
  });

  it("the url atom is its own namespace — never `website`", () => {
    const [s] = extractIdentitySignals(
      { url: "https://acme.com" },
      { kind: "bookmark" }
    );
    expect(s.type).toBe("url");
  });
});

/**
 * URL_IDENTITY_KINDS is hand-listed in the pure extractor; the SOURCE of the
 * bookmark family is the system-profile seeder. Derive the family from the
 * seeder's own `parentSlug: "bookmark"` entries and pin equality, so a new
 * child of `bookmark` added there fails here until it is classified.
 * Limitation: reads the seeder SOURCE (regex over `slug:`/`parentSlug:` pairs
 * inside one object literal); it does not see user-defined kinds.
 */
describe("URL_IDENTITY_KINDS ↔ ensure-system-profiles bookmark family", () => {
  it("equals bookmark + every seeded profile parented under bookmark", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../utils/ensure-system-profiles.ts", import.meta.url)
      ),
      "utf8"
    );
    const children = [
      ...src.matchAll(
        /slug:\s*"([a-z_]+)",\s*\n\s*displayName:[^}]*?\}\s*,\s*\n\s*parentSlug:\s*"bookmark"/g
      ),
    ].map((m) => m[1]);
    // Non-vacuity: the seeder still declares the known children.
    expect(children).toEqual(
      expect.arrayContaining(["website", "article", "signal_item"])
    );
    expect(new Set(["bookmark", ...children])).toEqual(
      new Set(URL_IDENTITY_KINDS)
    );
  });
});
