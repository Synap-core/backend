/**
 * `@synap-core/types/property-hints`: THE vocabulary of a property's
 * `uiHints.inputType` and `uiHints.displayAs` (text-tiers W2).
 *
 * One list each, pure and dependency-free, so every reader types against the
 * same members: the renderer (`@synap-core/property-renderer`) imports these
 * unions instead of keeping a hand-mirrored copy, which had drifted both ways.
 *
 * The pod's own declaration (`@synap/database` `schema/property-defs.ts`) has
 * to stay a second copy (the database cannot depend on this package: this
 * package already builds against it). `pod-parity.contract.ts` compiles both
 * against each other, so a member added on one side only fails this package's
 * typecheck.
 */

/**
 * Every `inputType` a property may declare. Built from a census of values
 * actually stored (see the pod's `PropertyInputType`), plus `markdown`: a
 * long-text alias the renderer's classifier reads and templates may author.
 * `entity` / `entity-select` and `tel` / `phone` are the same intent spelled
 * twice; they stay distinct so the duplication stays visible.
 */
export const PROPERTY_INPUT_TYPES = [
  "email",
  "phone",
  "url",
  "richtext",
  "markdown",
  "datetime-local",
  "select",
  "person",
  "datetime",
  "text",
  "textarea",
  "number",
  "date",
  "checkbox",
  "tags",
  "json",
  "color",
  "entity",
  "entity-select",
  "tel",
] as const;
export type PropertyInputType = (typeof PROPERTY_INPUT_TYPES)[number];

/**
 * Every `displayAs` a property may declare: the semantic intent a renderer
 * draws. `body` marks the property that IS the entity's substance
 * (`isBodyPropertyDef`); `richtext` / `markdown` read as long text
 * (`projection`, the renderer's classifier).
 */
export const PROPERTY_DISPLAY_AS = [
  "status",
  "priority",
  "progress",
  "person",
  "rating",
  "currency",
  "body",
  "richtext",
  "markdown",
] as const;
export type PropertyDisplayAs = (typeof PROPERTY_DISPLAY_AS)[number];

/**
 * Does a property's SLUG name a kind's lifecycle (`status`, `post-status`,
 * `dealStage`, `stage`)? The ONE predicate — the pod's "Draft a template"
 * offer (`kind-lifecycle.ts`) and the template corpus guard read the same
 * rule. RUNTIME bookkeeping fields (`agent_status`, `run-status`,
 * `last_run_status`, `job_status`) describe a machine's run, not where the
 * record stands, and are never a lifecycle. Callers still require a closed
 * value set (a select) — a free-text "status" cannot be advanced.
 */
const LIFECYCLE_SLUG = /status|stage/i;
const RUNTIME_STATUS_SLUG = /^(agent|run|last_?run|job)[-_]?status$/i;

export function isLifecyclePropertySlug(slug: string): boolean {
  return LIFECYCLE_SLUG.test(slug) && !RUNTIME_STATUS_SLUG.test(slug);
}
