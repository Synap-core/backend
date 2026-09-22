/**
 * `redactSecrets` — now shared by TWO callers (command stdout/stderr, and a
 * failed proposal's stored `data.failure.detail`), so it is worth a test for
 * the first time. It had none as a private copy inside `commands.ts`.
 *
 * It is BEST-EFFORT and this file says so: the audience bound on the proposal
 * detail is the read-door projection (`failure-projection.ts`), not this.
 */

import { describe, it, expect } from "vitest";
import {
  redactSecrets,
  redactForStorage,
  REDACTED_DETAIL_MAX,
} from "./redact-secrets.js";

const REDACTED = /REDACTED/;

describe("shapes the original copy already caught (no regression)", () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ["labelled key", "api_key=sk_live_abcdef123456"],
    ["labelled token", "access-token: abcdef123456"],
    ["bearer", "Authorization: Bearer abc.def.ghi"],
    ["aws key", "AKIAIOSFODNN7EXAMPLE"],
    [
      "private key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    ],
  ];
  for (const [label, input] of CASES) {
    it(`redacts a ${label}`, () => {
      expect(redactSecrets(input)).toMatch(REDACTED);
    });
  }

  it("redacts a connection-string password (masked, not REDACTED-labelled)", () => {
    // This rule masks in place rather than emitting the REDACTED marker, so it
    // is asserted on the SECRET being gone — asserting the marker here would
    // have been a test written against the wrong rule.
    const out = redactSecrets("postgres://user:hunter2@db.example.com:5432/x");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("://***:***@db.example.com:5432/x");
  });

  it("redacts the SECRET, not the whole line", () => {
    const out = redactSecrets("POST /v1/calendars api_key=sk_live_abc failed");
    expect(out).toContain("POST /v1/calendars");
    expect(out).toContain("failed");
    expect(out).not.toContain("sk_live_abc");
  });
});

describe("shapes the shared copy ADDS (the provider-error bodies)", () => {
  const CASES: ReadonlyArray<[string, string, string]> = [
    [
      "OpenAI/Anthropic sk-",
      "rejected key sk-ABCDEFGHIJKLMNOPQRSTUV",
      "sk-ABC",
    ],
    ["GitHub ghp_", "token ghp_ABCDEFGHIJKLMNOPQRST123", "ghp_ABC"],
    ["Slack xoxb-", "using xoxb-123456789-abcdefgh", "xoxb-123"],
    [
      "JWT",
      "expired eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVP",
      "eyJhbGciOiJIUzI1NiJ9",
    ],
    ["refresh_token", "refresh_token=1//0gAbCdEfGh", "1//0gAbCdEfGh"],
    ["client_secret", "client_secret: GOCSPX-abcdef", "GOCSPX-abcdef"],
  ];
  for (const [label, input, secret] of CASES) {
    it(`redacts a bare ${label}`, () => {
      const out = redactSecrets(input);
      expect(out).not.toContain(secret);
      expect(out).toMatch(REDACTED);
    });
  }
});

describe("what it deliberately KEEPS", () => {
  it("keeps a vault REFERENCE — a pointer, not a value", () => {
    // It is exactly what makes a credential failure explainable ("the token
    // behind vault://google/refresh is expired"). Redacting it would make the
    // detail useless without making anything safer.
    const out = redactSecrets("secret vault://google/refresh is expired");
    expect(out).toContain("vault://google/refresh");
  });

  it("keeps ordinary error prose intact", () => {
    const prose = "Capability install failed: calendarId was not supplied";
    expect(redactSecrets(prose)).toBe(prose);
  });
});

describe("redactForStorage — the bounded form written to a row", () => {
  it("collapses whitespace so a stack trace becomes one line", () => {
    expect(redactForStorage("a\n  b\t\tc")).toBe("a b c");
  });

  it(`clamps to ${REDACTED_DETAIL_MAX} chars with an ellipsis`, () => {
    const out = redactForStorage("x".repeat(REDACTED_DETAIL_MAX + 500));
    expect(out).toHaveLength(REDACTED_DETAIL_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  it("redacts BEFORE clamping — a secret cannot survive by being long", () => {
    const secret = "sk-" + "A".repeat(40);
    const out = redactForStorage(`${"pad ".repeat(200)}${secret}`);
    expect(out).not.toContain(secret);
  });

  it("leaves a short, clean detail untouched", () => {
    expect(redactForStorage("target no longer exists")).toBe(
      "target no longer exists"
    );
  });
});

describe("ONE copy — the fork is closed", () => {
  it("commands.ts imports it instead of redefining it", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(
        new URL("../routers/hub-protocol/rest/commands.ts", import.meta.url)
      ),
      "utf8"
    );
    // NON-VACUITY: the scan can see the file and its use of the helper.
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("redactSecrets(stdout)");
    // …and it no longer carries its own definition.
    expect(src).not.toContain("function redactSecrets(");
    expect(src).toContain('from "../../../utils/redact-secrets.js"');
  });
});
