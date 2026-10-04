/**
 * @synap-core/types/lens — the pure view-model of a lens page, shared by the
 * web (`@synap-core/lens-page`) and relay (`relay-app/src/components/lens/`).
 *
 * Spec: `.claude/skills/lens-page/SKILL.md`. One page, a scope parameter; five
 * attention classes; one section order; one row; one header; one banner.
 * Pure and dependency-free (sibling leaves only).
 */
export * from "./scope.js";
export * from "./classes.js";
export * from "./rows.js";
export * from "./header.js";
export * from "./page.js";
export * from "./page-model.js";
