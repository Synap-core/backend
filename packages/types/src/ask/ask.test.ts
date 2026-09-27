import { describe, expect, it } from "vitest";
import {
  AskAnswerValueSchema,
  AskSchema,
  ASK_CHANGED_PREFIX,
  ASK_INVALID_PREFIX,
  ASK_MODES,
  askAnswersInline,
  askFingerprint,
  askRefusalIsStale,
  SLOT_MOVED_ON_PHRASES,
  resolveAskResolution,
  summarizeAnswer,
  validateAnswerAgainstAsk,
  type Ask,
  type AskAnswerValue,
} from "./index.js";
import { REDACTED_SECRET } from "../vault/index.js";
import { isHttpUrl } from "../navigation/index.js";

const VAULT_REF = "vault://123e4567-e89b-42d3-a456-426614174000";

const choose: Ask = AskSchema.parse({
  mode: "choose",
  options: [
    {
      label: "Ship Friday",
      value: "fri",
      recommended: true,
      description: "→ tags the release",
    },
    { label: "Wait a week" },
  ],
});

const form: Ask = AskSchema.parse({
  mode: "form",
  form: {
    fields: [
      {
        key: "region",
        label: "Region",
        type: "select",
        required: true,
        constraints: { enum: ["eu", "us"] },
      },
      { key: "note", label: "Note", type: "text" },
    ],
  },
});

describe("AskSchema", () => {
  it("parses one ask of every mode", () => {
    const samples: Record<(typeof ASK_MODES)[number], unknown> = {
      confirm: { mode: "confirm", prompt: "Send the invoice?" },
      choose: { mode: "choose", options: [{ label: "A" }], allowOther: true },
      form: {
        mode: "form",
        form: { fields: [{ key: "k", label: "K", type: "text" }] },
      },
      act: {
        mode: "act",
        url: "https://dashboard.stripe.com/apikeys",
        steps: ["Open", "Copy"],
      },
      provide: {
        mode: "provide",
        provide: { kind: "secret", name: "Stripe key" },
      },
    };
    for (const mode of ASK_MODES) {
      expect(AskSchema.safeParse(samples[mode]).success, mode).toBe(true);
    }
  });

  it("refuses more than one recommended option", () => {
    const r = AskSchema.safeParse({
      mode: "choose",
      options: [
        { label: "A", recommended: true },
        { label: "B", recommended: true },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("refuses more than 8 options and an empty option list", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` }));
    expect(AskSchema.safeParse({ mode: "choose", options: many }).success).toBe(
      false
    );
    expect(AskSchema.safeParse({ mode: "choose", options: [] }).success).toBe(
      false
    );
  });

  it("DROPS an AI-authored credential field from a form (capture's rule)", () => {
    const parsed = AskSchema.parse({
      mode: "form",
      form: {
        fields: [
          { key: "k", label: "Key", type: "api_key" },
          { key: "p", label: "Password", type: "password" },
          { key: "n", label: "Name", type: "text" },
        ],
      },
    });
    expect(
      parsed.mode === "form" && parsed.form.fields.map((f) => f.key)
    ).toEqual(["n"]);
  });

  it("REFUSES a form whose every field was a credential (nothing left to answer)", () => {
    const r = AskSchema.safeParse({
      mode: "form",
      form: { fields: [{ key: "k", label: "Key", type: "secret" }] },
    });
    expect(r.success).toBe(false);
  });

  it("refuses a non-http(s) act url and more than 7 steps", () => {
    expect(
      AskSchema.safeParse({ mode: "act", url: "javascript:alert(1)" }).success
    ).toBe(false);
    expect(
      AskSchema.safeParse({
        mode: "act",
        steps: Array.from({ length: 8 }, () => "x"),
      }).success
    ).toBe(false);
  });

  it("refuses an unknown mode", () => {
    expect(AskSchema.safeParse({ mode: "grade" }).success).toBe(false);
  });
});

describe("AskAnswerValueSchema", () => {
  it("redacts secret-shaped form values after the size bound", () => {
    const v = AskAnswerValueSchema.parse({
      type: "form",
      values: { token: { kind: "new", value: "sk_live_xyz" }, name: "ok" },
    });
    expect(v.type === "form" && JSON.stringify(v.values)).not.toContain(
      "sk_live_xyz"
    );
    expect(v.type === "form" && JSON.stringify(v.values)).toContain(
      REDACTED_SECRET
    );
  });

  it("refuses form values over 8KB", () => {
    const r = AskAnswerValueSchema.safeParse({
      type: "form",
      values: { big: "x".repeat(9000) },
    });
    expect(r.success).toBe(false);
  });

  it("only accepts a well-formed vault:// ref for a secret", () => {
    expect(
      AskAnswerValueSchema.safeParse({
        type: "provide",
        ref: { kind: "secret", vaultRef: VAULT_REF },
      }).success
    ).toBe(true);
    expect(
      AskAnswerValueSchema.safeParse({
        type: "provide",
        ref: { kind: "secret", vaultRef: "sk_live_plaintext" },
      }).success
    ).toBe(false);
  });
});

describe("resolveAskResolution", () => {
  it("act → attest, every other mode → answer, no ask → legacy", () => {
    expect(resolveAskResolution(undefined)).toBe("legacy");
    expect(resolveAskResolution(null)).toBe("legacy");
    for (const mode of ASK_MODES) {
      expect(resolveAskResolution({ mode })).toBe(
        mode === "act" ? "attest" : "answer"
      );
    }
  });
});

describe("validateAnswerAgainstAsk", () => {
  const ok = (ask: Ask | undefined, value: AskAnswerValue, text?: string) =>
    validateAnswerAgainstAsk(ask, value, text);

  it("no ask: free text only, and the text is required", () => {
    expect(ok(undefined, { type: "text" }, "use the EU account").ok).toBe(true);
    expect(ok(undefined, { type: "text" }, "  ")).toMatchObject({
      ok: false,
      code: "text_required",
    });
    expect(ok(undefined, { type: "confirm", confirmed: true })).toMatchObject({
      ok: false,
      code: "type_mismatch",
    });
  });

  it("act is refused — it resolves through the attest door", () => {
    expect(ok({ mode: "act" }, { type: "text" }, "done")).toMatchObject({
      ok: false,
      code: "wrong_door",
    });
  });

  it("confirm takes a confirm value only", () => {
    expect(
      ok({ mode: "confirm" }, { type: "confirm", confirmed: false }).ok
    ).toBe(true);
    expect(ok({ mode: "confirm" }, { type: "text" }, "maybe")).toMatchObject({
      ok: false,
      code: "type_mismatch",
    });
  });

  it("choose: an offered option is stored as the OFFERED copy, never the caller's", () => {
    const r = ok(choose, {
      type: "chip",
      chip: { label: "whatever", value: "fri", description: "forged" },
    });
    expect(r).toEqual({
      ok: true,
      value: {
        type: "chip",
        chip: {
          label: "Ship Friday",
          value: "fri",
          recommended: true,
          description: "→ tags the release",
        },
      },
    });
    // Matched by label when the option has no value.
    expect(
      ok(choose, { type: "chip", chip: { label: "Wait a week" } }).ok
    ).toBe(true);
  });

  it("choose: an option that was not offered is refused", () => {
    expect(
      ok(choose, { type: "chip", chip: { label: "Ship now", value: "now" } })
    ).toMatchObject({
      ok: false,
      code: "not_offered",
    });
  });

  it("choose: free text only when allowOther", () => {
    expect(ok(choose, { type: "text" }, "next quarter")).toMatchObject({
      ok: false,
      code: "other_not_allowed",
    });
    const withOther: Ask = {
      ...(choose as Extract<Ask, { mode: "choose" }>),
      allowOther: true,
    };
    expect(ok(withOther, { type: "text" }, "next quarter").ok).toBe(true);
  });

  it("form: required, unknown keys and enum constraints", () => {
    expect(ok(form, { type: "form", values: { region: "eu" } }).ok).toBe(true);
    expect(ok(form, { type: "form", values: { note: "x" } })).toMatchObject({
      ok: false,
      code: "missing_field",
    });
    expect(
      ok(form, { type: "form", values: { region: "eu", extra: 1 } })
    ).toMatchObject({ ok: false, code: "unknown_field" });
    expect(
      ok(form, { type: "form", values: { region: "apac" } })
    ).toMatchObject({ ok: false, code: "invalid_field" });
  });

  it("provide: the reference kind must match what was asked", () => {
    const ask: Ask = {
      mode: "provide",
      provide: { kind: "secret", name: "Stripe key" },
    };
    expect(
      ok(ask, { type: "provide", ref: { kind: "secret", vaultRef: VAULT_REF } })
        .ok
    ).toBe(true);
    expect(
      ok(ask, { type: "provide", ref: { kind: "file", fileId: "f1" } })
    ).toMatchObject({
      ok: false,
      code: "provide_mismatch",
    });
    expect(ok(ask, { type: "text" }, "sk_live_plaintext")).toMatchObject({
      ok: false,
      code: "type_mismatch",
    });
  });
});

describe("summarizeAnswer", () => {
  it("renders every value as the human line that stays on SlotAnswer.text", () => {
    expect(summarizeAnswer(undefined, { type: "text" }, " use EU ")).toBe(
      "use EU"
    );
    expect(
      summarizeAnswer(
        { mode: "confirm" },
        { type: "confirm", confirmed: true },
        "go"
      )
    ).toBe("Yes — go");
    expect(
      summarizeAnswer(choose, {
        type: "chip",
        chip: { label: "Ship Friday", value: "fri" },
      })
    ).toBe("Ship Friday");
    expect(
      summarizeAnswer(form, {
        type: "form",
        values: { region: "eu", note: "" },
      })
    ).toBe("Region: eu");
    expect(
      summarizeAnswer(
        { mode: "provide", provide: { kind: "secret", name: "Stripe key" } },
        { type: "provide", ref: { kind: "secret", vaultRef: VAULT_REF } }
      )
    ).toBe('Stored the secret "Stripe key" in the vault');
  });

  it("never carries a secret or a vault ref into the text", () => {
    const value = AskAnswerValueSchema.parse({
      type: "form",
      values: { region: "eu", token: { kind: "new", value: "sk_live_xyz" } },
    });
    expect(summarizeAnswer(undefined, value)).not.toContain("sk_live_xyz");
    expect(
      summarizeAnswer(undefined, {
        type: "provide",
        ref: { kind: "secret", vaultRef: VAULT_REF },
      })
    ).not.toContain("vault://");
  });
});

describe("isHttpUrl (the one link rule)", () => {
  it("opens http and https only", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("http://localhost:3000/x")).toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "synap://x",
      "not a url",
      42,
      null,
    ]) {
      expect(isHttpUrl(bad), String(bad)).toBe(false);
    }
  });
});

describe("askAnswersInline", () => {
  it("confirm and a short closed choose answer in the row", () => {
    expect(askAnswersInline(AskSchema.parse({ mode: "confirm" }))).toBe(true);
    expect(askAnswersInline(choose)).toBe(true);
  });

  it("a wide choose, 'Other…', a form, act, provide and no ask do not", () => {
    const four = AskSchema.parse({
      mode: "choose",
      options: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }],
    });
    const other = AskSchema.parse({
      mode: "choose",
      options: [{ label: "a" }],
      allowOther: true,
    });
    expect(askAnswersInline(four)).toBe(false);
    expect(askAnswersInline(other)).toBe(false);
    expect(askAnswersInline(form)).toBe(false);
    expect(askAnswersInline(AskSchema.parse({ mode: "act" }))).toBe(false);
    expect(
      askAnswersInline(
        AskSchema.parse({
          mode: "provide",
          provide: { kind: "secret", name: "Stripe key" },
        })
      )
    ).toBe(false);
    expect(askAnswersInline(null)).toBe(false);
    expect(askAnswersInline(undefined)).toBe(false);
  });
});

describe("askFingerprint", () => {
  it("is stable across key order (JSONB does not keep it) and undefined members", () => {
    const a = askFingerprint({
      mode: "choose",
      options: [{ label: "Ship", value: "s", recommended: true }],
      allowOther: false,
    });
    const b = askFingerprint({
      allowOther: false,
      options: [
        { recommended: true, value: "s", label: "Ship", icon: undefined },
      ],
      mode: "choose",
    } as Ask);
    expect(a).toBe(b);
    // Round-tripped through JSON (what a client reads back) — same value.
    expect(askFingerprint(JSON.parse(JSON.stringify(choose)) as Ask)).toBe(
      askFingerprint(choose)
    );
  });

  it("changes when the ask changes — options, their order, the mode", () => {
    const base = askFingerprint(choose);
    const relabelled = askFingerprint(
      AskSchema.parse({
        mode: "choose",
        options: [
          { label: "Ship Monday", value: "fri", recommended: true },
          { label: "Wait a week" },
        ],
      })
    );
    const reordered = askFingerprint(
      AskSchema.parse({
        mode: "choose",
        options: [
          { label: "Wait a week" },
          {
            label: "Ship Friday",
            value: "fri",
            recommended: true,
            description: "→ tags the release",
          },
        ],
      })
    );
    expect(relabelled).not.toBe(base);
    expect(reordered).not.toBe(base);
    expect(askFingerprint(AskSchema.parse({ mode: "confirm" }))).not.toBe(base);
  });

  it("an absent ask is 'none'", () => {
    expect(askFingerprint(null)).toBe("none");
    expect(askFingerprint(undefined)).toBe("none");
  });
});

describe("askRefusalIsStale", () => {
  it("ask_changed and every slot-moved-on phrase are stale", () => {
    expect(
      askRefusalIsStale(`${ASK_CHANGED_PREFIX} the question changed`)
    ).toBe(true);
    const phrases = Object.values(SLOT_MOVED_ON_PHRASES);
    expect(phrases.length).toBeGreaterThanOrEqual(4);
    for (const phrase of phrases) {
      expect(askRefusalIsStale(`"Stripe key" ${phrase}`)).toBe(true);
    }
  });

  it("a wrong answer, an empty answer and a non-string are not", () => {
    expect(
      askRefusalIsStale(
        `${ASK_INVALID_PREFIX} "x" is not one of the offered options.`
      )
    ).toBe(false);
    expect(askRefusalIsStale("The answer is empty")).toBe(false);
    expect(askRefusalIsStale(undefined)).toBe(false);
  });
});
