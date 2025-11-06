/**
 * LlamaIndex RAG Implementation
 * 
 * Multi-provider embeddings with LlamaIndex + optional Qdrant storage
 * Based on LlamaIndex 0.7.x best practices
 */

import { 
  Document as LlamaDocument,
  VectorStoreIndex,
  OpenAIEmbedding,
  QdrantVectorStore,
  storageContextFromDefaults,
  Settings
} from 'llamaindex';
import { GeminiEmbedding } from '@llamaindex/google';
import { Document, SearchResult, RAGConfig } from './types.js';

// Type for base embedding model
type BaseEmbedding = any; // LlamaIndex's BaseEmbedding type

export class LlamaIndexRAG {
  private index?: VectorStoreIndex;
  private config: RAGConfig;
  private documents: Map<string, Document>;
  private embedModel: BaseEmbedding;

  constructor(config: RAGConfig) {
    this.config = config;
    this.documents = new Map();
    
    // Create and configure embeddings model globally
    this.embedModel = this.createEmbeddings(config);
    
    // Set global Settings for LlamaIndex
    Settings.embedModel = this.embedModel;
  }

  /**
   * Create embeddings model for the specified provider
   * 
   * NOTE: For now, we only support OpenAI directly via LlamaIndex
   * Google/Cohere require LangChain bridge or custom implementation
   */
  private createEmbeddings(config: RAGConfig): BaseEmbedding {
    switch (config.provider) {
      case 'openai':
        // OpenAI is natively supported by LlamaIndex
        return new OpenAIEmbedding({
          apiKey: config.apiKey,
          model: config.embeddingsModel || 'text-embedding-3-small',
          dimensions: 1536
        });

      case 'google':
        return new GeminiEmbedding({
          apiKey: config.apiKey
        });

      case 'cohere':
        // Cohere requires separate package
        console.warn('⚠️  Cohere embeddings via LlamaIndex requires llama-index-embeddings-cohere package');
        console.warn('   Using OpenAI embeddings as fallback for Phase 1');
        
        if (process.env.OPENAI_API_KEY) {
          return new OpenAIEmbedding({
            apiKey: process.env.OPENAI_API_KEY,
            model: 'text-embedding-3-small'
          });
        }
        throw new Error('Cohere embeddings not yet supported. Use OpenAI for Phase 1.');

      case 'local':
        // Local embeddings are under maintenance - use OpenAI fallback
        console.warn('⚠️  Local embeddings are under maintenance.');
        
        if (process.env.OPENAI_API_KEY) {
          console.warn('   Using OpenAI as fallback. Set EMBEDDINGS_PROVIDER=openai to suppress this warning.');
          return new OpenAIEmbedding({
            apiKey: process.env.OPENAI_API_KEY,
            model: 'text-embedding-3-small'
          });
        }
        
        throw new Error('Local embeddings not yet stable. Please use EMBEDDINGS_PROVIDER=openai or google.');

      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  /**
   * Initialize vector store (Qdrant or in-memory)
   */
  async initialize(options?: { useQdrant?: boolean; qdrantUrl?: string }): Promise<void> {
    if (options?.useQdrant) {
      // Use Qdrant vector store (production)
      const vectorStore = new QdrantVectorStore({
        url: options.qdrantUrl || 'http://localhost:6333',
        collectionName: 'initiativ-notes'
      });

      const storageContext = await storageContextFromDefaults({ vectorStore });
      
      // Create empty index with Qdrant (Settings.embedModel is used automatically)
      this.index = await VectorStoreIndex.fromDocuments([], {
        storageContext
      });
    } else {
      // Use in-memory store (Settings.embedModel is used automatically)
      this.index = await VectorStoreIndex.fromDocuments([]);
    }
  }

  /**
   * Index a single document
   */
  async indexDocument(document: Document): Promise<void> {
    if (!this.index) {
      await this.initialize();
    }

    // Convert to LlamaIndex document
    const llamaDoc = new LlamaDocument({
      text: document.content,
      id_: document.id,
      metadata: document.metadata
    });

    // Store document for later retrieval
    this.documents.set(document.id, document);

    // Add to index (uses this.embedModel automatically)
    await this.index!.insert(llamaDoc);
  }

  /**
   * Index multiple documents (batch)
   * 
   * For large batches, this is more efficient than individual inserts
   */
  async indexDocuments(documents: Document[]): Promise<void> {
    if (!this.index) {
      await this.initialize();
    }

    if (documents.length === 0) return;

    // Convert to LlamaIndex documents
    const llamaDocs = documents.map(doc => {
      this.documents.set(doc.id, doc);
      return new LlamaDocument({
        text: doc.content,
        id_: doc.id,
        metadata: doc.metadata
      });
    });

    // For in-memory: insert one by one (LlamaIndex limitation)
    // For Qdrant: could batch more efficiently
    for (const doc of llamaDocs) {
      await this.index!.insert(doc);
    }
  }

  /**
   * Search for similar documents
   * 
   * Uses asRetriever() instead of asQueryEngine() because:
   * - We don't need LLM for text generation (we use Anthropic separately)
   * - We only need vector similarity search
   * - This avoids needing to configure Settings.llm
   */
  async search(query: string, limit: number = 10): Promise<SearchResult[]> {
    if (!this.index) {
      throw new Error('Index not initialized. Call initialize() first.');
    }

    // Use retriever (embeddings only, no LLM needed)
    const retriever = this.index.asRetriever({
      similarityTopK: limit
    });

    // Retrieve similar nodes
    const nodes = await retriever.retrieve(query);

    // Convert to our SearchResult format
    const results: SearchResult[] = [];
    
    for (const node of nodes) {
      const docId = node.node.id_;
      const originalDoc = this.documents.get(docId);
      
      if (originalDoc) {
        results.push({
          document: originalDoc,
          score: node.score || 0,
          distance: 1 - (node.score || 0)
        });
      }
    }

    return results;
  }

  /**
   * Remove a document from the index
   */
  async removeDocument(documentId: string): Promise<void> {
    if (!this.index) return;

    // Remove from our document map
    this.documents.delete(documentId);

    // Note: LlamaIndex in-memory doesn't have direct delete
    // For Qdrant, we could use vectorStore.delete()
    // For now, user should reinitialize if they need to remove documents
    console.warn('Document removal requires reindexing for in-memory store');
  }

  /**
   * Clear all documents and reinitialize
   */
  async clear(): Promise<void> {
    this.documents.clear();
    await this.initialize();
  }

  /**
   * Get embeddings statistics
   */
  getStats(): { totalDocuments: number; provider: string } {
    return {
      totalDocuments: this.documents.size,
      provider: this.config.provider
    };
  }
}
