/**
 * Synap Retrieval Engine (SRE) — barrel.
 * See team/platform/retrieval-architecture.mdx for the architecture + roadmap.
 */
export { retrieve } from "./retrieve.js";
export type {
  RetrieveParams,
  RetrieveResult,
  RankComparison,
  RankedItem,
  MovedItem,
} from "./retrieve.js";
export { resolveRankStrategy, type RankStrategy } from "./rank-strategy.js";
export { viewCountsByEntity } from "./reinforcement-signal.js";
export {
  horizonScore,
  horizonRerank,
  HORIZON_WEIGHTS,
  HORIZON_HALF_LIFE_DAYS,
  type HorizonLens,
  type HorizonWeights,
  type HorizonRow,
  type HorizonOpts,
  type HorizonScored,
} from "./horizon-rerank.js";
export { hybridRecall, embedQuery, rrf } from "./hybrid-recall.js";
export type {
  HybridRecallParams,
  HybridRecallResult,
} from "./hybrid-recall.js";
export {
  understandQuery,
  toProfileCatalogEntry,
  type ProfileCatalogEntry,
  type PropertyHint,
  type QueryUnderstanding,
} from "./understand-query.js";
export { matchesHint } from "./property-hint-match.js";
export {
  graphExpand,
  buildAdjacency,
  pprLitePropagate,
  type Seed,
  type Edge,
  type GraphHit,
} from "./graph-signal.js";
export {
  recencyScore,
  latestEventTimestamps,
  type TemporalRow,
} from "./temporal-signal.js";
export {
  gradeResults,
  rekey,
  type RetrievalVerdict,
  type Grade,
} from "./grade.js";
export {
  compositeRerank,
  type RerankRow,
  type RerankOpts,
} from "./composite-rerank.js";
export { COMMON_STOPWORDS, QUESTION_WORDS } from "./stopwords.js";
