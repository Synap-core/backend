/**
 * @synap-core/types/renderables — the ONE catalog of what Synap can render.
 *
 * Widget cells (`WIDGET_DEFINITIONS`) and view types (`VIEW_DEFINITIONS`), their
 * key tuples, the content-kind / placement taxonomy, and the helpers that read
 * the catalog's optional fields. Moved DOWN from `@synap-core/capabilities`
 * (which re-exports all of it, API unchanged) so the backend validates arrange
 * and lists widgets in-process, and IS / relay read the same words.
 *
 * LEAF subpath: no zod, no drizzle, no React. Keep it that way — relay's node
 * tests and the CLI import leaf subpaths only.
 */

export * from "./types.js";
export * from "./content-kinds.js";
export { WIDGET_DEFINITIONS, WIDGET_BY_KEY } from "./widgets.js";
export {
  VIEW_DEFINITIONS,
  VIEW_BY_KEY,
  IMPLEMENTED_VIEW_TYPES,
  CREATABLE_VIEW_DEFINITIONS,
  STRUCTURED_VIEW_TYPES,
} from "./views.js";
export * from "./catalog.js";
export * from "./chart-data.js";
export * from "./chart-shapers.js";
