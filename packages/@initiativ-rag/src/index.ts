/**
 * @initiativ/rag
 * RAG (Retrieval-Augmented Generation) for Initiativ Core
 * 
 * Now using LlamaIndex for better abstraction and Qdrant support
 */

import { LlamaIndexRAG } from './llamaindex-rag.js';

// Re-export main class and types
export { LlamaIndexRAG as RAGEngine } from './llamaindex-rag.js';
export * from './types.js';

// For backward compatibility
export default LlamaIndexRAG;
