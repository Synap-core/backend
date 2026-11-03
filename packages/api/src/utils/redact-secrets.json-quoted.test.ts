/**
 * `redactSecrets` masks QUOTED credential pairs (CP ticket 84f82ed3).
 *
 * Provider error bodies are JSON that echoes the request, and a log line or a
 * stored detail often holds such a body serialized inside a string. The
 * key=value rule never matched them: the closing quote sits between the key
 * and the separator, so `{"api_key":"…"}` reached stored failure details, a
 * TRPC error message and the materializer's stdout preview unchanged.
 *
 * The function lives in `@synap/shared-utils` (whose package has no test run);
 * this file drives it through the api re-export, the import every api caller
 * uses.
 */

import { describe, it, expect } from "vitest";
import { redactSecrets } from "./redact-secrets.js";

const SECRET = "hunter2-S3cr3tValue-9f8e7d";

describe("a quoted credential pair is masked", () => {
  const KEYS = [
    "password",
    "client_secret",
    "api_key",
    "apiKey",
    "x-api-key",
    "access_token",
    "refresh_token",
    "token",
    "githubToken",
    "private_key",
    "passphrase",
    "Authorization",
    "cookie",
  ];
  for (const key of KEYS) {
    it(`JSON "${key}"`, () => {
      const out = redactSecrets(
        `{"request":{"${key}":"${SECRET}","user":"ada"}}`
      );
      expect(out).not.toContain(SECRET);
      expect(out).toContain(`"${key}":"***REDACTED***"`);
      expect(out).toContain('"user":"ada"');
    });
  }

  it("with spaces around the colon", () => {
    expect(redactSecrets(`{ "password" :  "${SECRET}" }`)).not.toContain(
      SECRET
    );
  });

  it("a value holding an escaped quote", () => {
    const out = redactSecrets(`{"password":"a\\"${SECRET}"}`);
    expect(out).not.toContain(SECRET);
  });

  it("a single-quoted (Python repr) pair", () => {
    const out = redactSecrets(`{'client_secret': '${SECRET}'}`);
    expect(out).not.toContain(SECRET);
  });

  it("a pair serialized inside a JSON string (escaped quotes)", () => {
    const inner = JSON.stringify({ api_key: SECRET, user: "ada" });
    const out = redactSecrets(JSON.stringify({ detail: inner }));
    expect(out).not.toContain(SECRET);
    expect(out).toContain("ada");
  });

  it("several pairs in one body", () => {
    const out = redactSecrets(
      JSON.stringify({
        client_id: "app-1",
        client_secret: SECRET,
        refresh_token: `${SECRET}2`,
      })
    );
    expect(out).not.toContain(SECRET);
    expect(out).toContain('"client_id":"app-1"');
  });
});

describe("what it keeps", () => {
  it("a JSON body's non-credential fields", () => {
    const body = `{"error":"invalid_grant","error_description":"Token expired"}`;
    expect(redactSecrets(body)).toBe(body);
  });

  it("a number under a token-like key (not a quoted string)", () => {
    const body = `{"max_tokens":1000,"model":"m"}`;
    expect(redactSecrets(body)).toBe(body);
  });
});
