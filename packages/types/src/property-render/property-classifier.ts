/**
 * Property Classifier
 *
 * Single source of truth for "what kind of property is this?". Pure, so every
 * renderer shares it: web (`@synap-core/web/property-renderer`, whose
 * `classifyProperty` gives registered plugins their turn first, then calls
 * {@link classifyBuiltinProperty}), relay, and pod-admin (through
 * `classifyPropertyKind`, `./classify-property.ts`).
 *
 * Moved down from app-bases `headless/src/property-renderer/utils/
 * propertyClassifier.ts` (Wave 1 fork 1.1); that file becomes a re-export.
 *
 * Both renderPropertyValue (display) and InlinePropertyEditor (editing) route
 * through classifyProperty() so the same property always renders and edits
 * consistently — no divergence from duplicated if-chains.
 *
 * resolvePropertyIcon also uses PropertyKind for icon selection.
 *
 * Routing priority (most specific first):
 *   1. uiHints.inputType  — explicit override (email / phone / url / person)
 *   2. uiHints.displayAs  — semantic intent (status / priority / progress / person)
 *   3. Slug pattern match — inferred from field name
 *   4. constraints.enum   — any enum → status/priority/enum/multiselect
 *   5. valueType fallback — plain number / text / boolean / date / etc.
 */

import type {
  PropertyConstraints,
  PropertyDef,
  PropertyUIHints,
} from "./types.js";

// ─── Slug patterns ────────────────────────────────────────────────────────────
// Exported so icon resolvers and tests can reference them, but only classifyProperty
// should be used for routing decisions.

export const COLOR_SLUG_RE = /\bcolou?r\b/i;
export const RATING_SLUG_RE = /\brating\b|\bstars?\b/i;
export const CURRENCY_SLUG_RE =
  /\b(price|amount|cost|budget|revenue|mrr|arr|salary)\b/i;

export const STATUS_SLUG_RE = /status|stage|phase|state|disposition|pipeline/;
export const PRIORITY_SLUG_RE = /priority|urgency|importance|severity/;
export const PROGRESS_SLUG_RE = /progress|completion|percent|done/;

/** Matches singular person fields (single-value) */
export const PERSON_SLUG_RE =
  /^(person|assignee|owner|reporter|author|created_by|updated_by|lead|contact)$/;

/** Matches plural / array person fields */
export const PERSON_ARRAY_SLUG_RE =
  /assignees?|owners?|members?|reporters?|participants?|followers?/;

/**
 * Matches string properties that store email addresses.
 * Matches any slug containing "email" (work_email, contact_email, email_address, etc.).
 * Safe: number/boolean properties with "email" in their name are caught by earlier valueType branches.
 */
export const EMAIL_SLUG_RE = /email/;

/**
 * Matches string properties that store URLs or web addresses.
 * Covers: generic "url"/"uri" anywhere in slug, "website"/"homepage" as standalone concepts,
 * and well-known social/portfolio platforms that are always links.
 */
export const URL_SLUG_RE =
  /url|uri|website|homepage|linkedin|twitter|github|instagram|facebook|youtube|portfolio/;

/**
 * Matches string properties that store phone numbers.
 * Covers: "phone" and "mobile" anywhere in slug.
 * "cell" and "tel" only as full word to avoid false positives ("cell_count", "hotel").
 */
export const PHONE_SLUG_RE = /phone|mobile|(?:^|_|-)(?:cell|fax|tel)(?:$|_|-)/;

/**
 * A slug SEGMENT that names a place: "location", "address" or "venue" as a
 * whole `_` / `-` / `.`-delimited word (office_location, billing-address,
 * metadata.venue). A word that merely contains one ("relocation",
 * "addressee") is not a place. Module-private: `isLocationSlug` is the door,
 * because a bare match also accepts addresses that are not places.
 */
const LOCATION_SLUG_RE = /(?:^|[._-])(?:location|address|venue)(?:$|[._-])/;
/** An address that is not a place: email / IP / MAC / wallet / contract / web. */
const NOT_A_PLACE_SLUG_RE =
  /(?:e[-_]?mail|ip|mac|wallet|contract|web)[-_]?address/;

/** Does this (lower-cased, `_`/`-`/`.`-delimited) slug name a place? The ONE rule. */
export function isLocationSlug(slug: string): boolean {
  return LOCATION_SLUG_RE.test(slug) && !NOT_A_PLACE_SLUG_RE.test(slug);
}

/**
 * Matches long-text / rich-text property slugs.
 * These are string properties that contain multi-line or markdown content.
 * Must be an exact-match slug (anchored) to avoid false positives on slugs
 * like "content_type" or "note_count".
 */
export const RICHTEXT_SLUG_RE =
  /^(notes?|description|body|brief|summary|bio|content|readme|details?|overview|about|message|text|remarks?|comment|comments)$/;

/**
 * Matches implementation identifiers that should read as semantic references,
 * not long plain text. Keep this exact-match only: broad "id" matching catches
 * friendly labels like "idea" or "candidate".
 */
export const REFERENCE_ID_SLUG_RE =
  /^(channel|message|thread|document|workspace|entity)[-_]?id$/;

/**
 * A declared `constraints.maxLength` at or above this holds prose, not a label.
 * Seeded capacity is bimodal — short identifiers cap at 100–500, long-form
 * fields at 1000+ (see `ensure-system-profiles.ts`) — so this cleanly separates
 * the two without needing a uiHint the author may never have written.
 */
export const LONG_TEXT_MAX_LENGTH = 1000;

/**
 * A raw string value at or beyond this length (or containing a newline) reads
 * as prose regardless of what its schema claims. Used by value-aware callers
 * (`PropertyRow`) to stack a row that would otherwise truncate; `classifyProperty`
 * itself stays value-independent so display and edit never disagree.
 */
export const LONG_TEXT_VALUE_LENGTH = 120;

/** True when a concrete value is prose-shaped: multi-line or simply long. */
export function isLongTextValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return value.length >= LONG_TEXT_VALUE_LENGTH || value.includes("\n");
}

// ─── PropertyKind ─────────────────────────────────────────────────────────────

/**
 * The semantic kind of a property, resolved from its definition.
 * Used to route both display components and editor components.
 *
 * Display mapping:      Edit mapping:
 *   status      → StatusPill         StatusEditor (dropdown of enum options)
 *   priority    → PriorityIndicator  PriorityEditor
 *   progress    → ProgressDisplay    TextEditor (numeric, 0–100)
 *   date        → DateDisplay        DateEditor (calendar popover)
 *   boolean     → BooleanDisplay     toggle in PropertyRow (no inline editor)
 *   person      → PersonDisplay      TextEditor (lookup via linkedTable)
 *   person-array → PersonDisplay     TextEditor (comma-split fallback)
 *   entity-link → EntityLinkDisplay  EntityPickerEditor
 *   reference   → EntityLinkDisplay  TextEditor (compact ID chip)
 *   multiselect → ArrayDisplay       EnumEditor (multi-select)
 *   enum        → EnumBadge          EnumEditor (single-select)
 *   tags        → ArrayDisplay       TagsEditor (free-form)
 *   email       → EmailDisplay       TextEditor (email mode)
 *   phone       → PhoneDisplay       TextEditor (phone mode)
 *   location    → LocationDisplay    TextEditor (plain)
 *   url         → UrlDisplay         TextEditor (url mode)
 *   number      → NumberDisplay      TextEditor (numeric mode)
 *   richtext    → RichTextDisplay     RichTextEditor (Tier 1 inline markdown field)
 *   text        → TextDisplay        TextEditor
 *   secret      → SecretDisplay      SecretEditor
 *   object      → JSON string        TextEditor (plain)
 */
export type PropertyKind =
  | "status"
  | "priority"
  | "progress"
  | "date"
  | "boolean"
  | "person"
  | "person-array"
  | "entity-link"
  | "reference"
  | "multiselect"
  | "enum"
  | "tags"
  | "email"
  | "phone"
  | "url"
  | "location"
  | "number"
  | "richtext"
  | "text"
  | "secret"
  | "object"
  | "color"
  | "rating"
  | "currency";

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * The built-in classification — a {@link PropertyKind}, never a plugin kind.
 *
 * This is the ONLY function that should read uiHints, constraints.enum,
 * and slug patterns to decide how a property behaves. All other rendering
 * and editing code should call it (on web, through the plugin-aware
 * `classifyProperty`) and switch on the result. A host with no plugin
 * registry (relay) calls it directly.
 */
export function classifyBuiltinProperty(property: PropertyDef): PropertyKind {
  const hints: PropertyUIHints = property.uiHints ?? {};
  const constraints = (property.constraints ?? {}) as PropertyConstraints;
  const { inputType, displayAs, format } = hints;
  const enumValues = constraints.enum ?? [];
  const hasEnum = enumValues.length > 0;
  const s = property.slug.toLowerCase();

  switch (property.valueType) {
    case "string": {
      // 1. Explicit input type overrides
      if (inputType === "email") return "email";
      if (inputType === "phone") return "phone";
      if (inputType === "url") return "url";
      if (inputType === "person" || PERSON_SLUG_RE.test(s)) return "person";
      if (REFERENCE_ID_SLUG_RE.test(s)) {
        return s === "entityid" || s === "entity_id" || s === "entity-id"
          ? "entity-link"
          : "reference";
      }
      // 2. Semantic display hints
      if (displayAs === "status" || (hasEnum && STATUS_SLUG_RE.test(s)))
        return "status";
      if (displayAs === "priority" || PRIORITY_SLUG_RE.test(s))
        return "priority";
      // 3. Any other enum
      if (hasEnum) return "enum";
      // 4. Slug-inferred contact/link types (no explicit inputType required)
      if (EMAIL_SLUG_RE.test(s)) return "email";
      if (URL_SLUG_RE.test(s)) return "url";
      if (PHONE_SLUG_RE.test(s)) return "phone";
      if (isLocationSlug(s)) return "location";
      // 5. Rich text — explicit inputType, slug pattern, or declared capacity.
      // "richtext" is Tier 1 (text-tiers §3): the inline markdown field
      // (marks, links, references, lists; no blocks). The document BODY is
      // Tier 2, the page editor via `<DocumentBody>` (entity-views).
      //
      // `textarea` / `markdown` are the aliases the system-profile seeds
      // actually emit; before they were handled here they fell through to plain
      // "text" and rendered one-line-clamped in a label|value row (the
      // `ek_claim` bug — an 8000-char claim shown as a truncated table cell).
      //
      // LONG_TEXT_MAX_LENGTH is the shape-derived floor for properties that
      // declare neither: seeded capacity is bimodal (short identifiers cap at
      // 100–500, long-form prose at 1000+), so a four-digit maxLength is a
      // reliable "this holds prose" signal even with no uiHints at all.
      if (
        inputType === "richtext" ||
        inputType === "textarea" ||
        inputType === "markdown" ||
        displayAs === "body" ||
        // The projection (`@synap-core/types/projection`) reads these two as
        // long text; the renderer now agrees (text-tiers W2).
        displayAs === "richtext" ||
        displayAs === "markdown" ||
        RICHTEXT_SLUG_RE.test(s) ||
        (constraints.maxLength ?? 0) >= LONG_TEXT_MAX_LENGTH
      )
        return "richtext";
      // 6. Color
      if (inputType === "color" || COLOR_SLUG_RE.test(s)) return "color";
      return "text";
    }

    case "number": {
      if (
        format === "percent" ||
        displayAs === "progress" ||
        PROGRESS_SLUG_RE.test(s)
      )
        return "progress";
      if (
        format === "rating" ||
        displayAs === "rating" ||
        RATING_SLUG_RE.test(s)
      )
        return "rating";
      return "number";
    }

    case "boolean":
      return "boolean";

    case "date":
      return "date";

    case "entity_id":
      return "entity-link";

    case "array": {
      // Enum arrays → multi-select (edit: EnumEditor; display: ArrayDisplay)
      if (hasEnum) return "multiselect";
      // Person arrays → avatar group (display: PersonDisplay; edit: text fallback)
      if (
        inputType === "person" ||
        displayAs === "person" ||
        PERSON_ARRAY_SLUG_RE.test(s)
      )
        return "person-array";
      // Free-form tags
      return "tags";
    }

    case "secret":
      return "secret";

    case "object":
      if (displayAs === "currency" || CURRENCY_SLUG_RE.test(s))
        return "currency";
      return "object";

    default:
      return "object";
  }
}
