/**
 * Conversions module barrel — Kind + Facets generic conversion engine.
 *
 * The package barrel (src/index.ts) re-exports this; do not import from deep
 * paths outside the module.
 */

export type {
  ConversionOp,
  ConversionManifest,
  ConversionOpType,
  DeclareKindOp,
  SeedKindProfileOp,
  ConvertToFacetOp,
  MergeIntoOp,
  KeepOp,
  ExtractNonEntityOp,
} from "./manifest.js";
export {
  CONVERSION_MANIFEST,
  CONVERSION_OP_TYPES,
  validateManifest,
  collectOpKeys,
  buildPropertyMappingJson,
} from "./manifest.js";

export type {
  OpCounts,
  OpStatus,
  OpResult,
  RunOptions,
  RunSummary,
} from "./engine.js";
export {
  runConversions,
  ensureConversionsLedger,
  opHasDestructiveTail,
} from "./engine.js";
