import { OpenAIEmbeddings } from '@langchain/openai';
import { Embeddings as BaseEmbeddings } from '@langchain/core/embeddings';

type CoreModule = typeof import('@synap/core');

let coreModule: CoreModule | null = null;
let _config: CoreModule['config'] | null = null;
let _createLogger: CoreModule['createLogger'] | null = null;

async function loadCore(): Promise<CoreModule> {
  if (!coreModule) {
    coreModule = await import('@synap/core');
    _config = coreModule.config;
    _createLogger = coreModule.createLogger;
  }
  return coreModule!;
}

function getConfig() {
  if (!_config) {
    throw new Error(
      'Config not loaded. Please ensure @synap/core is imported before using embeddings.'
    );
  }
  return _config!;
}

function getLogger() {
  if (!_createLogger) {
    throw new Error(
      'Logger not loaded. Please ensure @synap/core is imported before using embeddings.'
    );
  }
  return _createLogger({ module: 'embedding-provider' });
}

// Pre-load config in the background
loadCore().catch(() => {
  // Will be loaded on first access
});

const DETERMINISTIC_DIMENSIONS = 1536;

let embeddingsClient: BaseEmbeddings | null = null;

const encoder = new TextEncoder();

const logger = () => getLogger();

class DeterministicEmbeddings extends BaseEmbeddings {
  constructor() {
    super({});
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    return documents.map((doc) => deterministicEmbedding(doc));
  }

  async embedQuery(document: string): Promise<number[]> {
    return deterministicEmbedding(document);
  }
}

function deterministicEmbedding(text: string): number[] {
  const bytes = encoder.encode(text);
  const vector = new Array<number>(DETERMINISTIC_DIMENSIONS).fill(0);

  for (let index = 0; index < bytes.length; index += 1) {
    const bucket = bytes[index] % DETERMINISTIC_DIMENSIONS;
    vector[bucket] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function initializeEmbeddings(): void {
  if (embeddingsClient) {
    return;
  }

  const { ai } = getConfig();

  if (ai.embeddings.provider === 'openai') {
    if (!ai.openai.apiKey) {
      logger().warn('OPENAI_API_KEY is not set. Falling back to deterministic embeddings.');
      embeddingsClient = new DeterministicEmbeddings();
      return;
    }

    embeddingsClient = new OpenAIEmbeddings({
      apiKey: ai.openai.apiKey,
      model: ai.embeddings.model,
      configuration: ai.openai.baseUrl
        ? {
            baseURL: ai.openai.baseUrl,
          }
        : undefined,
    });
    logger().info({ model: ai.embeddings.model }, 'Configured OpenAI embeddings client.');
    return;
  }

  embeddingsClient = new DeterministicEmbeddings();
  logger().info('Using deterministic embeddings provider.');
}

export function getEmbeddingsClient(): BaseEmbeddings {
  initializeEmbeddings();
  return embeddingsClient!;
}

export function getEmbeddingDimensions(): number {
  return DETERMINISTIC_DIMENSIONS;
}



