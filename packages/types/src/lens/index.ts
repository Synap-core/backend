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
export * from "./age.js";
export * from "./header.js";
export * from "./intent.js";
export * from "./page.js";
export * from "./page-model.js";
export * from "./next-moves.js";
export * from "./focus.js";
export * from "./entity-history.js";
export * from "./space-intent.js";
export * from "./home-brief.js";
export * from "./home-brief-reads.js";
/**
 * @deprecated Import `formatFloorCount` from `@synap-core/types/value-format`
 * (plan 915cc937 Q6). Kept until synap-app's list-cap and relay's three
 * importers move; then this line goes.
 */
export { formatFloorCount } from "../value-format/numbers.js";

/** Home's words, en + fr (`./home-copy.ts`). */
export { homeCopy, homeT } from "./home-copy.js";
