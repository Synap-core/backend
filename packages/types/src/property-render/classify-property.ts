/**
 * Framework-agnostic property kind classifier.
 *
 * Five-tier dispatch ported from Synap Studio's Tamagui `FieldRenderer` and
 * mirrored in `@eve/profile-renderer/src/detail/field-builder.ts`. Returns
 * a `PropertyRenderKind` — the abstract widget category. Each design-system
 * implementation maps this to its native field type.
 *
 * The tiers, in priority order:
 *
 *   1. uiHints.inputType    — explicit (email/url/select/markdown/checkbox/tags/date)
 *   2. uiHints.displayAs    — semantic (status/priority/progress/person)
 *   3. Slug pattern         — `*status` → status, `*priority` → priority
 *   4. constraints.enum     — any enum → select
 *   5. valueType            — final fallback (string/number/boolean/date/entity_id/...)
 *
 * Spec: synap-app/docs/architecture/profile-renderer.md
 */

import type { EffectivePropertyDef, PropertyRenderKind } from "./types.js";

export interface ClassifyArgs {
  /** The property slug / key. */
  slug: string;
  /** The current value. Used as a hint only — not authoritative. */
  value?: unknown;
  /** The schema definition. If absent, classification is value-shape-only. */
  def?: EffectivePropertyDef;
}

/**
 * Returns the abstract render kind for a property. Design-system renderers
 * map this to their native field type.
 */
export function classifyPropertyKind(args: ClassifyArgs): PropertyRenderKind {
  const { slug, value, def } = args;

  if (def) {
    const uiHints = (def.uiHints ?? {}) as Record<string, unknown>;
    const constraints = (def.constraints ?? {}) as Record<string, unknown>;
    const slugLower = def.slug.toLowerCase();

    const displayAs =
      typeof uiHints.displayAs === "string" ? uiHints.displayAs : undefined;
    const role: PropertyRenderKind | undefined =
      displayAs === "status" || /status$/.test(slugLower)
        ? "status"
        : displayAs === "priority" || /priority/.test(slugLower)
          ? "priority"
          : undefined;

    // 1. Explicit inputType — except that `select` is only the EDITOR a
    //    status / priority uses, not a different kind. Every system status and
    //    priority on a live pod declares `inputType: "select"` (task.status,
    //    task.priority, decision.decisionStatus, user kinds' `*-status`), so
    //    letting it win here classified every real status as a plain select
    //    and no status ever reached a card hero.
    const inputType =
      typeof uiHints.inputType === "string" ? uiHints.inputType : undefined;
    if (inputType && !(inputType === "select" && role)) {
      const fromInput = kindFromInputType(inputType);
      if (fromInput) return fromInput;
    }

    // 2. displayAs semantic + slug patterns
    if (role) return role;

    // 3. constraints.enum → select
    if (Array.isArray(constraints.enum) && constraints.enum.length > 0) {
      return "select";
    }

    // 4. valueType
    return kindFromValueType(def.valueType);
  }

  // No schema — value-shape fallback (intentionally minimal here; design-
  // system renderers can layer their own classifyValue() if needed).
  return kindFromValue(slug, value);
}

function kindFromInputType(inputType: string): PropertyRenderKind | undefined {
  switch (inputType) {
    case "email":
      return "email";
    case "phone":
    case "tel":
      return "phone";
    case "url":
      return "url";
    case "select":
      return "select";
    case "checkbox":
      return "boolean";
    case "tags":
      return "tags";
    case "markdown":
    case "textarea":
    case "richtext":
      return "richtext";
    case "datetime":
    case "datetime-local":
    case "date":
      return "date";
    case "entity-select":
      return "entity-ref";
    default:
      return undefined;
  }
}

function kindFromValueType(valueType: string): PropertyRenderKind {
  switch (valueType) {
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "number":
      return "number";
    case "entity_id":
      return "entity-ref";
    case "array":
      return "tags";
    case "secret":
      return "secret";
    case "object":
      return "object";
    case "string":
    default:
      return "text";
  }
}

function kindFromValue(slug: string, value: unknown): PropertyRenderKind {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "tags";
  if (typeof value === "string") {
    const lower = slug.toLowerCase();
    if (/email$/.test(lower)) return "email";
    if (/phone|tel$/.test(lower)) return "phone";
    if (/url|website|link$/.test(lower)) return "url";
    if (/status$/.test(lower)) return "status";
    if (/priority/.test(lower)) return "priority";
  }
  return "text";
}
