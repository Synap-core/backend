/**
 * The ASK — the ONE contract for "an agent needs something from a person, and
 * here is HOW to answer it". Carried on a human-owned session slot
 * (`ExpectedOutput.ask`, `@synap/playbooks`) and shared with capture's
 * follow-up questions (`../capture`), which import their chip / form / value
 * schemas from here rather than holding a second copy.
 *
 * Five modes, closed on purpose (the converged set across MCP elicitation,
 * AskUserQuestion, HumanLayer, Adaptive Cards, n8n, Step Functions — nobody
 * needed a sixth):
 *
 *   confirm  — yes / no (+ an optional note)
 *   choose   — one of ≤ 8 offered options (≤ 1 recommended), or free text if
 *              `allowOther`
 *   form     — a small FLAT form. AI-authored credential fields (by type, key
 *              or label) are DROPPED at the parse, exactly as capture does
 *   act      — do a thing in the world (optionally at an http(s) `url`, in ≤ 7
 *              `steps`), then say "I did this"
 *   provide  — hand over a connection / a file / a secret, through its OWN door
 *              (vault-first: the answer stores a REFERENCE, never the value)
 *
 * An ABSENT ask means today's behaviour exactly: a free-text answer, "I did
 * this", or "Not mine". `resolveAskResolution` names which door an ask resolves
 * through, and `validateAnswerAgainstAsk` is the ONE rule for whether an answer
 * fits the ask — pure, so the pod and every client apply the same check.
 *
 * Pure and dependency-free apart from zod and the sibling `vault` leaf.
 */

import { z } from "zod";
import {
  cleanFieldKey,
  isSecretFieldValue,
  isSensitiveField,
  isVaultReference,
  REDACT_DEPTH_LIMIT,
  REDACTED_SECRET,
  redactSecretValues,
  SECRET_TYPE_FIELDS,
} from "../vault/index.js";
import { isHttpUrl } from "../navigation/index.js";
import { resolveServiceName } from "../service-marks/index.js";

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Bounds shared by every door that writes or reads an ask or its answer. */
export const ASK_LIMITS = {
  /** A confirm's own question line. */
  promptMaxChars: 500,
  optionsMax: 8,
  optionLabelMaxChars: 80,
  optionValueMaxChars: 500,
  /** An option's one-line imperative consequence ("→ creates a positioning note"). */
  optionDescriptionMaxChars: 140,
  answerTextMaxChars: 2000,
  /** JSON-serialized form values, in UTF-8 bytes. */
  formValuesMaxBytes: 8 * 1024,
  formFieldsMax: 20,
  stepsMax: 7,
  stepMaxChars: 200,
  urlMaxChars: 2000,
  /** A provide(connection)'s service id, a provide(secret)'s name. */
  provideNameMaxChars: 120,
  acceptMax: 10,
  /** "What I looked at" — the objects the agent read before asking. */
  lookedAtMax: 8,
  lookedAtIdMaxChars: 200,
} as const;

// ─── Modes ──────────────────────────────────────────────────────────────────

export const ASK_MODES = [
  "confirm",
  "choose",
  "form",
  "act",
  "provide",
] as const;
export type AskMode = (typeof ASK_MODES)[number];

/** What a `provide` ask hands over — each through its own vault-first door. */
export const ASK_PROVIDE_KINDS = ["connection", "file", "secret"] as const;
export type AskProvideKind = (typeof ASK_PROVIDE_KINDS)[number];

// ─── Options (capture's chip, minus capture's own apply semantics) ──────────

/**
 * One offered answer. The base of capture's `FollowUpChipSchema`, which extends
 * it with the capture-only apply fields (`action`, `entityId`, `propertyKey`)
 * and makes `value` required — so the two can never disagree on a label bound
 * or on what `recommended` / `description` mean.
 */
export const AskOptionSchema = z.object({
  label: z.string().min(1).max(ASK_LIMITS.optionLabelMaxChars),
  /** Machine value; absent ⇒ the label IS the value. */
  value: z.string().max(ASK_LIMITS.optionValueMaxChars).optional(),
  icon: z.string().max(64).optional(),
  /** The AI's recommended answer — at most ONE per ask. */
  recommended: z.boolean().optional(),
  /** One-line imperative consequence of choosing this answer. */
  description: z.string().max(ASK_LIMITS.optionDescriptionMaxChars).optional(),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

/** True when no more than one option is marked `recommended`. */
export function atMostOneRecommended(
  options: ReadonlyArray<{ recommended?: boolean }>
): boolean {
  return options.filter((c) => c.recommended === true).length <= 1;
}

/** The identity an option is matched by: its value, else its label. */
export function askOptionKey(option: {
  label: string;
  value?: string;
}): string {
  return option.value ?? option.label;
}

// ─── Flat form (capture's DynamicFormSpec, moved here) ──────────────────────

/** One field. FLAT by construction: there is no nested-fields member. */
export const DynamicFormFieldSchema = z.object({
  key: z.string().min(1).max(200),
  label: z.string().max(200),
  type: z.string().max(64),
  constraints: z
    .object({
      enum: z.array(z.string()).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      pattern: z.string().optional(),
    })
    .optional(),
  required: z.boolean().optional(),
  help: z.string().optional(),
});
export type DynamicFormField = z.infer<typeof DynamicFormFieldSchema>;

/**
 * Field types an AI may NOT author on any ask wire (capture's follow-up form,
 * a slot's `form` ask).
 *
 * Credential prompts come from a capability MANIFEST (`installParamsToFormSpec`,
 * client-side), never from a model — and a value typed into an ask's form is
 * persisted (a room message part, a slot's answer), readable by every agent.
 * `type` is a FREE STRING, which is the whole reason a dropped-set exists: the
 * set once held only `"secret"`, so a model that wrote `type: "password"` got a
 * masked credential prompt anyway. A secret an agent needs is a `provide`
 * ask with `kind: 'secret'` — vault-first.
 *
 * Deliberately a DROPPED-SET and not a strict enum: `type` stays open so a new
 * NON-credential type (`"date"`, `"slider"`, …) keeps working without a
 * release. Matched case-, `-`/`_`/space-insensitively.
 *
 * ## DERIVED, not hand-written
 * `@synap-core/types/vault` owns the sensitivity table: every `!`-prefixed key
 * in `SECRET_TYPE_FIELDS` is, by that module's own definition, a credential. So
 * a field name the vault calls sensitive joins this set BY EXISTING.
 */

/** Lowercase, `-`/`_`/space-insensitive. The ONE normalisation for this set. */
function normaliseFieldType(type: string): string {
  return type.toLowerCase().replace(/[-_\s]+/g, "");
}

/**
 * The two `!`-fields too GENERIC to refuse as a form `type`: `env_variable`'s
 * `value` and `note`'s `content` are sensitive as vault FIELDS, but a form
 * field of type `"value"` is ordinary. Sensitivity is contextual in the vault;
 * the context does not survive the move to a field type.
 */
const NOT_A_CREDENTIAL_TYPE = new Set(["value", "content"]);

/**
 * Spellings a MODEL reaches for that are not vault field names: form-only
 * synonyms and the bare stems of compound `!`-fields (`cardCvv` → `cvv`).
 * Small, explicit, and the only hand-maintained part.
 */
const EXTRA_REFUSED_TYPES = [
  "secret",
  "secretkey",
  "token",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "apikey",
  "apisecret",
  "sshkey",
  "passwd",
  "credential",
  "credentials",
  "otp",
  "pin",
  "cvv",
] as const;

/** Every `!`-prefixed key in the vault's sensitivity table, normalised. */
const VAULT_SENSITIVE_TYPES = Object.values(SECRET_TYPE_FIELDS)
  .flat()
  .filter(isSensitiveField)
  .map((f) => normaliseFieldType(cleanFieldKey(f)))
  .filter((f) => !NOT_A_CREDENTIAL_TYPE.has(f));

export const ASK_REFUSED_FIELD_TYPES: readonly string[] = [
  ...new Set([...VAULT_SENSITIVE_TYPES, ...EXTRA_REFUSED_TYPES]),
];

const refusedTypes = new Set<string>(ASK_REFUSED_FIELD_TYPES);

/** Is this authored `type` a credential prompt? (normalised, never exact-match) */
export function isRefusedAskFieldType(type: unknown): boolean {
  if (typeof type !== "string") return false;
  return refusedTypes.has(normaliseFieldType(type));
}

/**
 * ## The NAME floor — `type` alone was not enough
 *
 * `{ key: "stripe_api_key", label: "Stripe secret key", type: "text" }` passed
 * the type check, and the key a person typed into it then sat in plaintext in
 * the answer's value and text, the room post, the event, the agent's
 * continuation and its next model turn. A field NAMED like a credential is a
 * credential prompt whatever its `type` says.
 *
 * A key or label is split into words (camelCase, `_`, `-`, spaces, acronyms)
 * and refused when any run of 1–3 adjacent words, joined, is a credential
 * name: the refused TYPES above (so the vault's table still feeds it) plus a
 * few compound names a model writes as two words. A run matches a WHOLE word
 * only: `tokenizer`, `keyword`, `passage` are not credentials.
 *
 * Deliberately FAIL-CLOSED (`password_hint` is dropped too): a wrongly dropped
 * field costs an agent one re-ask; a wrongly kept one leaks a key everywhere
 * the answer is copied. Three single words are too generic to refuse ALONE —
 * `key` ("Key date"), `certificate` ("Certificate of incorporation"), and the
 * two contextual vault fields above — they are refused only inside a compound
 * (`api key`, `private key`, `secret key`).
 *
 * What it CANNOT see: a person pasting a key into an ordinary field ("Notes").
 * It is a floor against an AI AUTHORING a credential prompt, not a scanner.
 */
const NOT_A_CREDENTIAL_NAME_ALONE = new Set([
  ...NOT_A_CREDENTIAL_TYPE,
  "key",
  "certificate",
]);

/** Compounds a model writes as words that are not vault field names. */
const EXTRA_CREDENTIAL_NAMES = [
  "accesskey",
  "signingkey",
  "encryptionkey",
  "masterkey",
  "licensekey",
  "pincode",
  "seedphrase",
  "recoveryphrase",
  "recoverycode",
  "backupcode",
] as const;

const credentialNames = new Set<string>(
  [...ASK_REFUSED_FIELD_TYPES, ...EXTRA_CREDENTIAL_NAMES].filter(
    (n) => !NOT_A_CREDENTIAL_NAME_ALONE.has(n)
  )
);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Is this field key / label NAMED like a credential? See the docblock above. */
export function isCredentialFieldName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const words = nameWords(name);
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      if (credentialNames.has(words.slice(i, i + n).join(""))) return true;
    }
  }
  return false;
}

/** A form field an AI may not author: credential TYPE, KEY or LABEL. */
export function isRefusedAskField(field: {
  key?: unknown;
  label?: unknown;
  type?: unknown;
}): boolean {
  return (
    isRefusedAskFieldType(field.type) ||
    isCredentialFieldName(field.key) ||
    isCredentialFieldName(field.label)
  );
}

export const DynamicFormSpecSchema = z.object({
  title: z.string().optional(),
  note: z.string().optional(),
  // Credential-ish fields are DROPPED, never persisted — by `type` (see
  // `ASK_REFUSED_FIELD_TYPES` for why the set is a set and why `type` stays an
  // open string) AND by key / label (`isCredentialFieldName`).
  fields: z
    .array(DynamicFormFieldSchema)
    .max(ASK_LIMITS.formFieldsMax)
    .transform((fields) => fields.filter((f) => !isRefusedAskField(f))),
});
export type DynamicFormSpec = z.infer<typeof DynamicFormSpecSchema>;

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Redact every value filed under a credential-NAMED key, at any depth (the
 * same bound as `redactSecretValues`, failing closed past it). A number, a
 * boolean, `null` and a tagged secret (an `existing` vault ref, or a `new` one
 * already redacted) pass through — none of them is a typed plaintext key.
 */
function redactCredentialKeyed(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isSecretFieldValue(value)) return value;
  if (depth >= REDACT_DEPTH_LIMIT) return REDACTED_SECRET;
  if (Array.isArray(value)) {
    return value.map((v) => redactCredentialKeyed(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const keep =
      v === null ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      isSecretFieldValue(v);
    Object.defineProperty(out, key, {
      value:
        isCredentialFieldName(key) && !keep
          ? REDACTED_SECRET
          : redactCredentialKeyed(v, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Form VALUES as a person submits them: bounded at 8KB serialized, then
 * redacted — AFTER the bound (measured on the original, so an oversized
 * payload cannot become acceptable by being redacted) and BEFORE anything
 * persists it, where a plaintext key would sit in a JSONB column, readable by
 * every agent, for the life of the row. Two redactions: every tagged
 * `{kind:"new"}` secret (`redactSecretValues`), and every value under a
 * credential-NAMED key (`isCredentialFieldName`) — the second catches a client
 * that submits a key as a plain string.
 */
export const AskFormValuesSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (v) => utf8Bytes(JSON.stringify(v)) <= ASK_LIMITS.formValuesMaxBytes,
    { message: "form values exceed 8KB serialized" }
  )
  .transform(
    (v) =>
      redactCredentialKeyed(redactSecretValues(v), 0) as Record<string, unknown>
  );

// ─── The ask ────────────────────────────────────────────────────────────────

const httpUrl = z
  .string()
  .max(ASK_LIMITS.urlMaxChars)
  .refine(isHttpUrl, "Must be an http(s) URL");

export const AskProvideSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("connection"),
    /** The third-party service id (`resolveServiceName` names it). */
    service: z.string().min(1).max(ASK_LIMITS.provideNameMaxChars),
  }),
  z.object({
    kind: z.literal("file"),
    /** Accepted media types / extensions (`image/*`, `.pdf`). Absent ⇒ any. */
    accept: z
      .array(z.string().min(1).max(100))
      .max(ASK_LIMITS.acceptMax)
      .optional(),
  }),
  z.object({
    kind: z.literal("secret"),
    /** What the secret is ("Stripe restricted key") — NEVER the secret. */
    name: z.string().min(1).max(ASK_LIMITS.provideNameMaxChars),
  }),
]);
export type AskProvide = z.infer<typeof AskProvideSchema>;

// ─── "What I looked at" ─────────────────────────────────────────────────────

/**
 * The object kinds an ask may cite as "what I looked at" — the kinds whose
 * visibility the pod can adjudicate and whose name it can resolve (a subset of
 * `OUTPUT_REF_KINDS`, `@synap/playbooks`; api asserts the subset at compile
 * time). Not `cell` (no backing row, nothing to name) and not a URL (a web page
 * the agent read is prose in `why`, not a door).
 */
export const ASK_LOOKED_AT_KINDS = [
  "entity",
  "document",
  "view",
  "automation",
  "playbook",
] as const;
export type AskLookedAtKind = (typeof ASK_LOOKED_AT_KINDS)[number];

/**
 * ONE thing the agent read before asking — trust-ladder rung 1, "a prepared
 * question: the agent gathered the data first, shows what it looked at".
 *
 * `{kind, id}` ONLY. A `title` an agent sends is STRIPPED at this parse (zod
 * drops unknown keys): the name the person reads is resolved server-side,
 * through the access floor, on the owed-slot read — never trusted from the
 * agent. The pod refuses a declared ref the declaring caller cannot see
 * (`findUnreachableOutputRefs`), exactly like a slot's `ref`.
 */
export const AskLookedAtRefSchema = z.object({
  kind: z.enum(ASK_LOOKED_AT_KINDS),
  id: z.string().min(1).max(ASK_LIMITS.lookedAtIdMaxChars),
});
export type AskLookedAtRef = z.infer<typeof AskLookedAtRefSchema>;

/** Shared by every mode: provenance is not a mode, it rides beside one. */
const lookedAtField = {
  /** At most {@link ASK_LIMITS.lookedAtMax}; more is REFUSED, never clipped. */
  lookedAt: z
    .array(AskLookedAtRefSchema)
    .max(ASK_LIMITS.lookedAtMax)
    .optional(),
};

export const AskSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("confirm"),
    prompt: z.string().max(ASK_LIMITS.promptMaxChars).optional(),
    ...lookedAtField,
  }),
  z.object({
    mode: z.literal("choose"),
    // "At most one recommended" is a CONTRACT rule enforced at the parse.
    options: z
      .array(AskOptionSchema)
      .min(1)
      .max(ASK_LIMITS.optionsMax)
      .refine(atMostOneRecommended, {
        message: "at most one option may be recommended",
      }),
    /** Offer "Other…" — a free-text answer instead of one of the options. */
    allowOther: z.boolean().optional(),
    ...lookedAtField,
  }),
  z.object({
    mode: z.literal("form"),
    // An ask whose every field was a refused credential would be an ask
    // nobody can answer — refused loudly rather than stored empty.
    form: DynamicFormSpecSchema.refine((f) => f.fields.length > 0, {
      message:
        "a form ask needs at least one answerable field (credential fields are dropped — ask for a secret with mode 'provide', kind 'secret')",
    }),
    ...lookedAtField,
  }),
  z.object({
    mode: z.literal("act"),
    /** Where to do it. Display/click-through only — the pod never fetches it. */
    url: httpUrl.optional(),
    steps: z
      .array(z.string().min(1).max(ASK_LIMITS.stepMaxChars))
      .max(ASK_LIMITS.stepsMax)
      .optional(),
    ...lookedAtField,
  }),
  z.object({
    mode: z.literal("provide"),
    provide: AskProvideSchema,
    ...lookedAtField,
  }),
]);
export type Ask = z.infer<typeof AskSchema>;

// ─── The answer's typed value ───────────────────────────────────────────────

/**
 * What a `provide` answer stores: a REFERENCE, never the value. The arm's
 * `kind` matches the ask's `provide.kind`.
 */
export const AskProvideRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("secret"),
    vaultRef: z.string().refine(isVaultReference, "Must be a vault://<uuid>"),
  }),
  // Both are ROW IDS (a `secrets` connection row, a file entity) — uuids. The
  // shape is the first floor against a plaintext credential pasted where a
  // reference belongs: it cannot parse, so it never reaches a row, an event or
  // a message. The answer door then checks the row is the answerer's.
  z.object({ kind: z.literal("connection"), connectionId: z.string().uuid() }),
  z.object({ kind: z.literal("file"), fileId: z.string().uuid() }),
]);
export type AskProvideRef = z.infer<typeof AskProvideRefSchema>;

/**
 * The TYPED half of a slot's answer (`SlotAnswer.value`). Its human-readable
 * summary stays on `SlotAnswer.text` (see {@link summarizeAnswer}), so every
 * reader that only knows text keeps working. A `text` answer's words live on
 * that `text` — the value only records that it WAS free text.
 */
export const AskAnswerValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("confirm"), confirmed: z.boolean() }),
  z.object({ type: z.literal("chip"), chip: AskOptionSchema }),
  z.object({ type: z.literal("form"), values: AskFormValuesSchema }),
  z.object({ type: z.literal("provide"), ref: AskProvideRefSchema }),
]);
export type AskAnswerValue = z.infer<typeof AskAnswerValueSchema>;

// ─── Rules ──────────────────────────────────────────────────────────────────

/**
 * Which door an ask resolves through.
 *   `answer` — input back to the agent (confirm / choose / form / provide):
 *              the answer door hands the slot back and wakes the agent.
 *   `attest` — `act`: the person did it; the attest door ("I did this").
 *   `legacy` — no ask: today's behaviour (free text, "I did this", "Not mine").
 */
export type AskResolution = "answer" | "attest" | "legacy";

export function resolveAskResolution(
  ask: Pick<Ask, "mode"> | null | undefined
): AskResolution {
  if (!ask) return "legacy";
  return ask.mode === "act" ? "attest" : "answer";
}

export type AskAnswerRefusalCode =
  | "wrong_door"
  | "type_mismatch"
  | "not_offered"
  | "other_not_allowed"
  | "text_required"
  | "unknown_field"
  | "missing_field"
  | "invalid_field"
  | "provide_mismatch"
  /**
   * The pod's own check (not this pure rule): the reference names nothing the
   * answerer owns or can see — an unknown / deleted / someone else's secret,
   * connection or file. Never echoes the reference.
   */
  | "provide_unreachable";

export type AskAnswerValidation =
  | {
      ok: true;
      /**
       * The value to STORE. For a chip this is the OFFERED option, never the
       * caller's copy — a client cannot restyle an option's consequence or
       * mark its own pick "recommended".
       */
      value: AskAnswerValue;
    }
  | { ok: false; code: AskAnswerRefusalCode; message: string };

function refuse(
  code: AskAnswerRefusalCode,
  message: string
): AskAnswerValidation {
  return { ok: false, code, message };
}

function isBlank(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0)
  );
}

/**
 * Does this answer fit this ask? The ONE rule, pure — the pod's answer door and
 * every client call it, so a client never offers what the pod would refuse.
 *
 * `value` must already be a parsed {@link AskAnswerValue} (form values are then
 * already bounded and redacted). `text` is the accompanying free text: required
 * for a `text` answer, an optional note otherwise.
 *
 * - no ask ⇒ only free text (today's behaviour).
 * - `act` ⇒ refused (`wrong_door`): it resolves through the attest door.
 * - `confirm` ⇒ a confirm value.
 * - `choose` ⇒ one of the OFFERED options (matched by value, else label), or
 *   free text only when `allowOther`.
 * - `form` ⇒ keys the spec declares, every required field present, enum
 *   constraints honoured.
 * - `provide` ⇒ a reference of the kind the ask asked for.
 */
export function validateAnswerAgainstAsk(
  ask: Ask | null | undefined,
  value: AskAnswerValue,
  text?: string | null
): AskAnswerValidation {
  const hasText = typeof text === "string" && text.trim().length > 0;
  if (value.type === "text" && !hasText) {
    return refuse("text_required", "A free-text answer needs its text.");
  }
  if (!ask) {
    return value.type === "text"
      ? { ok: true, value }
      : refuse(
          "type_mismatch",
          "This slot asks for a free-text answer — there is no typed ask on it."
        );
  }
  switch (ask.mode) {
    case "act":
      return refuse(
        "wrong_door",
        'This ask is something to DO — say "I did this" (attest), not an answer.'
      );
    case "confirm":
      return value.type === "confirm"
        ? { ok: true, value }
        : refuse("type_mismatch", "This ask takes a yes or a no.");
    case "choose": {
      if (value.type === "text") {
        return ask.allowOther
          ? { ok: true, value }
          : refuse(
              "other_not_allowed",
              "Pick one of the offered options — this ask does not take another answer."
            );
      }
      if (value.type !== "chip") {
        return refuse("type_mismatch", "This ask takes one of its options.");
      }
      const wanted = askOptionKey(value.chip);
      const offered = ask.options.find((o) => askOptionKey(o) === wanted);
      return offered
        ? { ok: true, value: { type: "chip", chip: offered } }
        : refuse(
            "not_offered",
            `"${value.chip.label}" is not one of the offered options.`
          );
    }
    case "form": {
      if (value.type !== "form") {
        return refuse("type_mismatch", "This ask takes the form's values.");
      }
      const fields = new Map(ask.form.fields.map((f) => [f.key, f]));
      for (const key of Object.keys(value.values)) {
        if (!fields.has(key)) {
          return refuse(
            "unknown_field",
            `"${key}" is not a field of this form.`
          );
        }
      }
      for (const field of ask.form.fields) {
        const v = value.values[field.key];
        if (field.required && isBlank(v)) {
          return refuse(
            "missing_field",
            `"${field.label || field.key}" is required.`
          );
        }
        const allowed = field.constraints?.enum;
        if (allowed && !isBlank(v)) {
          const picked = Array.isArray(v) ? v : [v];
          if (
            !picked.every((p) => typeof p === "string" && allowed.includes(p))
          ) {
            return refuse(
              "invalid_field",
              `"${field.label || field.key}" must be one of: ${allowed.join(", ")}.`
            );
          }
        }
      }
      return { ok: true, value };
    }
    case "provide":
      if (value.type !== "provide") {
        return refuse(
          "type_mismatch",
          "This ask takes a reference, not a value."
        );
      }
      return value.ref.kind === ask.provide.kind
        ? { ok: true, value }
        : refuse(
            "provide_mismatch",
            `This ask wants a ${ask.provide.kind}, not a ${value.ref.kind}.`
          );
  }
}

// ─── The ask as answered (frozen snapshot) ──────────────────────────────────

/**
 * The ask AS IT WAS POSED, frozen onto the answer the moment it lands
 * (`SlotAnswer.askSnapshot`, `@synap/playbooks`).
 *
 * WHY. Answering hands a human slot back to the agent, and the hand-back
 * clears `ask` / `why` (`stampUnblocked`) — so the option set, the option the
 * agent RECOMMENDED and what it looked at were gone the moment the person
 * chose. "The AI recommended EU, the person picked US" is exactly the signal a
 * decision mesh learns from, and it was the first thing thrown away.
 *
 * `chosenKey` is the picked option's identity (`askOptionKey`) for a choose,
 * `"yes"` / `"no"` for a confirm, and `null` for anything else (a free-text
 * "Other…", a room reply in words, a form, a provide). `followedRecommendation`
 * is `null` when there was no recommendation to follow — NEVER `false`, which
 * would read as the person overruling advice nobody gave.
 *
 * `lookedAt` is stored as `{kind, id}` only: the server-resolved `title` the
 * owed read adds is a per-viewer projection, never data.
 */
export const AskSnapshotSchema = z.object({
  mode: z.enum(ASK_MODES),
  /** A confirm's own question line. */
  prompt: z.string().max(ASK_LIMITS.promptMaxChars).optional(),
  /** The slot's `why` when it was asked (cleared by the hand-back). */
  why: z.string().max(500).optional(),
  /** A choose's FULL option list, `recommended` flag included. */
  options: z.array(AskOptionSchema).max(ASK_LIMITS.optionsMax).optional(),
  chosenKey: z.string().nullable(),
  recommendedKey: z.string().nullable(),
  followedRecommendation: z.boolean().nullable(),
  lookedAt: z
    .array(AskLookedAtRefSchema)
    .max(ASK_LIMITS.lookedAtMax)
    .optional(),
});
export type AskSnapshot = z.infer<typeof AskSnapshotSchema>;

/** The confirm arm's two keys — what `chosenKey` holds for a yes / a no. */
export const ASK_CONFIRM_KEYS = { yes: "yes", no: "no" } as const;

/**
 * Freeze an ask + the answer given to it. Pure. `value` absent ⇒ an answer in
 * words (the room-reply entrance), whose pick is unknown.
 */
export function buildAskSnapshot(
  ask: Ask,
  value: AskAnswerValue | null | undefined,
  why?: string | null
): AskSnapshot {
  const options = ask.mode === "choose" ? ask.options : undefined;
  const recommended = options?.find((o) => o.recommended === true);
  const recommendedKey = recommended ? askOptionKey(recommended) : null;
  const chosenKey =
    value?.type === "chip"
      ? askOptionKey(value.chip)
      : value?.type === "confirm"
        ? value.confirmed
          ? ASK_CONFIRM_KEYS.yes
          : ASK_CONFIRM_KEYS.no
        : null;
  // Unknown pick (words, not a chip) ⇒ unknown, not "overruled".
  const followedRecommendation =
    recommendedKey === null
      ? null
      : value?.type === "chip"
        ? chosenKey === recommendedKey
        : value?.type === "text"
          ? false
          : null;
  const prompt = ask.mode === "confirm" ? ask.prompt?.trim() : undefined;
  const trimmedWhy = typeof why === "string" ? why.trim() : "";
  return {
    mode: ask.mode,
    ...(prompt ? { prompt } : {}),
    ...(trimmedWhy ? { why: trimmedWhy.slice(0, 500) } : {}),
    ...(options ? { options: options.map((o) => ({ ...o })) } : {}),
    chosenKey,
    recommendedKey,
    followedRecommendation,
    ...(ask.lookedAt?.length
      ? { lookedAt: ask.lookedAt.map(({ kind, id }) => ({ kind, id })) }
      : {}),
  };
}

function formatFormValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(formatFormValue).join(", ");
  return JSON.stringify(v);
}

/**
 * The human-readable line that stays on `SlotAnswer.text` — so every reader
 * that predates the typed value (the CLI's `session wait`, the room post, the
 * agent's continuation packet) keeps reading a sentence. What keeps a secret
 * OFF it is upstream, and it is a floor, not a guarantee: credential-named or
 * -typed form fields are dropped when the ask is parsed, tagged secrets and
 * values under credential-named keys are redacted when the values are parsed,
 * and a `provide` answer names the KIND of thing handed over, never a
 * reference's contents. A key a person pastes into an ordinary field ("Notes")
 * is not detectable here and WILL be summarised.
 *
 * `text` (the free text or note) is appended after an em dash when present.
 */
export function summarizeAnswer(
  ask: Ask | null | undefined,
  value: AskAnswerValue,
  text?: string | null,
  /**
   * The provided thing's DISPLAY name, when the caller resolved it (the pod's
   * answer door reads the file's title after checking it is visible). Never a
   * reference, never a value.
   */
  opts?: { refName?: string | null }
): string {
  const note = typeof text === "string" ? text.trim() : "";
  const withNote = (head: string) => (note ? `${head} — ${note}` : head);
  switch (value.type) {
    case "text":
      return note;
    case "confirm":
      return withNote(value.confirmed ? "Yes" : "No");
    case "chip":
      return withNote(value.chip.label);
    case "form": {
      const labels = new Map(
        ask?.mode === "form"
          ? ask.form.fields.map((f) => [f.key, f.label || f.key])
          : []
      );
      const parts = Object.entries(value.values)
        .filter(([, v]) => !isBlank(v))
        .map(([k, v]) => `${labels.get(k) ?? k}: ${formatFormValue(v)}`);
      return withNote(parts.join("; ") || "Submitted the form");
    }
    case "provide": {
      const head =
        value.ref.kind === "secret"
          ? `Stored the secret${ask?.mode === "provide" && ask.provide.kind === "secret" ? ` "${ask.provide.name}"` : ""} in the vault`
          : value.ref.kind === "connection"
            ? `Connected${ask?.mode === "provide" && ask.provide.kind === "connection" ? ` ${resolveServiceName(ask.provide.service)}` : " the account"}`
            : opts?.refName?.trim()
              ? `Attached "${opts.refName.trim()}"`
              : "Attached a file";
      return withNote(head);
    }
  }
}

// ─── Door helpers (shared by the pod's doors and every client) ──────────────

/**
 * Can this ask be answered IN the row, without opening anything? A yes/no, or
 * a pick among ≤ 3 fixed options. Anything wider (a form, a provide, "Other…",
 * a long option list) needs its own sheet. An absent ask is a free-text answer
 * and is never inline.
 */
export function askAnswersInline(ask: Ask | null | undefined): boolean {
  if (!ask) return false;
  if (ask.mode === "confirm") return true;
  return (
    ask.mode === "choose" && ask.options.length <= 3 && ask.allowOther !== true
  );
}

/** JSON with object keys SORTED at every depth and `undefined` dropped. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * A stable fingerprint of an ask — what a client answered AGAINST. The client
 * sends it with its answer; the pod compares it with the slot's CURRENT ask and
 * refuses with `ask_changed:` when the agent re-asked in between (so a person
 * never answers a question they were not shown).
 *
 * Key-order independent on purpose: the ask is stored in JSONB, which does NOT
 * preserve key order, so a client that fingerprints the ask it READ must get
 * the same value the pod computes from the same row. `undefined` members are
 * ignored for the same reason (JSON never carries them). An absent ask is
 * `"none"`. The hash is 53-bit cyrb53 — a change detector, not a MAC.
 *
 * `lookedAt` is OUTSIDE the fingerprint: it is provenance, not the question.
 * The owed read resolves each ref's `title` into it for the viewer, so a client
 * fingerprinting the ask it READ would otherwise never match the stored one.
 */
export function askFingerprint(ask: Ask | null | undefined): string {
  if (!ask) return "none";
  const { lookedAt: _provenance, ...question } = ask;
  const text = canonicalJson(question);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Message prefixes the pod's answer / attest doors put on the two ask
 * refusals, so a client can tell them apart without parsing prose:
 *   `ask_changed:` — CONFLICT: the slot's ask is no longer the one answered.
 *   `ask_invalid:` — BAD_REQUEST: the answer does not fit the ask (or the ask
 *                   resolves through the other door).
 */
export const ASK_CHANGED_PREFIX = "ask_changed:";
export const ASK_INVALID_PREFIX = "ask_invalid:";

/**
 * The phrases the slot doors use when the slot MOVED ON under the person —
 * delivered, retired, no longer declared, or no longer theirs. The doors build
 * their refusal messages FROM these, so {@link askRefusalIsStale} matches the
 * pod's own words rather than a copy of them.
 */
export const SLOT_MOVED_ON_PHRASES = {
  alreadyDone: "is already delivered",
  retired: "was retired",
  unknownLabel: "declares no output labelled",
  notOwedByYou: "is not blocked on you",
} as const;

/**
 * Is this refusal STALE — the ask changed or the slot moved on — as opposed to
 * a wrong answer? A stale refusal means "re-read the slot and re-render, keep
 * the draft"; a wrong answer means "fix the input".
 */
export function askRefusalIsStale(message: string | null | undefined): boolean {
  if (typeof message !== "string") return false;
  if (message.startsWith(ASK_CHANGED_PREFIX)) return true;
  if (message.startsWith(ASK_INVALID_PREFIX)) return false;
  return Object.values(SLOT_MOVED_ON_PHRASES).some((p) => message.includes(p));
}

/** Re-exported beside the form-values schema that applies it. */
export { redactSecretValues } from "../vault/index.js";

/** A playbook param as an ask — see `./param.ts`. */
export {
  PLAYBOOK_PARAM_TYPES,
  PLAYBOOK_PARAM_FIELD_TYPE,
  playbookParamFieldType,
  playbookParamAsk,
  type PlaybookParamTypeName,
  type PlaybookParamLike,
} from "./param.js";

/** The Ask card's shared surface rules and copy — see `./card.ts`. */
export {
  ASK_COPY,
  LOOKED_AT_ROW_CAP,
  askSlotStanding,
  classifyAskRefusal,
  askRowRegion,
  askOptionChips,
  askOptionForChip,
  actView,
  askRecommendationOutcome,
  type AskRecommendationOutcome,
  type AskRecommendationOutcomeKind,
  type AskSlotLite,
  type AskSlotStanding,
  type AskRefusal,
  type AskRefusalKind,
  type AskRowRegion,
  type AskOptionChip,
  type ActView,
} from "./card.js";
