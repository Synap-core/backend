import { describe, it, expect } from "vitest";
import {
  CAPTURE_PART_LIMITS,
  CAPTURE_REFUSED_FIELD_TYPES,
  isRefusedCaptureFieldType,
  CaptureAnswerSchema,
  DynamicFormSpecSchema,
  REDACTED_SECRET,
  redactSecretValues,
} from "./index.js";
import {
  cleanFieldKey,
  isSensitiveField,
  SECRET_TYPE_FIELDS,
} from "../vault/index.js";

/**
 * A credential must never ride the capture wire. Two doors, one rule each:
 *
 *  - an AI cannot AUTHOR a `secret` form field (credential prompts come from a
 *    capability manifest, client-side — `type` is a free string on this wire,
 *    so the schema is the only place that can say no);
 *  - a typed `{kind:"new"}` value is redacted at PARSE time, so what is
 *    persisted into `messages.metadata.capturePart` and what feeds the model's
 *    refine context can never be the plaintext key.
 *
 * Rows are chosen where the candidate rules DISAGREE: an `existing` ref
 * separates "redact any object" from "redact only a NEW secret"; a `new` with
 * a non-string value separates the tagged-shape predicate from a bare
 * `kind === "new"` check; an oversized payload separates "measure the size
 * before redacting" from "after".
 */

const KEY = "sk-live-abc123";

describe("a secret field cannot be authored on the capture wire", () => {
  const spec = {
    fields: [
      { key: "name", label: "Name", type: "text" },
      { key: "apiKey", label: "API key", type: "secret" },
      { key: "region", label: "Region", type: "enum" },
    ],
  };

  it("drops the secret field and keeps its siblings, in order", () => {
    const parsed = DynamicFormSpecSchema.parse(spec);
    expect(parsed.fields.map((f) => f.key)).toEqual(["name", "region"]);
  });

  it("non-vacuity: the input really did contain a secret field", () => {
    expect(spec.fields.some((f) => f.type === "secret")).toBe(true);
  });
});

describe("every CREDENTIAL-ish type is refused, not just `secret`", () => {
  // The hole: the dropped-set held only `"secret"`, so an AI authoring
  // `type: "password"` (or `"token"`, or `"api_key"`) still got a masked
  // credential prompt in a room message — same consequence, different spelling.
  const CREDENTIAL_SPELLINGS = [
    "password",
    "token",
    "api_key",
    "API-KEY",
    "apiKey",
    "accessToken",
    "client_secret",
    "private key",
  ];

  it.each(CREDENTIAL_SPELLINGS)("drops an authored `%s` field", (type) => {
    const parsed = DynamicFormSpecSchema.parse({
      fields: [
        { key: "name", label: "Name", type: "text" },
        { key: "cred", label: "Credential", type },
      ],
    });
    expect(parsed.fields.map((f) => f.key)).toEqual(["name"]);
  });

  it("KEEPS every non-credential type — `type` stays an open string", () => {
    // The set is a DROPPED-SET, not an enum, on purpose: a new non-credential
    // type must keep working without a release. This is the row that
    // discriminates "drop credentials" from "allow only a known list".
    const open = ["text", "number", "enum", "date", "slider", "mystery-widget"];
    const parsed = DynamicFormSpecSchema.parse({
      fields: open.map((type, i) => ({ key: `f${i}`, label: type, type })),
    });
    expect(parsed.fields).toHaveLength(open.length);
  });

  it("non-vacuity: the predicate really discriminates", () => {
    expect(CAPTURE_REFUSED_FIELD_TYPES.length).toBeGreaterThan(5);
    expect(isRefusedCaptureFieldType("password")).toBe(true);
    expect(isRefusedCaptureFieldType("text")).toBe(false);
    expect(isRefusedCaptureFieldType(undefined)).toBe(false);
    // Near-misses that must NOT be caught — `passwordHint` is not a credential
    // prompt, and over-matching would silently eat legitimate fields.
    expect(isRefusedCaptureFieldType("passwordHint")).toBe(false);
    expect(isRefusedCaptureFieldType("tokenizer")).toBe(false);
  });

  /**
   * ROUND-2: the set is now DERIVED from `SECRET_TYPE_FIELDS`' `!`-prefixed
   * keys plus a small explicit form-only list. These spellings were all MISSED
   * by the hand list, and a hand list had no mechanism to stop the next miss.
   */
  const PREVIOUSLY_MISSED = [
    "secret-key",
    "secretKey",
    "api_secret",
    "ssh_key",
    "sshKey",
    "totp",
    "otp",
    "pin",
    "cvv",
    "card_number",
    "cardCvv",
    "connection_string",
    "passphrase",
  ];

  it.each(PREVIOUSLY_MISSED)("refuses `%s` (was allowed)", (type) => {
    expect(isRefusedCaptureFieldType(type)).toBe(true);
  });

  it("the DERIVED set really is derived, and is large", () => {
    // Non-vacuity on the derivation: every `!`-key of the vault table (minus
    // the two named generics) is present, so a new sensitive vault field joins
    // this set by existing rather than by someone remembering.
    const sensitive = Object.values(SECRET_TYPE_FIELDS)
      .flat()
      .filter(isSensitiveField)
      .map((f) => cleanFieldKey(f).toLowerCase())
      .filter((f) => f !== "value");
    expect(sensitive.length).toBeGreaterThan(10);
    for (const f of sensitive) {
      expect(isRefusedCaptureFieldType(f)).toBe(true);
    }
    expect(CAPTURE_REFUSED_FIELD_TYPES.length).toBeGreaterThan(15);
    // The two deliberate EXCLUSIONS stay allowed — sensitivity in the vault is
    // contextual and does not survive the move to a form-field type.
    expect(isRefusedCaptureFieldType("value")).toBe(false);
    expect(isRefusedCaptureFieldType("content")).toBe(false);
  });
});

describe("a typed secret is redacted at parse time", () => {
  const parseForm = (values: Record<string, unknown>) => {
    const parsed = CaptureAnswerSchema.parse({ type: "form", values });
    if (parsed.type !== "form") throw new Error("expected a form answer");
    return parsed.values;
  };

  it("replaces a NEW secret's typed key", () => {
    const out = parseForm({
      name: "Acme",
      apiKey: { kind: "new", value: KEY },
    });
    expect(out.apiKey).toEqual({ kind: "new", value: REDACTED_SECRET });
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(out.name).toBe("Acme");
  });

  it("passes an EXISTING vault ref through — a pointer is not a credential", () => {
    const ref = { kind: "existing", ref: "vault://abc" };
    expect(parseForm({ apiKey: ref }).apiKey).toEqual(ref);
  });

  it("does not treat a non-string `new` value as the secret shape", () => {
    const odd = { kind: "new", value: 5 };
    expect(parseForm({ odd }).odd).toEqual(odd);
  });

  it("measures the size bound on the ORIGINAL, so redaction cannot rescue an oversized payload", () => {
    const huge = "k".repeat(CAPTURE_PART_LIMITS.formValuesMaxBytes + 1);
    // The redacted copy would be tiny; the original is over the bound.
    expect(
      CaptureAnswerSchema.safeParse({
        type: "form",
        values: { apiKey: { kind: "new", value: huge } },
      }).success
    ).toBe(false);
  });
});

describe("redactSecretValues", () => {
  /**
   * CORRECTED (round-2 review). This assertion used to be
   * `expect(redactSecretValues(nested)).toEqual(nested)` under the title "is
   * top-level only, like the answer shape it serves" — it PINNED the leak as
   * correct. The answer shape it "serves" is
   * `z.record(z.string(), z.unknown())`, which accepts arbitrary nesting, so
   * `{ profile: { apiKey: { kind:"new", value } } }` parsed and the plaintext
   * key was persisted into `messages.metadata.capturePart`. The rule is now
   * recursive, which is a strict superset of the flat contract the two other
   * callers rely on.
   */
  it("recurses into a nested object (was: passed it through)", () => {
    const out = redactSecretValues({
      group: { apiKey: { kind: "new", value: KEY } },
    }) as { group: { apiKey: { value: string } } };
    expect(out.group.apiKey.value).toBe(REDACTED_SECRET);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("recurses into arrays, and through arrays-of-objects", () => {
    const out = redactSecretValues({
      creds: [
        { kind: "new", value: KEY },
        { nested: [{ k: { kind: "new", value: KEY } }] },
      ],
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("keeps an `existing` ref at depth — a pointer is not a credential", () => {
    const out = redactSecretValues({
      a: { b: { apiKey: { kind: "existing", ref: "vault://abc" } } },
    });
    expect(JSON.stringify(out)).toContain("vault://abc");
  });

  it("keeps extra props on a tagged secret from smuggling the value out", () => {
    // `isSecretFieldValue` is a duck check, so `{kind:"new", value, copy}` is
    // still a secret — and the REPLACEMENT is a fresh two-key object, so any
    // sibling carrying the same string goes with it.
    const out = redactSecretValues({
      apiKey: { kind: "new", value: KEY, copy: KEY },
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("FAILS CLOSED past the depth bound — no pass-through", () => {
    // 8 levels deep, i.e. beyond REDACT_DEPTH_LIMIT (6).
    let deep: unknown = { apiKey: { kind: "new", value: KEY } };
    for (let i = 0; i < 8; i++) deep = { n: deep };
    const out = redactSecretValues(deep as Record<string, unknown>);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(JSON.stringify(out)).toContain(REDACTED_SECRET);
  });

  it("a `__proto__` key lands as an OWN property, not on the prototype", () => {
    const out = redactSecretValues(
      JSON.parse(
        '{"__proto__":{"apiKey":{"kind":"new","value":"sk-live-abc123"}}}'
      )
    );
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(({} as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it("the SIZE bound is still measured on the ORIGINAL, not the redacted copy", () => {
    // Discriminating row: the plaintext is far over 8KB, the redacted copy is
    // tiny. Redact-then-measure would ACCEPT it; measure-then-redact refuses.
    const huge = "x".repeat(CAPTURE_PART_LIMITS.formValuesMaxBytes + 100);
    expect(
      CaptureAnswerSchema.safeParse({
        type: "form",
        values: { deep: { apiKey: { kind: "new", value: huge } } },
      }).success
    ).toBe(false);
  });

  it("does not mutate its input", () => {
    const input = { apiKey: { kind: "new", value: KEY } };
    redactSecretValues(input);
    expect(input.apiKey.value).toBe(KEY);
  });

  it("uses the constant the client mirror pins", () => {
    expect(REDACTED_SECRET).toBe("[redacted]");
  });
});
