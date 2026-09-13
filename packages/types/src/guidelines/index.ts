/**
 * Guideline scope vocabulary — the ONE declaration of the guideline rungs and
 * of the capture input kinds a `sourceKind` guideline may target.
 *
 * Dependency-free on purpose: the pod (`@synap/database` resolver + write door),
 * the browser guideline editor and relay's studio all read these lists. Before
 * this module each of them held a hand-copy.
 */

/**
 * The guideline scope rungs, ordered general → specific. Rank is the INDEX:
 * a specific guideline is applied LAST so it reinforces/overrides a general
 * one. The reasoning for each rung's placement lives beside the resolver
 * (`SCOPE_ORDER` in `@synap/database` `utils/config-settings.ts`). The pod's
 * resolver cannot import this package (`@synap-core/types` already depends on
 * `@synap/database`), so how the two are kept identical is recorded there.
 */
export const GUIDELINE_SCOPE_ORDER = [
  "default",
  "workKind",
  "sourceKind",
  "entityKind",
  "channelType",
  "bridge",
  "channel",
  "shape",
] as const;

export type GuidelineScopeKind = (typeof GUIDELINE_SCOPE_ORDER)[number];

/**
 * The closed `sourceKind` vocabulary for NON-import inputs — the kinds of input
 * a capture door accepts. An import item's kind is `import:<source>`, where
 * `<source>` is an `IMPORT_SOURCE_VALUES` token (`../imports`).
 */
export const GUIDELINE_SOURCE_KINDS = [
  "text",
  "url",
  "image",
  "file",
  "audio",
] as const;

export type GuidelineSourceKind = (typeof GUIDELINE_SOURCE_KINDS)[number];

/** The `sourceKind` prefix for import items: `import:<IMPORT_SOURCE_VALUES>`. */
export const IMPORT_SOURCE_KIND_PREFIX = "import:";
