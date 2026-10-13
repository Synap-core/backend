/**
 * The data shapes the property-render rules read. Framework-agnostic: no
 * React, no design system — every renderer (pod-admin HeroUI, app-bases web,
 * relay) maps these onto its own widgets.
 */

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
