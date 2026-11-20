/**
 * `@synap-core/types/design-board` — a Design app canvas (a `ui-design`'s
 * `design-json`) as data: the board format and its ONE validator, the grid,
 * the catalog snapshot the pod validates with, the ops agents change a design
 * through, and when a design is past its review. Plan 0fc746f4 §2.6.
 *
 * One home for the canvas (app-bases `apps/ui-gallery`) and the pod's design
 * door (`services/designs`, verbs `design.read` / `design.catalog` /
 * `design.apply`), so a design the person saves and one an agent writes pass
 * the same parser. Pure and dependency-free (zod only).
 */
export * from "./schema.js";
export * from "./grid.js";
export * from "./board.js";
export * from "./catalog.js";
export * from "./ops.js";
export * from "./status.js";
export * from "./verbs.js";
