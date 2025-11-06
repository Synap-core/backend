# @initiativ/rag

RAG (Retrieval-Augmented Generation) for Initiativ Core using **LlamaIndex**.

## Features

- ✅ **LlamaIndex integration** - Battle-tested RAG framework
- ✅ **Multi-provider support** - OpenAI, Google, Anthropic (text only), Cohere
- ✅ **Qdrant vector store** - Production-ready vector database
- ✅ **In-memory fallback** - Simple setup for < 10K documents
- ✅ **Easy provider switching** - Change with one config line

## Installation

```bash
npm install @initiativ/rag
```

## Quick Start

### Option 1: In-Memory (Default, Simple)

```typescript
import { RAGEngine } from '@initiativ/rag';

const rag = new RAGEngine({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  embeddingsModel: 'text-embedding-3-small'
});

// Initialize
await rag.initialize();

// Index documents
await rag.indexDocuments([
  { id: '1', content: 'My note about AI', metadata: { tags: ['ai'] } },
  { id: '2', content: 'My note about blockchain', metadata: { tags: ['blockchain'] } }
]);

// Search
const results = await rag.search('artificial intelligence', 5);
console.log(results);
```

### Option 2: With Qdrant (Production)

```typescript
import { RAGEngine } from '@initiativ/rag';

const rag = new RAGEngine({
  provider: 'google',
  apiKey: process.env.GOOGLE_API_KEY,
  embeddingsModel: 'text-embedding-004',
  useQdrant: true,
  qdrantUrl: 'http://localhost:6333',
  qdrantCollectionName: 'my-notes'
});

await rag.initialize({ useQdrant: true });

// Same API as before!
await rag.indexDocuments(documents);
const results = await rag.search(query);
```

## Supported Providers

### OpenAI (Default)
```typescript
{
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-3.5-turbo', // For query understanding
  embeddingsModel: 'text-embedding-3-small'
}
```

### Google Gemini
```typescript
{
  provider: 'google',
  apiKey: process.env.GOOGLE_API_KEY,
  embeddingsModel: 'text-embedding-004'
}
```

### Anthropic (Text Only)
```typescript
{
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Note: Will use OpenAI for embeddings (Anthropic has no embeddings API)
  embeddingsApiKey: process.env.OPENAI_API_KEY
}
```

### Cohere
```typescript
{
  provider: 'cohere',
  apiKey: process.env.COHERE_API_KEY,
  embeddingsModel: 'embed-english-v3.0'
}
```

## Vector Stores

### In-Memory (Default)
- ✅ **Simple setup** - No external services
- ✅ **Fast** - All data in RAM
- ⚠️ **Limitations** - Lost on restart, < 10K docs recommended

### Qdrant (Production)
- ✅ **Persistent** - Data survives restarts
- ✅ **Scalable** - Millions of documents
- ✅ **Fast** - Optimized for vector search
- ⚠️ **Setup required** - Needs Qdrant server

#### Setup Qdrant (Docker)

```bash
docker run -p 6333:6333 qdrant/qdrant
```

Or install locally: https://qdrant.tech/documentation/quick-start/

## API Reference

### RAGEngine

#### Constructor
```typescript
new RAGEngine(config: RAGConfig)
```

#### Methods

**`initialize(options?)`**
Initialize the vector store.
```typescript
await rag.initialize({ 
  useQdrant: true, 
  qdrantUrl: 'http://localhost:6333' 
});
```

**`indexDocument(document)`**
Index a single document.
```typescript
await rag.indexDocument({
  id: 'note-123',
  content: 'My note content',
  metadata: { tags: ['important'] }
});
```

**`indexDocuments(documents)`**
Index multiple documents (batch).
```typescript
await rag.indexDocuments([doc1, doc2, doc3]);
```

**`search(query, limit?)`**
Search for similar documents.
```typescript
const results = await rag.search('AI and machine learning', 10);
// Returns: SearchResult[]
```

**`removeDocument(documentId)`**
Remove a document from the index.
```typescript
await rag.removeDocument('note-123');
```

**`clear()`**
Clear all documents.
```typescript
await rag.clear();
```

**`getStats()`**
Get indexing statistics.
```typescript
const stats = rag.getStats();
// { totalDocuments: 328, provider: 'google', vectorStore: 'qdrant' }
```

## Switching Providers

LlamaIndex makes it easy to switch providers:

```typescript
// Week 1: Start with OpenAI
const rag = new RAGEngine({ provider: 'openai', apiKey: '...' });

// Week 2: Switch to Google (just change config)
const rag = new RAGEngine({ provider: 'google', apiKey: '...' });

// Week 3: Add Qdrant (no code changes needed!)
const rag = new RAGEngine({ 
  provider: 'google', 
  apiKey: '...',
  useQdrant: true 
});
```

## Performance

| Operation | In-Memory | Qdrant |
|-----------|-----------|---------|
| **Index 1000 notes** | ~30s | ~45s |
| **Search (cold)** | ~100ms | ~150ms |
| **Search (warm)** | ~50ms | ~80ms |
| **Storage** | RAM | Disk |

## Best Practices

1. **Start Simple** - Use in-memory for < 5K documents
2. **Use Qdrant** - For production or > 10K documents
3. **Batch Indexing** - Use `indexDocuments()` instead of multiple `indexDocument()`
4. **Provider Choice**:
   - OpenAI: Best quality, lowest cost
   - Google: Good quality, use with Anthropic for text
   - Local: Privacy, free (Phase 2)

## Troubleshooting

### "Index not initialized"
Call `await rag.initialize()` before indexing or searching.

### "Qdrant connection refused"
Make sure Qdrant is running: `docker ps` should show qdrant container.

### "Provider X not supported"
Check that you've installed the required provider package and set the API key.

## Migration from Custom RAG

If you used the old custom implementation:

```typescript
// Old (custom)
import { RAGEngine } from '@initiativ/rag';
const rag = new RAGEngine({ provider: 'openai', apiKey: '...' });

// New (LlamaIndex) - Same API!
import { RAGEngine } from '@initiativ/rag';
const rag = new RAGEngine({ provider: 'openai', apiKey: '...' });
await rag.initialize(); // Add this line
```

**That's it!** The API is backward-compatible.

## License

MIT
