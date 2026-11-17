/**
 * `redactSecretKeys` — what a proposal's stored `data.body` keeps (ticket
 * 858b6f04). It replaced only a plain string DIRECTLY under a credential key,
 * so an array, an object or a nested list under one was stored verbatim and
 * read back by every reviewer and agent. It now follows the audit-log rule
 * (`redactPayloadForLog`): every string at any depth under a secret-bearing
 * key is replaced; a `vault://` pointer, numbers and booleans stay, and other
 * keys pass through. `carriesRedactedSecret` sees the marker at the same depth,
 * so the approved replay of such a body is refused.
 *
 * Not covered (stated): a NUMBER under a credential key stays, as in the log
 * (`maxTokens` is one); free text under a neutral key is not scrubbed (that
 * would change the body a replay sends).
 */
import { describe, it, expect } from "vitest";
import {
  REDACTED_SECRET_VALUE as R,
  carriesRedactedSecret,
  redactSecretKeys,
} from "./redact-secrets.js";

const SECRET = "s3cr3t-opaque-value-0123456789";

describe("redactSecretKeys — every string under a credential key", () => {
  it.each([
    ["an array", { api_keys: [SECRET, SECRET] }, { api_keys: [R, R] }],
    [
      "an object",
      { credentials: { username: "ada", pass: SECRET } },
      { credentials: { username: R, pass: R } },
    ],
    [
      "a list of objects",
      { tokens: [{ value: SECRET }] },
      { tokens: [{ value: R }] },
    ],
    [
      "a nested path",
      { auth: { cookie: { session: [SECRET] } } },
      { auth: { cookie: { session: [R] } } },
    ],
  ])("%s is replaced", (_label, input, expected) => {
    const out = redactSecretKeys(input);
    expect(out).toEqual(expected);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("a plain string directly under one is still replaced (the old case)", () => {
    expect(redactSecretKeys({ access_token: SECRET })).toEqual({
      access_token: R,
    });
  });

  it("keeps a vault pointer, numbers, booleans and every other key", () => {
    const input = {
      apiKeys: ["vault://github/token", SECRET],
      maxTokens: 400,
      password_set: true,
      credential_ids: ["cred-1"],
      url: "https://example.com/x",
      nested: { title: "Hello", keyword: "kept" },
    };
    expect(redactSecretKeys(input)).toEqual({
      apiKeys: ["vault://github/token", R],
      maxTokens: 400,
      password_set: true,
      credential_ids: ["cred-1"],
      url: "https://example.com/x",
      nested: { title: "Hello", keyword: "kept" },
    });
  });
});

describe("carriesRedactedSecret — the replay refusal sees the marker at any depth", () => {
  it("in an array or an object under a credential key", () => {
    expect(
      carriesRedactedSecret(redactSecretKeys({ api_keys: [SECRET] }))
    ).toBe(true);
    expect(
      carriesRedactedSecret(
        redactSecretKeys({ credentials: { username: "u", pass: SECRET } })
      )
    ).toBe(true);
  });

  it("not for a body with no credential, nor the marker text under a neutral key", () => {
    expect(carriesRedactedSecret({ title: "x", items: ["a"] })).toBe(false);
    expect(carriesRedactedSecret({ note: R })).toBe(false);
    expect(
      carriesRedactedSecret(redactSecretKeys({ apiKey: "vault://a/b" }))
    ).toBe(false);
  });
});
