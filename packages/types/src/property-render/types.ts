/**
 * The data shapes the property-render rules read. Framework-agnostic: no
 * React, no design system — every renderer (pod-admin HeroUI, app-bases web,
 * relay) maps these onto its own widgets.
 */
import type {
  PropertyDisplayAs,
  PropertyInputType,
} from "../property-hints/index.js";

/**
 * Subset of the pod's `EffectiveProperty` (`@synap/database`) — what a
 * renderer needs to drive schema-aware field widgets. Comes from
 * `entities.get({ includeProfile })` / `profiles.get`.
 */
export interface EffectivePropertyDef {
  id: string;
  slug: string;
  valueType: string;
  constraints?: Record<string, unknown> | null;
  uiHints?: Record<string, unknown> | null;
  targetProfileId?: string | null;
  required?: boolean;
  defaultValue?: unknown;
  displayOrder?: number;
  /**
   * This property IS the profile's declared lifecycle (work model L1; the
   * pod's `EffectiveProperty.isLifecycle`). Absent = not declared here (an
   * older pod omits it) — never guessed.
   */
  isLifecycle?: boolean;
}

/**
 * The abstract widget category a property resolves to. Each design-system
 * implementation maps these to its native field type.
 *
 * Resolution tiers, in priority order:
 *   1. uiHints.inputType (explicit — `email`, `markdown`, `select`, …)
 *   2. uiHints.displayAs / slug pattern (semantic — `status`, `priority`)
 *   3. constraints.enum (any enum → select)
 *   4. valueType (final fallback — `boolean`, `date`, `entity_id`, …)
 */
export type PropertyRenderKind =
  | "text"
  | "email"
  | "phone"
  | "url"
  | "number"
  | "currency"
  | "percent"
  | "date"
  | "boolean"
  | "status"
  | "priority"
  | "select"
  | "multi-select"
  | "tags"
  | "richtext"
  | "entity-ref"
  | "multi-entity-ref"
  | "secret"
  | "object";

// ─── The renderer's property definition ─────────────────────────────────────
//
// What `classifyBuiltinProperty` (./property-classifier.ts) reads, moved down
// from app-bases `headless/src/property-renderer/types.ts` (Wave 1 fork 1.1).
// Distinct from the pod's STORED hints (`@synap/database` `PropertyUIHints`):
// this one also carries what a renderer threads through (resolved names, the
// callbacks a value display may call).

export interface ResolvedEntity {
  id: string;
  name?: string;
  title?: string;
  type?: string;
}

export interface PropertyUIHints {
  displayName?: string;
  /**
   * Authoring alias for `displayName`. The system-profile seeds
   * (`ensure-system-profiles.ts`) write `label`, every reader historically read
   * `displayName` — so seeded properties rendered their humanized SLUG
   * ("Ek Claim") instead of their authored label ("Claim"), in detail cards AND
   * in view column headers. Readers must resolve `displayName ?? label ?? slug`
   * via `resolvePropertyLabel()`; never read either key directly.
   */
  label?: string;
  placeholder?: string;
  /**
   * The ONE vocabulary (`@synap-core/types/property-hints`), shared with the
   * pod: this used to be a hand-mirrored copy that had drifted both ways. The
   * pod re-exports this same list (`@synap/database`
   * `schema/property-defs.ts`); there is no second copy.
   */
  inputType?: PropertyInputType;
  /**
   * `body` marks the property that IS the entity's substance (a knowledge
   * claim, a description) rather than a fact about it. Body properties render
   * full-width as prose above the property table — never as a label|value row.
   * `richtext` / `markdown` read as long text (Tier 1).
   */
  displayAs?: PropertyDisplayAs;
  format?: "locale" | "currency" | "percent" | "compact" | "rating";
  includeTime?: boolean;

  linkedProfileSlug?: string;
  linkedTable?: "workspace_members" | "free_text";
  itemValueType?:
    "string" | "number" | "boolean" | "date" | "entity_id" | "url";

  resolvedEntity?: ResolvedEntity;
  resolvedEntityName?: string;
  onEntityPress?: (entityId: string) => void;
  onOpenInCanvas?: (url: string) => void;
  resolvePerson?: (id: string) => { name: string; avatar?: string } | undefined;

  pluginHints?: Record<string, unknown>;
}

export interface PropertyConstraints {
  enum?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  required?: boolean;
  [key: string]: unknown;
}

export type PropertyValueTypeName =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "entity_id"
  | "array"
  | "object"
  | "secret";

export interface PropertyDef {
  id: string;
  slug: string;
  valueType: PropertyValueTypeName;
  constraints?: PropertyConstraints;
  uiHints?: PropertyUIHints;
  required?: boolean;
  defaultValue?: unknown;
  displayOrder?: number;
}
