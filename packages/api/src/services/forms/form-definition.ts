/**
 * PUBLIC FORM DEFINITION (Sites W4) — the stored shape, and every PURE rule the
 * guest door applies to it. Zod + node:crypto only; no database, no router.
 *
 * A form is an inbound `tools` row (the Cal.com / Mailgun pattern) whose
 * `metadata.form` holds {@link StoredFormDefinition}. The row is written ONLY by
 * the forms door (`form-service.ts`); the generic `tools.*` doors refuse any
 * row carrying `metadata.form` ({@link isFormToolMetadata}), because
 * `tools.update` edits metadata with no governance check.
 *
 * THE ANONYMOUS CALLER CONTROLS NOTHING BUT FIELD VALUES. Kind, facet,
 * workspace, actor, mode and title come from the stored row. A submitted key
 * the form does not declare is dropped; a value of the wrong type drops the
 * whole submission (strict, never coerced from an object/array).
 *
 * Intake only: the door files exactly one `entity.create`. There is no update
 * or delete anywhere in this module, and the actor's capability list is
 * exactly {@link FORM_ACTOR_CAPABILITIES} — never empty, because an empty
 * list means UNRESTRICTED to the governance engine.
 */

import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";

// ── Allowlists ───────────────────────────────────────────────────────────────

/**
 * The kinds a guest form may create. A code allowlist, checked at definition
 * write AND at submit: an owner cannot point a public form at a structural kind
 * (workspace, project, agent, file…) by editing a stored row.
 */
export const GUEST_FORM_KINDS = ["person", "company", "note", "task"] as const;
export type GuestFormKind = (typeof GUEST_FORM_KINDS)[number];

/** The kind a SUBMISSION NOTE is filed as when an identity signal matched. */
export const SUBMISSION_NOTE_KIND = "note" as const;

/** The ONLY capability a form actor holds. Non-empty by construction. */
export const FORM_ACTOR_CAPABILITIES = ["entity.create"] as const;

/** The actor's agentType: one actor per form, and the uniqueness key. */
export const FORM_ACTOR_TYPE_PREFIX = "form:";
export function formActorType(formId: string): string {
  return `${FORM_ACTOR_TYPE_PREFIX}${formId}`;
}
/** True for an agentType minted by the forms door (provenance, never auth). */
export function isFormActorType(agentType: unknown): boolean {
  return (
    typeof agentType === "string" &&
    agentType.startsWith(FORM_ACTOR_TYPE_PREFIX)
  );
}

/** `governance_rules.created_by` namespace for the per-form mode rule. */
export function formRuleCreatedBy(formId: string): string {
  return `system:forms:${formId}`;
}

/** The field kinds a guest may fill (a narrow subset of DynamicFormField). */
export const GUEST_FIELD_TYPES = [
  "text",
  "richtext",
  "email",
  "phone",
  "url",
  "number",
  "boolean",
  "date",
  "enum",
] as const;
export type GuestFieldType = (typeof GUEST_FIELD_TYPES)[number];

/**
 * Property keys a form may never write: identity/ownership columns and the
 * body. A strong identity key (email, phone…) IS allowed as a property — it is
 * how a person form works — but the door pre-resolves it (see guest-submit).
 */
const RESERVED_PROPERTY_KEYS = new Set([
  "id",
  "userId",
  "workspaceId",
  "profileId",
  "profileSlug",
  "agentUserId",
  "createdBy",
  "createdByUserId",
  "createdByKind",
  "sourceProposalId",
  "content",
  "documentId",
  "title",
  "global",
  "facets",
]);

/** The honeypot key in the submission envelope. */
export const HONEYPOT_FIELD = "hp";

// ── Stored shape ─────────────────────────────────────────────────────────────

const KEY = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_-]{0,63}$/, "lower-camel/kebab key")
  .refine((k) => !RESERVED_PROPERTY_KEYS.has(k), "reserved key");

export const FormFieldSchema = z
  .object({
    /** Answer key in the submission AND the property slug written. */
    key: KEY,
    label: z.string().min(1).max(200),
    type: z.enum(GUEST_FIELD_TYPES),
    required: z.boolean().optional(),
    help: z.string().max(500).optional(),
    constraints: z
      .object({
        enum: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
        maxLength: z.number().int().min(1).max(5000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.type === "enum" && !f.constraints?.enum?.length) {
      ctx.addIssue({ code: "custom", message: "enum field needs options" });
    }
  });
export type FormField = z.infer<typeof FormFieldSchema>;

const FacetSchema = z
  .object({
    profileSlug: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    /** Static, owner-set facet props (e.g. `lead-source: "form"`). */
    properties: z
      .record(
        z.string().max(64),
        z.union([z.string().max(500), z.number().finite(), z.boolean()])
      )
      .optional(),
  })
  .strict();

/** What the OWNER may set. Token, actor and secrets are server-owned. */
export const FormConfigSchema = z
  .object({
    name: z.string().min(1).max(200),
    kind: z.enum(GUEST_FORM_KINDS),
    facet: FacetSchema.nullable().optional(),
    fields: z.array(FormFieldSchema).min(1).max(30),
    /** Which field becomes the entity title. Must be a text-like field. */
    titleField: KEY,
    /** 'direct' needs this AND the per-form auto rule; anything else proposes. */
    mode: z.enum(["direct", "proposal"]).default("proposal"),
    captcha: z
      .object({ enabled: z.boolean() })
      .strict()
      .default({ enabled: false }),
    limits: z
      .object({
        /** Simultaneously-pending proposals for this form's actor. */
        pendingCap: z.number().int().min(1).max(500).default(25),
        /** Minimum ms between the form GET (ticket) and the POST. 0 = off. */
        minSubmitMs: z.number().int().min(0).max(600_000).default(3_000),
      })
      .strict()
      .default({ pendingCap: 25, minSubmitMs: 3_000 }),
    successMessage: z.string().max(500).default("Thanks — we received it."),
    /** Unreviewed guest proposals expire after this many days. */
    retentionDays: z.number().int().min(1).max(365).default(30),
  })
  .strict()
  .superRefine((c, ctx) => {
    const keys = c.fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "duplicate field key" });
    }
    const title = c.fields.find((f) => f.key === c.titleField);
    if (!title) {
      ctx.addIssue({ code: "custom", message: "titleField is not a field" });
    } else if (!["text", "email", "url"].includes(title.type)) {
      ctx.addIssue({ code: "custom", message: "titleField must be text" });
    }
  });
export type FormConfig = z.infer<typeof FormConfigSchema>;
export type FormConfigInput = z.input<typeof FormConfigSchema>;

/** The stored `tools.metadata.form`. */
export const StoredFormDefinitionSchema = z
  .object({
    version: z.literal(1),
    config: FormConfigSchema,
    /** The form's own agent user. Server-owned. */
    actorUserId: z.string().min(1),
    /** sha256 hex of the public token; null until minted (approved agent form). */
    tokenHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    tokenPrefix: z.string().max(12).nullable(),
    /** Server-only HMAC key for time-to-submit tickets. Never served. */
    ticketSecret: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type StoredFormDefinition = z.infer<typeof StoredFormDefinitionSchema>;

/** True when a tools.metadata blob is (or claims to be) a form row. */
export function isFormToolMetadata(metadata: unknown): boolean {
  return (
    !!metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    Object.prototype.hasOwnProperty.call(metadata, "form")
  );
}

/** Parse a stored row's form; null on ANY deviation (the door then refuses). */
export function parseStoredForm(
  metadata: unknown
): StoredFormDefinition | null {
  if (!isFormToolMetadata(metadata)) return null;
  const parsed = StoredFormDefinitionSchema.safeParse(
    (metadata as { form: unknown }).form
  );
  return parsed.success ? parsed.data : null;
}

// ── Mode: fail closed ────────────────────────────────────────────────────────

/**
 * Should the door ask the gate for DIRECT (no forced proposal)? Only when the
 * stored config says EXACTLY `"direct"` AND the rule store agrees AND nothing
 * degraded the request (captcha provider unreachable). Any other value —
 * absent, garbled, `"proposal"`, a revoked rule — proposes ("tighten on drift").
 */
export function wantsDirect(input: {
  storedMode: unknown;
  ruleVerdict: "auto" | "propose" | null;
  degraded: boolean;
}): boolean {
  return (
    input.storedMode === "direct" &&
    input.ruleVerdict === "auto" &&
    !input.degraded
  );
}

// ── The submission envelope ──────────────────────────────────────────────────

/**
 * The ONLY request shape the public POST reads. Everything else in the body is
 * ignored — there is no key here for kind, workspace, user, actor or mode.
 */
export const SubmissionEnvelopeSchema = z
  .object({
    fields: z.record(z.string().max(64), z.unknown()),
    ticket: z.string().max(200).optional(),
    captchaToken: z.string().max(4096).optional(),
    [HONEYPOT_FIELD]: z.unknown().optional(),
    idempotencyKey: z.string().max(128).optional(),
  })
  .passthrough();
export type SubmissionEnvelope = z.infer<typeof SubmissionEnvelopeSchema>;

const EMAIL = z.string().email().max(320);
const URL_RE = /^https?:\/\/[^\s]{1,2000}$/i;
const PHONE_RE = /^[+()0-9 .-]{3,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+Z-]{0,20})?$/;

/**
 * Build the property bag from the stored allowlist ONLY. Unknown keys are
 * dropped; a declared key with a value of the wrong type, or a missing required
 * key, rejects the whole submission (`null`). Never coerces an object/array.
 */
export function buildPropertiesFromFields(
  fields: readonly FormField[],
  submitted: Record<string, unknown>
): Record<string, string | number | boolean> | null {
  const out: Record<string, string | number | boolean> = {};
  for (const f of fields) {
    const raw = Object.prototype.hasOwnProperty.call(submitted, f.key)
      ? submitted[f.key]
      : undefined;
    const empty =
      raw === undefined ||
      raw === null ||
      (typeof raw === "string" && raw.trim() === "");
    if (empty) {
      if (f.required) return null;
      continue;
    }
    const v = coerceField(f, raw);
    if (v === undefined) return null;
    out[f.key] = v;
  }
  return out;
}

function coerceField(
  f: FormField,
  raw: unknown
): string | number | boolean | undefined {
  const maxLen =
    f.constraints?.maxLength ?? (f.type === "richtext" ? 5000 : 500);
  switch (f.type) {
    case "text":
    case "richtext": {
      if (typeof raw !== "string") return undefined;
      const s = raw.trim();
      return s.length <= maxLen ? s : undefined;
    }
    case "email": {
      if (typeof raw !== "string") return undefined;
      const s = raw.trim();
      return EMAIL.safeParse(s).success ? s : undefined;
    }
    case "url": {
      if (typeof raw !== "string") return undefined;
      const s = raw.trim();
      return URL_RE.test(s) ? s : undefined;
    }
    case "phone": {
      if (typeof raw !== "string") return undefined;
      const s = raw.trim();
      return PHONE_RE.test(s) ? s : undefined;
    }
    case "date": {
      if (typeof raw !== "string") return undefined;
      const s = raw.trim();
      return DATE_RE.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : undefined;
      if (n === undefined || !Number.isFinite(n)) return undefined;
      if (f.constraints?.min !== undefined && n < f.constraints.min)
        return undefined;
      if (f.constraints?.max !== undefined && n > f.constraints.max)
        return undefined;
      return n;
    }
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "enum":
      return typeof raw === "string" &&
        (f.constraints?.enum ?? []).includes(raw)
        ? raw
        : undefined;
  }
  return undefined;
}

// ── Time-to-submit ticket ────────────────────────────────────────────────────

/** A ticket older than this is refused (the page sat open too long). */
export const TICKET_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function ticketMac(secret: string, formId: string, issuedAt: number): string {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`${formId}.${issuedAt}`)
    .digest("base64url");
}

/** Minted by the public GET: `<issuedAtMs>.<mac>`. */
export function mintTicket(
  secret: string,
  formId: string,
  now: number
): string {
  return `${now}.${ticketMac(secret, formId, now)}`;
}

/** True when the ticket is authentic, at least `minMs` old and not stale. */
export function verifyTicket(input: {
  secret: string;
  formId: string;
  ticket: string | undefined;
  minMs: number;
  now: number;
}): boolean {
  if (input.minMs <= 0) return true;
  const t = input.ticket;
  if (!t) return false;
  const dot = t.indexOf(".");
  if (dot <= 0) return false;
  const issuedAt = Number(t.slice(0, dot));
  if (!Number.isSafeInteger(issuedAt)) return false;
  const expected = Buffer.from(ticketMac(input.secret, input.formId, issuedAt));
  const got = Buffer.from(t.slice(dot + 1));
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return false;
  }
  const age = input.now - issuedAt;
  return age >= input.minMs && age <= TICKET_MAX_AGE_MS;
}

// ── The public view (GET) ────────────────────────────────────────────────────

/** What an anonymous page may see: no id, no kind, no actor, no secret. */
export function publicFormView(config: FormConfig) {
  return {
    title: config.name,
    fields: config.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ...(f.required ? { required: true } : {}),
      ...(f.help ? { help: f.help } : {}),
      ...(f.constraints
        ? {
            constraints: {
              ...(f.constraints.enum ? { enum: f.constraints.enum } : {}),
              ...(f.constraints.min !== undefined
                ? { min: f.constraints.min }
                : {}),
              ...(f.constraints.max !== undefined
                ? { max: f.constraints.max }
                : {}),
              ...(f.constraints.maxLength !== undefined
                ? { maxLength: f.constraints.maxLength }
                : {}),
            },
          }
        : {}),
    })),
    successMessage: config.successMessage,
    honeypotField: HONEYPOT_FIELD,
  };
}
