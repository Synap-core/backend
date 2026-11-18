/**
 * Two additions to the stored-payload redactor, both for a credential whose
 * KEY names nothing secret (decision abaaa696, design §8 Q3):
 *   - `redactSecretKeys` masks a `value` whose sibling `type` is `sensitive`
 *     or `secret` (a Vercel Secret env var: `{ key, value, type }`), and
 *     `carriesRedactedSecret` sees the mask, so an approved replay refuses it;
 *   - `scrubKnownSecret` removes ONE secret the caller holds from any text
 *     (a provider echoing the value back in an error).
 */
import { describe, it, expect } from "vitest";
import {
  carriesRedactedSecret,
  redactSecretKeys,
  REDACTED_SECRET_VALUE,
  scrubKnownSecret,
} from "./redact-secrets.js";

const SECRET =
  "9f2c4e6a8b0d1f3e5a7c9e1b3d5f7a9c0e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f";

describe("a write-only typed value is masked in a stored payload", () => {
  it("masks `value` when its sibling `type` is sensitive", () => {
    const body = {
      key: "CONTACT_WEBHOOK_SECRET",
      value: SECRET,
      type: "sensitive",
      target: ["production"],
    };
    const out = redactSecretKeys(body);
    expect(out.value).toBe(REDACTED_SECRET_VALUE);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    // The rest stays reviewable.
    expect(out.key).toBe("CONTACT_WEBHOOK_SECRET");
    expect(out.target).toEqual(["production"]);
    expect(carriesRedactedSecret(out)).toBe(true);
  });

  it("masks it inside an array body and for type secret (any case)", () => {
    const out = redactSecretKeys([{ key: "A", value: SECRET, type: "Secret" }]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(carriesRedactedSecret(out)).toBe(true);
  });

  it("keeps a Config value (type encrypted / plain) as written", () => {
    const body = {
      key: "CONTACT_WEBHOOK_URL",
      value: "https://pod.example/api/webhooks/inbound/x",
      type: "encrypted",
    };
    expect(redactSecretKeys(body)).toEqual(body);
    expect(carriesRedactedSecret(body)).toBe(false);
  });

  it("keeps a vault reference, which is a pointer", () => {
    const body = { value: "vault://abc", type: "sensitive" };
    expect(redactSecretKeys(body)).toEqual(body);
  });
});

describe("scrubKnownSecret", () => {
  it("removes every occurrence of the secret and keeps the rest", () => {
    const text = `Vercel refused value ${SECRET} for CONTACT_WEBHOOK_SECRET (${SECRET})`;
    const out = scrubKnownSecret(text, SECRET);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("CONTACT_WEBHOOK_SECRET");
    expect(out.split(REDACTED_SECRET_VALUE)).toHaveLength(3);
  });

  it("is a no-op with no secret, or a too-short one", () => {
    expect(scrubKnownSecret("abc", null)).toBe("abc");
    expect(scrubKnownSecret("abcdef", "abc")).toBe("abcdef");
  });
});
