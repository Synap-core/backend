# ⚠️ DEPRECATED PACKAGE

**Status**: This package is deprecated and should not be used for new development.

## Why Deprecated?

This package has been superseded by direct OpenAI SDK usage or the Intelligence Service.

- **Original Purpose**: Generate embeddings for vector search
- **Current State**: Only 2 dynamic imports (hub router, n8n actions)
- **Better Alternative**: Use OpenAI SDK directly or move to `@synap/api/utils/embeddings`

## Migration Path

### If you're using `generateEmbedding`:
```typescript
// OLD (deprecated)
import { generateEmbedding } from '@synap/ai-embeddings';

// NEW - Use utility in @synap/api
import { generateEmbedding } from '@synap/api/utils/embeddings';

// OR - Use OpenAI SDK directly
import { OpenAIEmbeddings } from '@langchain/openai';
const client = new OpenAIEmbeddings({ openAIApiKey: apiKey });
const embedding = await client.embedQuery(text);
```

## Current Usage

This package is currently used in:
- `packages/api/src/routers/hub.ts` - Dynamic import for embeddings
- `packages/api/src/routers/n8n/actions.ts` - Dynamic import for embeddings

## Should I Delete This?

**Not yet** - We're keeping it for reference, but it should be removed in a future cleanup.

## Timeline

- **Created**: Early 2024
- **Deprecated**: January 2026
- **Planned Removal**: TBD

---

For questions, see the analysis document: `ai_packages_analysis.md`
