/**
 * Embeddings Client
 *
 * High-level client for generating embeddings from text.
 */

import {
  getEmbeddingsClient,
  getEmbeddingDimensions,
} from "../providers/embeddings.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "embeddings-client" });

/**
 * Generate embedding vector for a single text
 *
 * @param text - Text to generate embedding for
 * @returns Embedding vector as array of numbers
 * @throws Error if embedding generation fails
 *
 * @example
 * ```typescript
 * const embedding = await generateEmbedding("Hello world");
 * // Returns: [0.123, -0.456, ...] (1536 dimensions for text-embedding-3-small)
 * ```
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    throw new Error("Text cannot be empty");
  }

  try {
    const client = getEmbeddingsClient();
    const embedding = await client.embedQuery(text);

    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error("Embedding generation returned empty vector");
    }

    const expectedDimensions = getEmbeddingDimensions();
    if (embedding.length !== expectedDimensions) {
      logger.warn(
        {
          actualDimensions: embedding.length,
          expectedDimensions,
          textLength: text.length,
        },
        "Embedding dimensions mismatch"
      );
    }

    logger.debug(
      {
        dimensions: embedding.length,
        textLength: text.length,
        textPreview: text.substring(0, 50),
      },
      "Generated embedding"
    );

    return embedding;
  } catch (error) {
    logger.error(
      { err: error, textLength: text.length },
      "Failed to generate embedding"
    );
    throw error;
  }
}

/**
 * Generate embeddings for multiple texts
 *
 * @param texts - Array of texts to generate embeddings for
 * @returns Array of embedding vectors
 * @throws Error if embedding generation fails
 *
 * @example
 * ```typescript
 * const embeddings = await generateEmbeddings(["Hello", "World"]);
 * // Returns: [[0.123, ...], [0.456, ...]]
 * ```
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (!texts || texts.length === 0) {
    throw new Error("Texts array cannot be empty");
  }

  try {
    const client = getEmbeddingsClient();
    const embeddings = await client.embedDocuments(texts);

    if (!Array.isArray(embeddings) || embeddings.length === 0) {
      throw new Error("Embedding generation returned empty array");
    }

    logger.debug(
      {
        count: embeddings.length,
        dimensions: embeddings[0]?.length || 0,
      },
      "Generated embeddings batch"
    );

    return embeddings;
  } catch (error) {
    logger.error(
      { err: error, count: texts.length },
      "Failed to generate embeddings batch"
    );
    throw error;
  }
}
