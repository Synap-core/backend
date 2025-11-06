/**
 * LlamaIndex-compatible adapter for local embeddings
 * 
 * Wraps LocalEmbedding to match BaseEmbedding interface
 */

import { LocalEmbedding } from './local-embeddings.js';

/**
 * Adapter that wraps LocalEmbedding for LlamaIndex compatibility
 */
export class LocalEmbeddingAdapter {
  private localEmbed: LocalEmbedding;
  private initialized: boolean = false;

  constructor(modelName?: string) {
    this.localEmbed = new LocalEmbedding(modelName);
  }

  /**
   * Initialize the embedding model
   */
  async initialize(): Promise<void> {
    if (!this.initialized) {
      await this.localEmbed.initialize();
      this.initialized = true;
    }
  }

  /**
   * Get embedding for a single text
   * LlamaIndex expects this method
   */
  async getTextEmbedding(text: string): Promise<number[]> {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.localEmbed.getTextEmbedding(text);
  }

  /**
   * Get embeddings for multiple texts (batch)
   * LlamaIndex uses this for efficiency
   */
  async getTextEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.localEmbed.getTextEmbeddings(texts);
  }

  /**
   * Get the embedding dimensions
   */
  getDimensions(): number {
    return this.localEmbed.getDimensions();
  }

  /**
   * Model type identifier
   */
  getModelType(): string {
    return 'local';
  }
}


