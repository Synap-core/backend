/**
 * @synap/ai-embeddings - Embeddings Package
 *
 * Open-source package for generating embeddings (vector representations of text).
 * Used by the Data Pod for semantic search and vector indexing.
 *
 * @example
 * ```typescript
 * import { generateEmbedding } from '@synap/ai-embeddings';
 *
 * const embedding = await generateEmbedding("Hello world");
 * // Returns: [0.123, -0.456, ...] (1536 dimensions)
 * ```
 */

export { generateEmbedding, generateEmbeddings } from "./clients/embeddings.js";
export {
  getEmbeddingsClient,
  getEmbeddingDimensions,
} from "./providers/embeddings.js";
