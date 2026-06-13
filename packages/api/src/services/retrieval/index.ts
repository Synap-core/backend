/**
 * Synap Retrieval Engine (SRE) — barrel.
 * See team/platform/retrieval-architecture.mdx for the architecture + roadmap.
 */
export { retrieve } from "./retrieve.js";
export type { RetrieveParams, RetrieveResult } from "./retrieve.js";
export { hybridRecall, embedQuery, rrf } from "./hybrid-recall.js";
export type {
  HybridRecallParams,
  HybridRecallResult,
} from "./hybrid-recall.js";
export {
  understandQuery,
  type ProfileCatalogEntry,
  type PropertyHint,
  type QueryUnderstanding,
} from "./understand-query.js";
export { matchesHint } from "./property-hint-match.js";
