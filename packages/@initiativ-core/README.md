# @initiativ/core

Main orchestrator for Initiativ Core. Brings together all subsystems to provide a complete knowledge management system.

## Features

- ✅ **System Initialization** - Manages all subsystems
- ✅ **Workflows** - Pre-defined workflows (capture, search, insights)
- ✅ **Chat Branching** - "Chain of Thoughts" implementation
- ✅ **LLM-Agnostic** - Works with any provider
- ✅ **Git Versioning** - Auto-commits with batching

## Installation

```bash
npm install @initiativ/core
```

## Usage

### Basic Setup

```typescript
import { InitiativCore } from '@initiativ/core';
import { Workflows } from '@initiativ/core';

const core = new InitiativCore({
  dataPath: './.initiativ',
  userId: 'user-123',
  
  // Embeddings provider (OpenAI, Cohere, etc.)
  embeddingsProvider: 'openai',
  embeddingsApiKey: process.env.OPENAI_API_KEY,
  
  // Agent LLM (Claude)
  agentApiKey: process.env.ANTHROPIC_API_KEY,
  agentModel: 'claude-3-haiku-20240307'
});

await core.init();

const workflows = new Workflows(core);
```

### Capture Notes

```typescript
// Text note
const note = await workflows.captureNote({
  type: 'text',
  data: 'My idea about AI agents'
});

// With AI enrichment
const enrichedNote = await workflows.captureNote(
  {
    type: 'text',
    data: 'Building a recommendation system with collaborative filtering'
  },
  { autoEnrich: true } // Auto-generates tags and title
);

console.log(enrichedNote.title); // AI-generated
console.log(enrichedNote.tags);  // AI-generated
```

### Search Notes

```typescript
// Full-text search (fast, local)
const ftsResults = await workflows.searchNotes('machine learning', {
  useRAG: false
});

// Semantic search (intelligent, requires embeddings)
const ragResults = await workflows.searchNotes('ML concepts', {
  useRAG: true,
  limit: 5
});
```

### Get Insights

```typescript
const insights = await workflows.getInsights();

for (const insight of insights) {
  console.log(insight.message);
  // "You have 42 notes in your knowledge base"
  // "Your top topics: AI, development, ideas"
  // "You create an average of 3.2 notes per day"
}
```

### Chat Branching ("Chain of Thoughts")

```typescript
import { ChatManager } from '@initiativ/core';

const chatManager = new ChatManager(
  core.storage,
  core.memory,
  core.agents
);

// Create branch
const branch = await chatManager.createBranch(
  'Design landing page for project X'
);

// Work in branch
chatManager.addMessage(branch.id, 'user', 'What sections should I include?');
chatManager.addMessage(branch.id, 'assistant', 'Hero, Features, Pricing');

// Merge back to main
const summary = await chatManager.merge(branch.id);

console.log(summary.summary);    // AI-generated summary
console.log(summary.facts);      // Extracted user preferences
console.log(summary.artifacts);  // Notes created in branch
```

## Configuration

### CoreConfig

```typescript
interface CoreConfig {
  // Required
  dataPath: string;           // Where to store data
  userId: string;             // User identifier
  
  // Embeddings provider
  embeddingsProvider: 'openai' | 'cohere' | 'anthropic' | 'local';
  embeddingsApiKey?: string;  // Required unless local
  embeddingsModel?: string;   // Optional, uses defaults
  
  // Audio transcription
  transcriptionProvider?: 'openai-whisper' | 'local-whisper';
  transcriptionApiKey?: string;
  
  // Agent LLM
  agentApiKey: string;        // Anthropic API key
  agentModel?: string;        // Default: claude-3-haiku-20240307
  
  // Optional settings
  autoRebuildCache?: boolean;      // Default: true
  autoCommitEnabled?: boolean;     // Default: true
  autoCommitIntervalMs?: number;   // Default: 5 minutes
}
```

### Provider Examples

```typescript
// OpenAI for embeddings (best quality/cost)
{
  embeddingsProvider: 'openai',
  embeddingsApiKey: process.env.OPENAI_API_KEY,
  embeddingsModel: 'text-embedding-3-small'
}

// Cohere for embeddings (alternative)
{
  embeddingsProvider: 'cohere',
  embeddingsApiKey: process.env.COHERE_API_KEY,
  embeddingsModel: 'embed-english-v3.0'
}

// Future: Local embeddings (privacy, offline)
{
  embeddingsProvider: 'local'
  // No API key needed
}
```

## Architecture

### System Flow

```
User Input
    ↓
InputRouter → Process (text/audio)
    ↓
Storage → Save as .md file
    ↓
Agents → Enrich (tags, title)
    ↓
RAG → Update search index
    ↓
Git → Auto-commit (batched)
```

### Chat Branching Flow

```
Main Thread
    ↓
Create Branch → New context for focused work
    ↓
Work in Branch → Messages + actions
    ↓
Merge → Summary + facts + artifacts → Back to main
```

## System Status

```typescript
const status = core.getStatus();

console.log(status);
// {
//   initialized: true,
//   storage: { totalNotes: 42, totalTags: 15 },
//   rag: { totalDocuments: 42, provider: 'openai', model: 'text-embedding-3-small' },
//   git: { pendingCommits: 3 }
// }
```

## Shutdown

```typescript
// Always shut down gracefully
await core.shutdown();
// - Flushes pending Git commits
// - Closes database connections
// - Stops auto-commit timer
```

## Testing

```bash
npm test
```

Integration tests cover:
- ✅ Note capture (text)
- ✅ AI enrichment (tags, titles)
- ✅ Search (FTS + RAG)
- ✅ Insights generation
- ✅ Chat branching (create, merge)
- ✅ System status

## License

MIT

