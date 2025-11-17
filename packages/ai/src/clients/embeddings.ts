import { createLogger } from '@synap/core';
import { getEmbeddingDimensions as providerEmbeddingDimensions, getEmbeddingsClient } from '../providers/embeddings.js';

const logger = createLogger({ module: 'embedding-client' });

const EMBEDDING_DIMENSIONS = providerEmbeddingDimensions();
const encoder = new TextEncoder();

export const getEmbeddingDimensions = (): number => EMBEDDING_DIMENSIONS;

function deterministicEmbedding(text: string): number[] {
  const bytes = encoder.encode(text);
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

  for (let index = 0; index < bytes.length; index += 1) {
    const bucket = bytes[index] % EMBEDDING_DIMENSIONS;
    vector[bucket] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const embeddings = getEmbeddingsClient();

  try {
    const vector = await embeddings.embedQuery(text);

    if (!Array.isArray(vector) || vector.length === 0) {
      logger.warn('Embeddings provider returned an empty vector. Falling back to deterministic output.');
      return deterministicEmbedding(text);
    }

    return vector;
  } catch (error) {
    logger.error({ err: error }, 'Failed to generate embedding. Returning deterministic vector.');
    return deterministicEmbedding(text);
  }
}



