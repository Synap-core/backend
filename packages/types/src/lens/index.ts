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
 * The rules of a document's work blocks, one home for web and phone (GUI wave
 * 3): the scope a cell reads, a block's props (author / reader), the status
 * route, the empty words and the one placeholder.
 */
export * from "./cell-scope.js";
export * from "./block-props.js";
export * from "./block-placeholder.js";
export {
  LENS_EMPTY_TITLE_KEY,
  LENS_EMPTY_WHY_KEY,
  lensBlockCopy,
  lensBlockT,
  lensEmptyTitle,
  lensEmptyWhy,
} from "./block-copy.js";
/**
 * @deprecated Import `formatFloorCount` from `@synap-core/types/value-format`
 * (plan 915cc937 Q6). Kept until synap-app's list-cap and relay's three
 * importers move; then this line goes.
 */
export { formatFloorCount } from "../value-format/numbers.js";

/** Home's words, en + fr (`./home-copy.ts`). */
export { HOME_LATER_CHOICE_KEY, homeCopy, homeT } from "./home-copy.js";
