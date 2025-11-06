/**
 * Types for RAG operations
 */

export interface Document {
  id: string;
  content: string;
  metadata: Record<string, any>;
}

export interface SearchResult {
  document: Document;
  score: number;
  distance: number;
}

export type EmbeddingsProvider = 'openai' | 'anthropic' | 'google' | 'cohere' | 'local';

export interface RAGConfig {
  provider: EmbeddingsProvider;
  apiKey?: string; // Optional for local models
  model?: string; // LLM model (e.g., 'gpt-3.5-turbo')
  embeddingsModel?: string; // Embeddings model (e.g., 'text-embedding-3-small')
  
  // Vector store options
  useQdrant?: boolean;
  qdrantUrl?: string;
  qdrantCollectionName?: string;
}

export interface EmbeddingStats {
  totalDocuments: number;
  provider: string;
  vectorStore?: 'memory' | 'qdrant';
}
