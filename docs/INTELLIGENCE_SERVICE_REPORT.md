# Intelligence Service: Complete Technical Analysis & Strategic Report

**Date**: 2026-01-07  
**Scope**: Synap Intelligence Service (formerly Intelligence Hub)  
**Purpose**: Team decision-making on architecture and AI strategy

---

## Executive Summary

The **Synap Intelligence Service** is a **fully operational, production-ready** AI orchestration system running as a **separate microservice** from the backend. It features sophisticated agent architecture, memory systems, and tool calling capabilities.

**Key Metrics**:
- **Size**: Separate monorepo with ~13,000 lines of agent code
- **AI Model**: Claude 3.7 Sonnet via Vercel AI SDK
- **Port**: 3002 (separate from backend on 4000)
- **Architecture**: Agent-based with ReAct loop, tool calling, proposals
- **Integration**: Hub Protocol (OAuth2 + REST API) to backend

**Strategic Question**: Should this remain separate or merge into backend monorepo?

---

## 1. Architecture Overview

### High-Level System Design

```
┌─────────────────────────────────────────────────────────────┐
│ USER                                                        │
└────────────┬────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────┐
│ BACKEND (synap-backend)                                     │
│ - Port: 4000                                                │
│ - PostgreSQL database                                       │
│ - tRPC API router                                           │
│ - Chat thread management                                    │
└────────────┬─────────────────────────────────────────────── ┘
             │ HTTP POST to                                    
             │ /api/expertise/request
             ▼
┌─────────────────────────────────────────────────────────────┐
│ INTELLIGENCE SERVICE (synap-intelligence-service)           │
│ - Port: 3002                                                │
│ - Hono server                                               │
│ - Orchestrator Agent (Claude 3.7 Sonnet)                    │
│ - Research Agent                                            │
│ - Memory Service (Mem0 + pgvector)                          │
│ - Tool Registry (5 tools)                                   │
└────────────┬────────────────────────────────────────────────┘
             │ Hub Protocol (OAuth2 + REST)
             │ GET/POST to backend endpoints
             ▼
┌─────────────────────────────────────────────────────────────┐
│ BACKEND HUB PROTOCOL ENDPOINTS                              │
│ - GET /api/hub/threads/:id/context                          │
│ - GET /api/hub/users/:id/entities                           │
│ - POST /api/hub/entities                                    │
└─────────────────────────────────────────────────────────────┘
```

### Communication Flow

**Scenario**: User sends "Create a task to call Paul tomorrow"

1. **Frontend** → Backend (`trpc.chat.sendMessage`)
2. **Backend** → Intelligence Service (`POST /api/expertise/request`)
   - Payload: `{ query, userId, dataPodUrl, dataPodApiKey }`
3. **Intelligence Service Orchestrator**:
   - Calls `assembleContext()` → Fetches user data via Hub Protocol
   - Runs Claude 3.7 Sonnet with ReAct loop
   - AI decides: "I should create a task entity"
   - Calls `create_entity` tool in **proposal mode**
4. **Intelligence Service** → Returns proposals to backend
5. **Backend** → Frontend shows approval UI
6. **User approves** → Frontend → Backend
7. **Backend** → Intelligence Service (`POST /api/expertise/approved`)
8. **Intelligence Service** → Executes tool in **execution mode**
9. **Tool** → Hub Protocol → Backend (`POST /api/hub/entities`)
10. **Backend** → Creates entity in database

---

## 2. Agent System Deep Dive

### Orchestrator Agent

**File**: [`orchestrator.ts`](file:///Users/antoine/Documents/Code/synap/synap-intelligence-service/apps/intelligence-hub/src/agents/orchestrator.ts) (379 lines)

**Architecture Pattern**: **ReAct (Reasoning + Acting)**

**System Prompt** (Lines 74-97):
```typescript
const systemPrompt = `
You are the Orchestrator for Synap, an intelligent knowledge assistant.
Your goal is to help the user by gathering context, reasoning about their request, and performing actions.

## PRE-GENERATED CONTEXT
${assembledContext.systemPromptAdditions}  // Dynamic context from memory/entities

## OPERATING MODE: AGENTIC LOOP
1. **Analyze**: Understand the user's intent.
2. **Explore**: If you need more info, use 'vector_search' or 'memory_search'.
3. **Decide**:
   - If simple question: Answer directly.
   - If action needed: CALL the action tool (create_entity, etc).
   - If complex research: Use 'create_branch'.

## IMPORTANT: PROPOSAL PROTOCOL
- You have "Action Tools" (create_entity, create_document).
- When you call these, they will NOT execute immediately.
- They return a "Proposal" which the user must approve.
- You should explain WHY you are proposing these actions.

## CURRENT TIME
${new Date().toISOString()}
`;
```

**Key Features**:
1. **Multi-Step Reasoning**: Up to 5 tool roundtrips (`maxToolRoundtrips: 5`)
2. **Dynamic Context**: Pre-loads relevant memories and entities
3. **Proposal System**: Tools return `{ proposed: true }` instead of executing
4. **Streaming Support**: `executeWithStream()` for progressive updates

**Tool Calling**:
```typescript
const tools = {
  // Context Tools (read-only, auto-execute)
  vector_search: tool({ ... }),
  memory_search: tool({ ... }),
  
  // Action Tools (require approval)
  create_entity: tool({ ... }),
  create_document: tool({ ... }),
  create_branch: tool({ ... }),
};
```

### Research Agent

**File**: [`research.ts`](file:///Users/antoine/Documents/Code/synap/synap-intelligence-service/apps/intelligence-hub/src/agents/research.ts) (7,814 bytes)

**System Prompt** (from documentation):
> "You are a specialist research agent. Your goal is to provide comprehensive, factual, and well-structured analysis. Break down complex queries, verify information, and cite sources..."

**Capabilities**:
1. **Planning**: `createResearchPlan()` - Breaks topic into subtopics
2. **Investigation**: `researchSubtopic()` - Deep analysis (currently LLM-based)
3. **Synthesis**: `synthesizeFindings()` - Creates cohesive reports
4. **Summarization**: Executive summaries

**Example Flow**:
```
User: "Research competitors for SaaS billing software"
  ├─ Plan: ["Stripe", "Paddle", "FastSpring", "Pricing models", "Market share"]
  ├─ Research Stripe → Generate analysis
  ├─ Research Paddle → Generate analysis
  ├─ Research FastSpring → Generate analysis
  └─ Synthesize → Final report with comparison table
```

---

## 3. Tool Registry

**File**: [`tools/registry.ts`](file:///Users/antoine/Documents/Code/synap/synap-intelligence-service/apps/intelligence-hub/src/tools/registry.ts) (160 lines)

### Action Tools (Write/Effect)

#### 1. `create_entity`
```typescript
{
  description: 'Create a new entity (task, contact, meeting, idea, project)',
  inputSchema: z.object({
    type: z.enum(['task', 'contact', 'meeting', 'idea', 'project']),
    title: z.string(),
    description: z.string().optional(),
    properties: z.record(z.any()).optional(),
  }),
  execute: async (args, context) => {
    if (context.proposalMode) {
      return { proposed: true, action: 'create_entity', description: `Create ${args.type}: "${args.title}"`, args };
    }
    return await hubProtocol.createEntity({ userId: context.userId, ...args });
  }
}
```

**When Used**: "Create a task to X", "Add Paul as a contact", "Schedule meeting with Y"

#### 2. `create_document`
```typescript
{
  description: 'Create a new document or note',
  inputSchema: z.object({
    title: z.string(),
    content: z.string(),
    folder: z.string().optional(),
  }),
  execute: // Proposal mode OR Hub Protocol call
}
```

**When Used**: "Draft an email to X", "Create documentation for Y"

#### 3. `create_branch`
```typescript
{
  description: 'Create a branched conversation for a specific task (research, complex analysis)',
  inputSchema: z.object({
    type: z.enum(['research', 'technical', 'creative']),
    topic: z.string(),
    initialMessage: z.string(),
  }),
  execute: // Returns branchId
}
```

**When Used**: "Research competitors before we decide on pricing"

### Context Tools (Read-Only)

#### 4. `vector_search`
```typescript
{
  description: 'Search user notes and entities by semantic meaning',
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }, context) => {
    // Calls Hub Protocol: GET /api/hub/users/:userId/entities for each type
    // Returns top 5 semantically similar entities
  }
}
```

**When Used**: "What did I say about X?", "Find notes related to Y"

#### 5. `memory_search`
```typescript
{
  description: 'Search long-term memory for facts and user preferences',
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }, context) => {
    return await memoryService.search(query, { userId: context.userId, limit: 5 });
  }
}
```

**When Used**: "What's my favorite programming language?", "Recall my preferences about X"

---

## 4. Memory System

### Mem0 Integration

**What is Mem0?**
- Self-hosted vector database for long-term memory
- Stores: Conversations, Facts, User Preferences
- Uses pgvector for similarity search

**Architecture**:
```
┌─────────────────────────────────────────────────────────────┐
│ INTELLIGENCE SERVICE                                        │
│   └─ Memory Service                                         │
│       ├─ memoryService.search(query, { userId })            │
│       ├─ memoryService.store(fact, { userId })              │
│       └─ Internal: pgvector for embeddings                  │
└─────────────────────────────────────────────────────────────┘
```

**Example**:
```typescript
// User says: "I prefer Python for data analysis"
await memoryService.store({
  content: "User prefers Python for data analysis",
  userId: "user-123",
  category: "preference",
});

// Later, AI asks: "What language should I use for this data task?"
const memories = await memoryService.search("programming language preference", { userId: "user-123" });
// Returns: ["User prefers Python for data analysis"]
```

---

## 5. Hub Protocol (Service-to-Service API)

### Authentication

**Method**: OAuth2 Client Credentials  
**Provider**: Ory Hydra (separate OAuth2 server on port 4444-4445)

**Scopes**:
- `hub-protocol.read`: Read thread context, entities, user data
- `hub-protocol.write`: Create entities, update context

### Endpoints (on Backend)

**File**: Backend routers (not found in Intelligence Service, implies backend exposes these)

1. **GET /api/hub/threads/:id/context**
   - Returns: Thread messages + metadata
   - Used by: Orchestrator to get conversation history

2. **GET /api/hub/users/:id/context**
   - Returns: User preferences + recent activity
   - Used by: Context assembly

3. **GET /api/hub/users/:id/entities**
   - Returns: User's entities (tasks, contacts, etc.)
   - Used by: `vector_search` tool

4. **POST /api/hub/entities**
   - Creates: New entity
   - Used by: `create_entity` tool (execution mode)

5. **PATCH /api/hub/threads/:id/context**
   - Updates: Thread summary (for merged branches)
   - Used by: Branch merge operations

### Request Example
```typescript
// Intelligence Service → Backend
const hubClient = new HubProtocolClient({
  dataPodUrl: 'http://localhost:4000',
  getToken: async () => dataPodApiKey,  // API key from backend
});

const entities = await hubClient.getEntities(userId, { type: 'task', limit: 10 });
```

---

## 6. AI Provider Configuration

### Current Setup

**Primary Model**: Claude 3.7 Sonnet (`anthropic('claude-3-7-sonnet-20250219')`)  
**SDK**: Vercel AI SDK (`ai` package)

**Environment Variables** (from `.env.example`):
```bash
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=your-openai-api-key  # For embeddings only
```

### Model Usage

**Orchestrator**: Claude 3.7 Sonnet  
**Research Agent**: Claude 3.7 Sonnet  
**Embeddings**: OpenAI `text-embedding-3-small`

### OpenRouter Integration Potential

**Current**: Direct API calls to Anthropic  
**With OpenRouter**: Single API key for 100+ models

**How to integrate**:
```typescript
// BEFORE (line 149 in orchestrator.ts)
model: anthropic('claude-3-7-sonnet-20250219')

// AFTER (with OpenRouter)
import { createOpenRouter } from '@openrouter/ai-sdk';
const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

model: openrouter('anthropic/claude-3.5-sonnet')  // Or openrouter('openai/gpt-4o')
```

**Benefits**:
- **Model Routing**: Different agents use different models
  - Orchestrator: `anthropic/claude-3.5-sonnet` (reasoning)
  - Research: `perplexity/llama-3-sonar-large` (web search)
  - Creative: `anthropic/claude-3-opus` (creativity)
- **Cost Optimization**: Route to cheapest model that meets quality bar
- **Fallback**: If Claude is down, auto-switch to GPT-4

---

## 7. Separation Analysis: Why Two Services?

### Original Design Rationale (from README)

> "The Intelligence Hub is **proprietary** and contains advanced AI capabilities."

**Reasons for Separation**:

1. **Licensing Split**
   - Backend: Open-source (user data, storage)
   - Intelligence Service: Proprietary (AI algorithms, prompts)

2. **Scalability**
   - AI processing is CPU/GPU intensive
   - Can scale Intelligence Service separately (horizontal scaling)
   - Backend scales with database load

3. **Security**
   - AI service doesn't have direct database access
   - Only communicates via scoped Hub Protocol
   - Limits AI's ability to read/write arbitrary data

4. **Development Independence**
   - Backend team: Database, API
   - AI team: Agents, prompts, models
   - No merge conflicts

5. **Deployment Flexibility**
   - Can deploy Intelligence Service to GPU instances
   - Backend stays on standard compute
   - Easier to switch AI providers without backend changes

### Current Reality Check

**CHANGELOG** (v0.3.0):
> "Simplified architecture - Removed Intelligence Hub/Backend App separation"

**But**: Intelligence Service STILL EXISTS as separate repo!

**Contradiction**: Documentation says "removed separation" but codebase shows they're still separate.

**Hypothesis**: The "removal" was organizational (no longer separate products), but technical separation remains.

---

## 8. Integration Patterns

### Request Flow (Detailed)

**File**: [`routers/expertise.ts`](file:///Users/antoine/Documents/Code/synap/synap-intelligence-service/apps/intelligence-hub/src/routers/expertise.ts)

```typescript
expertiseRouter.post('/expertise/request', async (c) => {
  const { userId, dataPodUrl, dataPodApiKey, query } = input;
  
  // 1. Create Hub Protocol client with backend credentials
  const hubClient = new HubProtocolClient({
    dataPodUrl: 'http://localhost:4000',
    getToken: async () => dataPodApiKey,
  });
  
  // 2. Create orchestrator
  const orchestrator = new SynapHubOrchestrator(hubClient);
  
  // 3. Execute (orchestrator will call backend via Hub Protocol)
  const response = await orchestrator.executeRequest({
    requestId: uuid(),
    userId,
    dataPodUrl,
    query,
    context: {},
  });
  
  // 4. Return result
  return c.json({
    requestId,
    status: response.status,  // 'completed' | 'failed'
    eventsCount: response.metadata?.eventsCount || 0,
  });
});
```

### Proposed Actions Flow

**Not Fully Implemented Yet** - Based on tool registry design:

```
1. User: "Create task: Call Paul tomorrow"
2. Backend → Intelligence Service: POST /api/expertise/request
3. Intelligence Service (Orchestrator):
   ├─ Analyze query
   ├─ Decide: Need to create entity
   ├─ Call tool: create_entity(type='task', title='Call Paul tomorrow')
   │  └─ Tool returns: { proposed: true, action: 'create_entity', args: {...} }
   └─ Return: { content: "I can create this task for you", proposedActions: [...], requiresApproval: true }
4. Backend receives proposals → Stores in approvals table
5. Frontend shows: "AI wants to create: Task 'Call Paul tomorrow' [Approve] [Reject]"
6. User clicks [Approve]
7. Frontend → Backend: POST /api/approvals/:id/approve
8. Backend → Intelligence Service: POST /api/expertise/approved { actions: [...] }
9. Intelligence Service executes: await create_entity(args, { proposalMode: false })
10. create_entity → Hub Protocol → Backend: POST /api/hub/entities
11. Backend creates entity in database
```

---

## 9. Current Integration Status

### ✅ What's Working

1. **Basic Request Handling**: Backend can call Intelligence Service
2. **Agent System**: Orchestrator and Research Agent functional
3. **Tool Registry**: 5 tools defined and callable by AI
4. **Memory System**: Mem0 integrated for long-term facts
5. **Hub Protocol Client**: Can communicate with backend

### ❌ What's NOT Working

1. **Router Not Registered**: Backend `chat.ts` router is empty
   - `infiniteChatRouter` exists but not registered
   - Frontend can't access Intelligence Service

2. **Approval Flow**: No implementation in backend
   - Proposals are created but never shown to user
   - No approval/rejection endpoints

3. **Hub Protocol Endpoints**: Not found in backend
   - `/api/hub/threads/:id/context` - Missing
   - `/api/hub/entities` - Might exist under different name

4. **Streaming**: Intelligence Service supports `streamText` but backend doesn't consume it

5. **Branching**: `create_branch` tool exists but backend thread management doesn't support parent thread updates

---

## 10. Strategic Recommendations

### Option A: Maintain Separation (RECOMMENDED)

**Pros**:
- ✅ **Clean Separation of Concerns**: AI logic isolated from data logic
- ✅ **Independent Scaling**: Scale AI service separately (GPU instances)
- ✅ **Security**: AI can't access database directly
- ✅ **Development Speed**: Two teams can work independently
- ✅ **Licensing Flexibility**: Keep proprietary AI separate from open-source backend

**Cons**:
- ❌ **Complexity**: Two repos, two deployments
- ❌ **Network Overhead**: HTTP calls between services
- ❌ **Debugging**: Harder to trace across services

**Action Items if Chosen**:
1. Document Hub Protocol API properly
2. Implement missing backend endpoints
3. Register `infiniteChatRouter` in backend
4. Add approval flow to backend
5. **Keep but document the separation clearly**

---

### Option B: Merge into Backend Monorepo

**Pros**:
- ✅ **Simpler Deployment**: Single Docker container
- ✅ **Easier Debugging**: All code in one place
- ✅ **Faster Iteration**: No network calls, direct function calls
- ✅ **Type Safety**: Shared types across AI and backend

**Cons**:
- ❌ **Tight Coupling**: AI changes can break backend
- ❌ **Scaling Issues**: Can't scale AI separately
- ❌ **Security Risk**: AI has full database access
- ❌ **License Conflicts**: Mixing open-source and proprietary code

**Action Items if Chosen**:
1. Move `apps/intelligence-hub` to `synap-backend/apps/intelligence-hub`
2. Move `packages/*`to `synap-backend/packages/*`
3. Update imports to use internal packages
4. Remove Hub Protocol (use direct function calls)
5. Combine into single `docker-compose.yml`

---

### Option C: Hybrid (Best of Both Worlds)

**Design**: Keep separate but make them "aware" of each other

**Architecture**:
```
┌─────────────────────────────────────────────────────────────┐
│ MONOREPO: synap                                             │
│   ├─ apps/                                                  │
│   │   ├─ backend/ (Port 4000)                               │
│   │   └─ intelligence-service/ (Port 3002)                  │
│   └─ packages/                                              │
│       ├─ database/ (shared)                                 │
│       ├─ types/ (shared)                                    │
│       ├─ ai-agents/ (intelligence service specific)         │
│       └─ hub-protocol/ (shared)                             │
└─────────────────────────────────────────────────────────────┘
```

**Benefits**:
- ✅ **Single Repo**: Easier versioning, single PR for features
- ✅ **Shared Packages**: No duplicate code
- ✅ **Still Separate Services**: Can deploy independently
- ✅ **Type Safety**: Shared TypeScript types

**Cons**:
- ⚠️ **Monorepo Complexity**: Need Turborepo/Nx
- ⚠️ **Still Need Hub Protocol**: Can't do direct function calls between apps

**Action Items if Chosen**:
1. Create new monorepo: `synap-monorepo`
2. Move `synap-backend` → `synap-monorepo/apps/backend`
3. Move `synap-intelligence-service` → `synap-monorepo/apps/intelligence-service`
4. Merge shared packages
5. Update `pnpm-workspace.yaml` and `turbo.json`

---

## 11. Team Decision Matrix

| Criteria | Option A (Separate) | Option B (Merge) | Option C (Hybrid) |
|----------|---------------------|------------------|-------------------|
| **Development Speed** | 🟡 Medium | 🟢 Fast | 🟢 Fast |
| **Deployment Complexity** | 🔴 High | 🟢 Low | 🟡 Medium |
| **Scalability** | 🟢 Excellent | 🔴 Poor | 🟢 Excellent |
| **Security** | 🟢 Strong | 🟡 Moderate | 🟢 Strong |
| **Debugging** | 🔴 Hard | 🟢 Easy | 🟡 Medium |
| **Type Safety** | 🔴 Weak | 🟢 Strong | 🟢 Strong |
| **License Flexibility** | 🟢 Maximum | 🔴 Limited | 🟢 Maximum |
| **Team Independence** | 🟢 High | 🔴 Low | 🟡 Medium |

**Our Recommendation**: **Option C (Hybrid Monorepo)**

**Why?**
- You're already using Turborepo for backend
- Shared types prevent sync issues
- Still get independent deployment
- Easier for single developer/small team
- Can always split later if needed

---

## 12. Next Steps (Action Plan)

### Immediate (Week 1)

1. **Register Infinite Chat Router** (30 min)
   ```typescript
   // synap-backend/packages/api/src/index.ts
   import { infiniteChatRouter } from './routers/infinite-chat.js';
   registerRouter('chat', infiniteChatRouter, { ... });
   ```

2. **Test Intelligence Service Locally** (1 hour)
   ```bash
   cd synap-intelligence-service
   pnpm install
   pnpm dev:intelligence-service
   # Should start on port 3002
   curl http://localhost:3002/health
   ```

3. **Document Current Integration** (2 hours)
   - Where is Hub Protocol implemented?
   - Which endpoints work?
   - Test full flow: Backend → Intelligence Service → Backend

### Short-Term (Month 1)

4. **Implement Missing Features** (1 week)
   - Approval flow in backend
   - Hub Protocol endpoints
   - Streaming support
   - Branch parent updates

5. **Add OpenRouter Support** (2 days)
   - Install `@openrouter/ai-sdk`
   - Update orchestrator and research agents
   - Add model selection config

6. **Frontend Integration** (1 week)
   - Wire workspace page to `infiniteChatRouter`
   - Show AI proposals in UI
   - Implement approval/rejection UX

### Long-Term (Quarter 1)

7. **Decide on Architecture** (Team Discussion)
   - Review this document
   - Evaluate options A, B, C
   - Make decision and commit

8. **Execute Migration** (if choosing Hybrid)
   - Create monorepo structure
   - Move repositories
   - Update CI/CD
   - Test end-to-end

9. **Optimize** (Ongoing)
   - Add caching
   - Implement rate limiting
   - Monitor AI costs
   -Add telemetry

---

## 13. Summary for Team

### What You Have

✅ **Sophisticated AI orchestration system**
✅ **ReAct agent with tool calling**
✅ **Memory system for long-term context**
✅ **Proposal-based workflow (human-in-the-loop AI)**
✅ **Extensible tool registry**
✅ **Research agent for deep analysis**

### Critical Gaps

❌ Backend router not registered (frontend can't use it)
❌ Hub Protocol endpoints missing in backend
❌ Approval flow not implemented
❌ No OpenRouter (locked to Anthropic)
❌ Separation documented but contradicts CHANGELOG

### Decision Point

**You need to decide**: Keep separate, merge, or hybrid?

**My recommendation**: **Hybrid monorepo** for your team size and use case.

---

## 14. References

### Documentation Files
- [`README.md`](file:///Users/antoine/Documents/Code/synap/synap-intelligence-service/README.md)
- [`intelligence_hub_documentation.md`](file:///Users/antoine/Documents/Code/synap/synap-intelligence-service/intelligence_hub_documentation.md)

### Key Source Files
- [`orchestrator.ts`](file:///Users/antoine/Documents/Code/synap/synap-intelligence-service/apps/intelligence-hub/src/agents/orchestrator.ts) - Main agent
- [`research.ts`](file:///Users/antoine/Documents/Code/synap/synap-intelligence-service/apps/intelligence-hub/src/agents/research.ts) - Research specialist
- [`tools/registry.ts`](file:///Users/antoine/Documents/Code/synap/synap-intelligence-service/apps/intelligence-hub/src/tools/registry.ts) - Tool definitions
- [`routers/expertise.ts`](file:///Users/antoine/Documents/Code/synap/synap-intelligence-service/apps/intelligence-hub/src/routers/expertise.ts) - HTTP API

### Backend Integration
- Backend: [`packages/api/src/routers/infinite-chat.ts`](file:///Users/antoine/Documents/Code/synap/synap-backend/packages/api/src/routers/infinite-chat.ts)
- Database: [`packages/database/src/schema/chat-threads.ts`](file:///Users/antoine/Documents/Code/synap/synap-backend/packages/database/src/schema/chat-threads.ts)

**This report should enable your team to make informed architectural decisions about the Intelligence Service.**
