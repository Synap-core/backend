import OpenAI from 'openai';
import { createLogger } from '@synap/core';

const EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_MODEL = process.env.EMBEDDINGS_MODEL ?? 'text-embedding-3-small';
const provider = (process.env.EMBEDDINGS_PROVIDER ?? 'openai').toLowerCase();

const logger = createLogger({ module: 'embedding-client' });

let openaiClient: OpenAI | null = null;

if (provider === 'openai') {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.warn('OPENAI_API_KEY is not set. Falling back to deterministic embeddings.');
  } else {
    openaiClient = new OpenAI({ apiKey });
    logger.info({ model: DEFAULT_MODEL }, 'Configured OpenAI embeddings client.');
  }
} else {
  logger.warn({ provider }, 'Unsupported embedding provider configured. Falling back to deterministic embeddings.');
}

const deterministicEmbedding = (text: string): number[] => {
  const encoder = new TextEncoder();
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
};

export const getEmbeddingDimensions = (): number => EMBEDDING_DIMENSIONS;

export async function generateEmbedding(text: string): Promise<number[]> {
  if (openaiClient) {
    try {
      const response = await openaiClient.embeddings.create({
        model: DEFAULT_MODEL,
        input: text,
      });

      const embedding = response.data?.[0]?.embedding;

      if (!embedding || embedding.length === 0) {
        logger.error('Received empty embedding from OpenAI. Falling back to deterministic generator.');
      } else {
        return embedding;
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate embedding via OpenAI. Falling back to deterministic generator.');
    }
  }

  return deterministicEmbedding(text);
}



