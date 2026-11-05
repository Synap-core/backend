/**
 * `@synap-core/types/property-render` — the ONE copy of the rules that decide
 * how an object's fields are classified, labelled, toned and described.
 *
 * Every surface that draws an entity — pod-admin (HeroUI), the app-bases web
 * renderers, relay (Hermes) — reads these rules and only owns its visual
 * skin. Same precedent as `@synap-core/types/lens` (`page-model.ts`): the
 * headless model lives with the types, the pixels live with each app.
 *
 * LEAF subpath: pure functions over plain objects. No React, no DOM, no zod,
 * no drizzle; runtime imports reach only sibling `@synap-core/types` modules
 * (`vocabulary`, `units`). `property-render.leaf.test.ts` walks the graph.
 *
 * Moved down from app-bases. Each copy there still has importers: re-point
 * them here, then delete the copy. For `statusSemantics.ts` only the pure half
 * moved; its web-token wrappers (`ENUM_TONE_TOKEN`, `getEnumColor`) stay in
 * app-bases (its unread `STATUS_PILL_MAP` went in Wave 1 step 4).
 *   hooks/src/profile-renderer/classify-property.ts      → ./classify-property
 *   headless/src/property-renderer/utils/propertyClassifier.ts → ./property-classifier
 *   headless/src/property-renderer/types.ts              → ./types (PropertyDef & co)
 *   hooks/src/profile-renderer/entity-field-plan.ts      → ./entity-field-plan
 *   hooks/src/profile-renderer/classify/index.ts         → this entry point
 *   hooks/src/profile-renderer/entity-types.ts           → ./types (the two pure types)
 *   headless/src/property-renderer/structured-value.ts   → ./structured-value
 *   headless/src/property-renderer/utils/fieldFormatters.ts   → ./field-label
 *   headless/src/property-renderer/utils/fieldTypeDetector.ts → ./field-type
 *   headless/src/property-renderer/utils/statusSemantics.ts   → ./enum-tone (pure half)
 */

export type {
  EffectivePropertyDef,
  PropertyRenderKind,
  PropertyDef,
  PropertyUIHints,
  PropertyConstraints,
  PropertyValueTypeName,
  ResolvedEntity,
} from "./types.js";
export {
  classifyBuiltinProperty,
  isLocationSlug,
  isLongTextValue,
  COLOR_SLUG_RE,
  RATING_SLUG_RE,
  CURRENCY_SLUG_RE,
  STATUS_SLUG_RE,
  PRIORITY_SLUG_RE,
  PROGRESS_SLUG_RE,
  PERSON_SLUG_RE,
  PERSON_ARRAY_SLUG_RE,
  EMAIL_SLUG_RE,
  URL_SLUG_RE,
  PHONE_SLUG_RE,
  RICHTEXT_SLUG_RE,
  REFERENCE_ID_SLUG_RE,
  LONG_TEXT_MAX_LENGTH,
  LONG_TEXT_VALUE_LENGTH,
  type PropertyKind,
} from "./property-classifier.js";
export {
  classifyPropertyKind,
  type ClassifyArgs,
} from "./classify-property.js";
export {
  planEntityFields,
  isSystemField,
  type PlannedEntityField,
  type EntityFieldPlan,
  type EntityFieldPlanInput,
} from "./entity-field-plan.js";
export { resolvePropertyLabel, formatFieldLabel } from "./field-label.js";
export {
  detectFieldType,
  formatFieldValue,
  type FieldType,
} from "./field-type.js";
export {
  getEnumTone,
  getEnumUnitTone,
  getPriorityLevel,
  PRIORITY_MAP,
  type EnumTone,
  type PriorityLevel,
} from "./enum-tone.js";
export {
  describeValue,
  describeRecordEntries,
  summarizeShape,
  isStructuredValue,
  parseJsonContainer,
  readObjectRef,
  readObjectRefList,
  isUuid,
  asRecord,
  LONG_TEXT_CHARS,
  TITLE_KEYS,
  SUBTITLE_KEYS,
  BADGE_KEYS,
  ORDER_KEYS,
  type ValueShape,
  type ValueShapeKind,
  type ValueEntry,
  type RecordListItem,
  type ObjectRef,
  type DescribeValueOptions,
} from "./structured-value.js";
