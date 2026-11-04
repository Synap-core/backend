/**
 * The render kind of a property, for the entity field plan and the kind card.
 *
 * NOT a second classifier: the decision is `classifyBuiltinProperty`
 * (`./property-classifier.ts`), the ONE rule the web property renderer, relay
 * and pod-admin read. This file only maps its `PropertyKind` onto the coarser
 * `PropertyRenderKind` a card host formats by, so a field's row and its card
 * can never disagree about what it is.
 *
 * Moved down from app-bases `hooks/src/profile-renderer/classify-property.ts`
 * (Wave 1 fork 1.1), replacing the older five-tier dispatch that lived here.
 *
 * Consequences of following that rule (each pinned in `classify.test.ts`):
 *   - a `status`/`stage`/`phase`/`state`-named string is a status only when it
 *     declares options; without them it is text;
 *   - `inputType: "select"` with no options is text — nothing to choose from;
 *   - note-like slugs (brief, readme, message, summary, notes, …) are richtext;
 *   - the valueType comes first: an `inputType` that contradicts it is ignored;
 *   - an array with options is a multi-select, a progress-named number a percent,
 *     a price-named object a currency.
 */

import {
  classifyBuiltinProperty,
  type PropertyKind,
} from "./property-classifier.js";
import type {
  EffectivePropertyDef,
  PropertyDef,
  PropertyRenderKind,
} from "./types.js";

export interface ClassifyArgs {
  /** The property slug / key. */
  slug: string;
  /** The current value. Read only when there is no definition (its shape stands in for a valueType). */
  value?: unknown;
  /** The schema definition. If absent, classification is value-shape-only. */
  def?: EffectivePropertyDef;
}

/**
 * Each built-in kind onto the render kind a card formats. Typed as a full
 * record, so a new `PropertyKind` fails the build until it is mapped here.
 */
const RENDER_KIND: Record<PropertyKind, PropertyRenderKind> = {
  status: "status",
  priority: "priority",
  progress: "percent",
  date: "date",
  boolean: "boolean",
  // A person named in a string field is its name; the people arrays are tags.
  person: "text",
  "person-array": "tags",
  "entity-link": "entity-ref",
  // A channel / message / workspace id is an identifier, not an entity to open.
  reference: "text",
  multiselect: "multi-select",
  enum: "select",
  tags: "tags",
  email: "email",
  phone: "phone",
  url: "url",
  location: "text",
  number: "number",
  richtext: "richtext",
  text: "text",
  secret: "secret",
  object: "object",
  color: "text",
  rating: "number",
  currency: "currency",
};

function valueTypeOf(value: unknown): string {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  return "object";
}

/**
 * Returns the abstract render kind for a property. Design-system renderers
 * map this to their native field type.
 */
export function classifyPropertyKind(args: ClassifyArgs): PropertyRenderKind {
  const { slug, value, def } = args;
  // The wire def is looser than PropertyDef (an unknown valueType, null
  // hints); classifyBuiltinProperty reads both defensively and maps an
  // unknown valueType to "object".
  const property = (
    def
      ? {
          id: def.id,
          slug: def.slug,
          valueType: def.valueType,
          constraints: def.constraints ?? undefined,
          uiHints: def.uiHints ?? undefined,
        }
      : { id: slug, slug, valueType: valueTypeOf(value) }
  ) as PropertyDef;
  const kind = classifyBuiltinProperty(property);
  return RENDER_KIND[kind];
}
