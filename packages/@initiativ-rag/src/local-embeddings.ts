/**
 * Local Embeddings using @xenova/transformers
 * 
 * Runs embeddings locally without any API calls
 * Compatible with LlamaIndex interface for easy switching
 */

import { pipeline } from '@xenova/transformers';

export class LocalEmbedding {
  private model: any | null = null;
  private modelName: string;
  private isInitialized: boolean = false;

  constructor(modelName: string = 'Xenova/all-MiniLM-L6-v2') {
    this.modelName = modelName;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    console.log(`📦 Loading local embedding model: ${this.modelName}...`);
    this.model = await pipeline('feature-extraction', this.modelName);
    this.isInitialized = true;
    console.log(`✅ Local embedding model loaded`);
  }

  async getTextEmbedding(text: string): Promise<number[]> {
    if (!this.model) {
      await this.initialize();
    }

    const output = await this.model!(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  async getTextEmbeddings(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (const text of texts) {
      const embedding = await this.getTextEmbedding(text);
      embeddings.push(embedding);
    }
    return embeddings;
  }

  // LlamaIndex-compatible interface
  getDimensions(): number {
    // all-MiniLM-L6-v2 produces 384-dim embeddings
    return 384;
  }
}

