import { describe, expect, it } from "vitest";
import {
  AskAnswerValueSchema,
  AskFormValuesSchema,
  AskSchema,
  DynamicFormSpecSchema,
  isCredentialFieldName,
  isRefusedAskField,
  summarizeAnswer,
} from "./index.js";
import { REDACTED_SECRET } from "../vault/index.js";

/**
 * The NAME floor. Rows are chosen where "refuse by type only" (the previous
 * rule) and "refuse by type, key or label" DISAGREE: every refused row below
 * has an innocent `type: "text"`, so the old rule kept all of them.
 */

const KEY = "sk_live_51Habc";

describe("a form field NAMED like a credential is dropped whatever its type", () => {
  const CREDENTIAL_NAMED: Array<{ key: string; label: string }> = [
    { key: "stripe_api_key", label: "Stripe secret key" }, // the reported leak
    { key: "stripe_api_key", label: "Stripe" }, // key alone
    { key: "account", label: "Stripe secret key" }, // label alone
    { key: "apiKey", label: "Key" },
    { key: "APIKey", label: "x" },
    { key: "githubToken", label: "GitHub" },
    { key: "pw", label: "Your password" },
    { key: "client-secret", label: "Client" },
    { key: "x", label: "Private key (PEM)" },
    { key: "x", label: "AWS access key" },
    { key: "x", label: "Card number" },
    { key: "x", label: "One-time code (OTP)" },
    { key: "x", label: "Database connection string" },
  ];

  it.each(CREDENTIAL_NAMED)("drops key=$key label=$label", (f) => {
    const parsed = DynamicFormSpecSchema.parse({
      fields: [
        { key: "name", label: "Name", type: "text" },
        { ...f, type: "text" },
      ],
    });
    expect(parsed.fields.map((x) => x.key)).toEqual(["name"]);
  });

  it("a form ask whose ONLY field is credential-named is refused loudly", () => {
    const r = AskSchema.safeParse({
      mode: "form",
      form: {
        fields: [
          { key: "stripe_api_key", label: "Stripe secret key", type: "text" },
        ],
      },
    });
    expect(r.success).toBe(false);
  });

  it("KEEPS near-misses: whole words only, and generic words alone", () => {
    const innocent = [
      "tokenizer",
      "keyword",
      "Key date",
      "Key takeaway",
      "passage",
      "Certificate of incorporation",
      "Secretary",
      "Pinned note",
      "value",
      "content",
      "Region",
    ];
    for (const name of innocent) {
      expect([name, isCredentialFieldName(name)]).toEqual([name, false]);
    }
    const parsed = DynamicFormSpecSchema.parse({
      fields: innocent.map((label, i) => ({
        key: `f${i}`,
        label,
        type: "text",
      })),
    });
    expect(parsed.fields).toHaveLength(innocent.length);
  });

  it("non-vacuity: the predicate is live on every door it claims", () => {
    expect(isRefusedAskField({ key: "a", label: "b", type: "password" })).toBe(
      true
    );
    expect(
      isRefusedAskField({ key: "api_key", label: "b", type: "text" })
    ).toBe(true);
    expect(
      isRefusedAskField({ key: "a", label: "API key", type: "text" })
    ).toBe(true);
    expect(isRefusedAskField({ key: "a", label: "b", type: "text" })).toBe(
      false
    );
    expect(isCredentialFieldName(undefined)).toBe(false);
  });
});

describe("values under a credential-named key are redacted", () => {
  it("redacts a PLAIN string under a credential key (tagged-shape rule missed it)", () => {
    const out = AskFormValuesSchema.parse({
      stripe_api_key: KEY,
      name: "Acme",
    });
    expect(out.stripe_api_key).toBe(REDACTED_SECRET);
    expect(out.name).toBe("Acme");
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("redacts at depth and inside arrays", () => {
    const out = AskFormValuesSchema.parse({
      profile: { accessToken: KEY },
      list: [{ password: KEY }],
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("redacts a whole object filed under a credential key", () => {
    const out = AskFormValuesSchema.parse({
      credentials: { user: "a", pass: KEY },
    });
    expect(out.credentials).toBe(REDACTED_SECRET);
  });

  it("passes numbers, booleans, null and an existing vault ref", () => {
    const ref = { kind: "existing", ref: "vault://abc" };
    const out = AskFormValuesSchema.parse({
      token_budget: 5000,
      has_password: true,
      otp: null,
      apiKey: ref,
    });
    expect(out).toEqual({
      token_budget: 5000,
      has_password: true,
      otp: null,
      apiKey: ref,
    });
  });

  it("never reaches the summary or the stored answer value", () => {
    const value = AskAnswerValueSchema.parse({
      type: "form",
      values: { api_key: KEY },
    });
    expect(JSON.stringify(value)).not.toContain(KEY);
    expect(summarizeAnswer(null, value)).not.toContain(KEY);
  });

  it("still measures the size bound on the ORIGINAL", () => {
    expect(
      AskFormValuesSchema.safeParse({ api_key: "k".repeat(9 * 1024) }).success
    ).toBe(false);
  });
});
