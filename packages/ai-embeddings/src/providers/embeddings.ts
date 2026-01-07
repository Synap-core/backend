/**
 * Embeddings Provider
 * 
 * Provides embedding clients for different providers (OpenAI, deterministic, etc.)
 */

import { OpenAIEmbeddings } from '@langchain/openai';
import type { Embeddings as BaseEmbeddings } from '@langchain/core/embeddings';
import { config } from '@synap-core/core';
import { createLogger } from '@synap-core/core';

const logger = createLogger({ module: 'embeddings-provider' });

/**
 * Simple embeddings interface for fallback implementation
 */
interface SimpleEmbeddings {
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

/**
 * Get embeddings client based on configuration
 * 
 * @returns Embeddings client (OpenAI or deterministic)
 */
export function getEmbeddingsClient(): BaseEmbeddings | SimpleEmbeddings {
  const { provider, model } = config.ai.embeddings;

  if (provider === 'openai') {
    const apiKey = config.ai.openai.apiKey;
    if (!apiKey) {
      throw new Error('OpenAI embeddings require OPENAI_API_KEY environment variable');
    }

    logger.debug({ model, provider }, 'Using OpenAI embeddings');
    return new OpenAIEmbeddings({
      openAIApiKey: apiKey,
      modelName: model,
      dimensions: getEmbeddingDimensions(),
    });
  }

  if (provider === 'deterministic') {
    logger.debug({ provider }, 'Using deterministic embeddings (fallback)');
    // Deterministic embeddings are a simple hash-based approach
    // This is a fallback when no API key is available
    return new DeterministicEmbeddings();
  }

  throw new Error(`Unsupported embedding provider: ${provider}`);
}

/**
 * Get embedding dimensions based on model
 * 
 * @returns Number of dimensions for the embedding vector
 */
export function getEmbeddingDimensions(): number {
  const { model } = config.ai.embeddings;

  // OpenAI models
  if (model === 'text-embedding-3-small') return 1536;
  if (model === 'text-embedding-3-large') return 3072;
  if (model === 'text-embedding-ada-002') return 1536;

  // Default to 1536 (most common)
  return 1536;
}

/**
 * Deterministic Embeddings (Fallback)
 * 
 * Simple hash-based embeddings for when no API key is available.
 * Not recommended for production, but useful for development/testing.
 */
class DeterministicEmbeddings implements SimpleEmbeddings {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(text => this.embedQuery(text)));
  }

  async embedQuery(text: string): Promise<number[]> {
    // Simple hash-based deterministic embedding
    // This is NOT a real embedding, just a placeholder
    const hash = this.simpleHash(text);
    const dimensions = 1536;
    const embedding = new Array(dimensions).fill(0);

    // Fill with pseudo-random values based on hash
    for (let i = 0; i < dimensions; i++) {
      embedding[i] = Math.sin(hash + i) * 0.5;
    }

    // Normalize
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return embedding.map(val => val / magnitude);
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }
}

