# Frontend Intelligence Integration Guide

> **Audience:** Developer implementing the AI chat + intelligence layer in `synap-app`.
> **Goal:** Expose every capability the Intelligence Hub provides — matching what the CLI already does.
> **CLI reference:** `/opt/intelligence-hub/apps/cli/src/` — the ground-truth working client.
> **Last updated:** 2026-02-19

---

## 1. Architecture Overview

```
Browser
  │
  ├─ tRPC (via React Query)               → backend:4000
  │   ├─ infiniteChatRouter               → chat, threads, branches
  │   ├─ hub-protocol tRPC routers        → context, entities, docs, search, proposals, skills, branches
  │   └─ Hono REST adapter                → /api/hub/*
  │
  ├─ Socket.IO /presence namespace        → realtime:4001  (auto-bridged from backend)
  │   └─ room: workspace:{workspaceId}
  │       events: chat:stream, ai:step, ai:proposal, chat:message,
  │               thread:created/updated/archived, chat:stream:error, branch_decision (TODO - see §12)
  │
  └─ REST fetch                           → backend:4000/api/hub/*
      └─ Requires: Authorization: Bearer {HUB_PROTOCOL_API_KEY}
```

The backend **never sends raw SSE to the browser**. It:

1. Receives tRPC `sendMessage` → internally streams hub SSE
2. Bridges each event to Socket.IO → browser receives in real-time
3. Returns final `{ content, aiSteps, proposedActions, branchDecision }` when mutation resolves

> **Direct hub chat** (CLI-style SSE): `POST ${BACKEND_URL}/intelligence/api/chat/stream` with `X-API-Key` header. The CLI uses this path. The frontend should prefer tRPC + Socket.IO for better React integration.

---

## 2. Real-Time: Socket.IO Events

Connect to `/presence` namespace, join room `workspace:{workspaceId}` after auth:

```typescript
import { io } from "socket.io-client";
const socket = io(BACKEND_URL, { path: "/socket.io", namespace: "/presence" });
socket.on("connect", () => socket.emit("join-workspace", { workspaceId }));
```

### Complete event reference

| Event               | Payload shape                                                   | When emitted                  |
| ------------------- | --------------------------------------------------------------- | ----------------------------- |
| `chat:stream`       | `{ threadId, type: "chunk"\|"complete", content?, isComplete }` | Each streamed token           |
| `ai:step`           | `{ threadId, messageId, step: AIStep }`                         | Each reasoning / tool step    |
| `ai:proposal`       | `{ threadId, messageId, proposal: ProposedAction }`             | Tool needs user approval      |
| `branch_decision`   | `{ threadId, decision: BranchDecision }`                        | Sub-agent spawned (⚠ see §12) |
| `chat:message`      | `{ threadId, message, userId }`                                 | Full message persisted to DB  |
| `thread:created`    | `{ threadId, userId }`                                          | New thread or branch created  |
| `thread:updated`    | `{ threadId, userId }`                                          | Thread title/agent changed    |
| `thread:archived`   | `{ threadId, userId }`                                          | Thread soft-deleted           |
| `chat:stream:error` | `{ threadId, error, fallback }`                                 | Stream failure                |

### Core types

```typescript
interface AIStep {
  id: string;
  type: "thinking" | "tool_call" | "tool_result" | "decision" | "error";
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  status?: "pending" | "running" | "complete" | "error";
  timestamp: string;
  duration?: number;
  title?: string;
  description?: string;
}

interface ProposedAction {
  id: string;
  toolName: string;
  description: string;
  args: unknown;
}

interface BranchDecision {
  shouldBranch: boolean;
  reason: string;
  suggestedAgentType?: string;
  suggestedTitle?: string;
  suggestedPurpose?: string;
}
```

---

## 3. tRPC — infiniteChatRouter

All procedures on the `infiniteChat` router (mounted at backend:4000).

### Thread Management

| Procedure               | Type     | Key inputs                                                                   | Returns                                                  |
| ----------------------- | -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `createThread`          | mutation | `parentThreadId?, branchPurpose?, agentType?, agentConfig?, inheritContext?` | `{ threadId }`                                           |
| `getThread`             | query    | `threadId, includeContext?, includeBranches?`                                | `{ thread, entities?, documents?, branchTree? }`         |
| `listThreads`           | query    | `workspaceId?, threadType?, limit?`                                          | `{ threads }`                                            |
| `getBranches`           | query    | `parentThreadId`                                                             | `{ branches }`                                           |
| `getBranchTree`         | query    | `rootThreadId`                                                               | `{ tree, flatBranches, activeBranches, mergedBranches }` |
| `updateThread`          | mutation | `threadId, title?, agentType?`                                               | `{ status }`                                             |
| `archiveThread`         | mutation | `threadId`                                                                   | `{ status }`                                             |
| `mergeBranch`           | mutation | `branchId, summary?`                                                         | `{ status }`                                             |
| `createDocumentComment` | mutation | `documentId, position: {start,end}, content`                                 | `{ threadId, messageId }`                                |

### Messages

| Procedure          | Type     | Key inputs                         | Returns                                                               |
| ------------------ | -------- | ---------------------------------- | --------------------------------------------------------------------- |
| `sendMessage`      | mutation | `threadId?, content, workspaceId?` | `{ threadId, messageId, content, entities, branchDecision, aiSteps }` |
| `getMessages`      | query    | `threadId, cursor?, limit?`        | `{ messages, nextCursor, hasMore }`                                   |
| `getThreadContext` | query    | `threadId, relationshipTypes?`     | `{ entities, documents }`                                             |

---

## 4. tRPC — Hub Protocol Routers

Accessed via `trpc.hubProtocol.*` or REST (`/api/hub/*`).

### Context

```
getThreadContext(threadId)          → { contextSummary, metadata, messages, linkedEntities, linkedDocs }
getUserContext(userId)              → { recentEntities, recentThreads, preferences }
updateThreadContext(threadId, body) → { success }  body: { contextSummary?, personalityFingerprint? }
```

### Entities

```
getEntities(userId, workspaceId?, type?, limit?)          → Entity[]
createEntity(userId, type, title, description?)            → { id }
updateEntity(entityId, userId, title?, preview?, metadata?) → { success }
```

### Documents

```
getDocument(documentId, userId)                            → { document }
createDocument(userId, title, content?, type?)             → { id }
createDocumentProposal(documentId, userId, changes, proposedContent, originalContent?) → { proposalId }
```

### Search

```
search(userId, query, workspaceId?, collections?, limit?)     → unified results
searchCollection(userId, collection, query)                    → collection results
  collection: "entities"|"documents"|"views"|"projects"|"chat_threads"|"agents"
searchDocuments(userId, query, type?, limit?)                 → document metadata[]
vectorSearch(userId, query, types?, limit?)                   → semantic results with scores
```

### Proposals

```
listProposals(userId, workspaceId?, targetType?, status?, limit?) → Proposal[]
  status: "pending"|"approved"|"rejected"|"all"
updateProposal(proposalId, data, summary?)                        → { success }
approveProposal(proposalId, userId)                               → { success }
denyProposal(proposalId, userId)                                  → { success }
```

### Skills

```
getSkills(userId, workspaceId?, status?)   → Skill[]
getSkill(userId, skillId)                  → Skill
createSkill(userId, name, code, params?)   → { id }
```

### Branches

```
createBranch(userId, parentThreadId, branchPurpose, agentType?, agentConfig?, inheritContext?) → { branchId }
mergeBranch(userId, branchId, summary?)   → { status }
```

### Linking (fast-path, no event pipeline)

```
linkEntity(userId, threadId, entityId, relationshipType?)   → { success }
linkDocument(userId, threadId, documentId, relationshipType?) → { success }
```

### Background Tasks

```
getBackgroundTasks(userId, workspaceId?, status?, type?)   → Task[]
getBackgroundTask(userId, taskId)                           → Task
```

---

## 5. Hub REST Endpoints (`/api/hub/*`)

> Requires `Authorization: Bearer {HUB_PROTOCOL_API_KEY}` on all routes.

```
GET  /health                                            → { status, service }

# Threads
GET  /threads?userId=&workspaceId=                      → Thread[] (with parentThreadId for tree)
GET  /threads/:threadId/context                         → { contextSummary, metadata, messages }
PATCH /threads/:threadId/context                        → { success }
POST /threads                                           → { id, title }
GET  /threads/:threadId/messages                        → Message[]
POST /threads/:threadId/messages                        → { success }  (inject system/assistant msg)
POST /threads/:threadId/link-entity                     → { success }
POST /threads/:threadId/link-document                   → { success }

# Entities
GET  /users/:userId/entities?type=&workspaceId=&limit=  → Entity[]
POST /entities                                          → { id }
PATCH /entities/:entityId                               → { success }

# Documents
GET  /documents/:documentId?userId=                     → { document }
POST /documents                                         → { id }
POST /documents/proposals                               → { proposalId }

# Proposals
GET  /proposals?userId=&workspaceId=&status=            → Proposal[]
PATCH /proposals/:id                                    → { success }

# Search
GET  /search?userId=&query=&workspaceId=&collections=   → unified results
GET  /search/collection?userId=&collection=&query=      → collection results
GET  /search/documents?userId=&query=&type=&limit=      → Document[]
GET  /vector-search?userId=&query=&types=&limit=        → semantic results

# Memory / Knowledge Facts
POST /memory                                            → stored fact
GET  /memory?userId=&query=&limit=                      → KnowledgeFact[] (keyword)
POST /memory/search                                     → KnowledgeFact[] (semantic/cosine)
DELETE /memory/:id?userId=                              → { success }

# Entity Graph
GET  /graph/traverse?userId=&startEntityId=&maxDepth=&relationshipTypes= → traversal results

# Skills
GET  /skills/getSkills?userId=&workspaceId=             → Skill[]
GET  /skills/getSkill?userId=&skillId=                  → Skill
POST /skills/createSkill                                → { id }

# Commands (workspace prompt templates)
GET  /commands?workspaceId=                             → IntelligenceCommand[]
GET  /commands/:id                                      → IntelligenceCommand
```

---

## 6. Intelligence Hub Internal Routes (via `/intelligence/*` Caddy prefix)

> CLI connects here directly. Frontend may call these for agent/tool management UI.
> Base: `${BACKEND_URL}/intelligence/api`

```
# Chat (SSE — CLI uses this, frontend should prefer tRPC)
POST /chat/stream                   → SSE stream of SseEvent[]

# Agent definitions (for Settings / Admin)
GET  /agent-definitions             → AgentDefinition[]
GET  /agent-definitions/:agentType  → AgentDefinition
PATCH /agent-definitions/:agentType → AgentDefinition  (label, systemPrompt, toolNames, maxSteps)

# Tool definitions
GET  /tool-definitions              → ToolDefinition[]
GET  /tool-definitions/:toolName    → ToolDefinition
PATCH /tool-definitions/:toolName   → ToolDefinition   (label, category, autoExec, isActive)

# Per-user agent config overrides
GET  /agent-configs/:userId         → AgentConfig[]
GET  /agent-configs/:userId/:type   → AgentConfig
PUT  /agent-configs/:userId/:type   → AgentConfig  (promptAppend, extraToolIds, disabledToolIds, modelOverride)
DELETE /agent-configs/:userId/:type → { success }

# Execution logs
GET  /executions?userId=&agentType=&limit=&offset=  → ExecutionLog[]
GET  /executions/stats?since=                        → ExecutionStats
GET  /executions/:id                                 → { execution, toolLogs }

# Error logs
GET  /errors?source=&severity=&limit=&offset=        → ErrorLog[]
GET  /errors/stats?since=                            → ErrorStats
```

---

## 7. Agent Types & Tool Access

```typescript
const AGENTS = {
  default: {
    label: "General purpose",
    tools: [
      "search_unified",
      "search_entities",
      "search_documents",
      "vector_search",
      "memory_search",
    ],
  },
  meta: {
    label: "Strategic orchestrator",
    tools: ["...all...", "dispatch_agent", "create_branch", "update_proposal"],
  },
  code: {
    label: "Code generation",
    tools: [
      "search_unified",
      "search_documents",
      "get_document",
      "create_document",
      "update_document",
    ],
  },
  writing: {
    label: "Writing & editing",
    tools: [
      "search_unified",
      "search_documents",
      "get_document",
      "create_document",
      "update_document",
    ],
  },
  "knowledge-search": {
    label: "Knowledge synthesis",
    tools: [
      "search_unified",
      "vector_search",
      "search_documents",
      "search_entities",
      "get_document",
      "memory_search",
      "remember_fact",
      "graph_traverse",
    ],
  },
  action: {
    label: "CRUD operations",
    tools: [
      "search_unified",
      "search_entities",
      "vector_search",
      "create_entity",
      "update_entity",
    ],
  },
  prompting: {
    label: "Prompt specialist",
    tools: [
      "search_unified",
      "vector_search",
      "search_entities",
      "search_documents",
      "get_document",
    ],
  },
} as const;
```

### All tools (for Settings / tool toggle UI)

| Tool                      | Category     | Auto-exec | Description                          |
| ------------------------- | ------------ | --------- | ------------------------------------ |
| `search_unified`          | context      | ✓         | Unified Typesense search (primary)   |
| `search_entities`         | context      | ✓         | Entity database search               |
| `search_documents`        | context      | ✓         | Document keyword search              |
| `vector_search`           | context      | ✓         | Semantic embedding search            |
| `get_document`            | context      | ✓         | Fetch full document by ID            |
| `memory_search`           | context      | ✓         | Long-term memory / knowledge facts   |
| `graph_traverse`          | context      | ✓         | Entity relation graph BFS            |
| `create_entity`           | action       | ✗         | Create entity (needs approval)       |
| `update_entity`           | action       | ✗         | Update entity (needs approval)       |
| `create_document`         | action       | ✗         | Create document                      |
| `update_document`         | action       | ✗         | Update document                      |
| `create_skill`            | action       | ✗         | Create user-defined skill            |
| `link_entity_to_thread`   | action       | ✗         | Link entity to thread sidebar        |
| `link_document_to_thread` | action       | ✗         | Link document to thread sidebar      |
| `remember_fact`           | action       | ✗         | Persist fact to long-term memory     |
| `update_proposal`         | action       | ✗         | AI self-revision of pending proposal |
| `dispatch_agent`          | action       | ✗         | Delegate to specialist sub-agent     |
| `create_branch`           | coordination | ✗         | Create conversation branch           |

---

## 8. Workspace Commands (Raycast-style prompt templates)

```typescript
interface IntelligenceCommand {
  id: string;
  workspaceId: string;
  title: string;
  promptTemplate: string; // {argument name="X" options="[a,b]"} and {selection} placeholders
  derivedInputs: DerivedInput[]; // pre-parsed for form generation
  outputMode: "text" | "proposal" | "view";
  permissionsProfile: "read_only" | "propose_writes";
  sharedScope: "workspace" | "user";
  allowedTools?: string[];
  maxEntitiesCreatedPerRun?: number;
  canCreateViews?: boolean;
}

interface DerivedInput {
  name: string;
  label?: string;
  type?: string;
  options?: string[];
  default?: string;
}
```

Template compiler (matches CLI `src/utils/template.ts`):

```typescript
function compileTemplate(
  template: string,
  values: Record<string, string>,
  selection = ""
): string {
  return template
    .replace(/\{argument\s+([^}]+)\}/g, (_, attrs) => {
      const name = attrs.match(/name="([^"]+)"/)?.[1] ?? "";
      const def = attrs.match(/default="([^"]+)"/)?.[1] ?? "";
      return values[name] ?? def ?? `[${name}]`;
    })
    .replace(/\{selection\}/g, selection || "[selection]")
    .trim();
}
```

---

## 9. Thread Branch Tree (git-like view)

The backend already stores `parentThreadId`, `agentType`, `branchPurpose` on every thread.

### Build tree client-side

```typescript
interface BranchNode {
  id: string;
  threadId: string;
  parentId?: string;
  children: BranchNode[];
  depth: number;
  agentType: string;
  status: "active" | "complete" | "merged" | "error";
  title?: string;
  branchPurpose?: string;
  createdAt: string;
  mergedAt?: string;
}

function buildBranchTree(threads: Thread[]): BranchNode[] {
  const map = new Map<string, BranchNode>();
  const roots: BranchNode[] = [];

  threads.forEach((t) =>
    map.set(t.id, {
      id: t.id,
      threadId: t.id,
      parentId: t.parentThreadId ?? undefined,
      children: [],
      depth: 0,
      agentType: t.agentType ?? "default",
      status: t.mergedAt ? "merged" : "active",
      title: t.title,
      branchPurpose: t.branchPurpose,
      createdAt: t.createdAt,
      mergedAt: t.mergedAt,
    })
  );

  threads.forEach((t) => {
    const node = map.get(t.id)!;
    if (t.parentThreadId && map.has(t.parentThreadId)) {
      const parent = map.get(t.parentThreadId)!;
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}
```

### Render with @xyflow/react

```typescript
// Convert tree to ReactFlow nodes/edges
function treeToFlow(nodes: BranchNode[]): { nodes: Node[]; edges: Edge[] } {
  const flowNodes: Node[] = [];
  const flowEdges: Edge[] = [];

  function walk(node: BranchNode, x: number, y: number) {
    flowNodes.push({
      id: node.threadId,
      position: { x: x * 220, y: node.depth * 120 },
      data: { label: node.title ?? node.branchPurpose ?? node.agentType, node },
      type: "threadNode", // custom node type
    });
    node.children.forEach((child, i) => {
      flowEdges.push({
        id: `${node.threadId}-${child.threadId}`,
        source: node.threadId,
        target: child.threadId,
        label: child.branchPurpose?.slice(0, 30),
        animated: child.status === "active",
        style: { stroke: child.status === "merged" ? "#4ade80" : "#60a5fa" },
      });
      walk(child, x + i, node.depth + 1);
    });
  }
  nodes.forEach((root, i) => walk(root, i, 0));
  return { nodes: flowNodes, edges: flowEdges };
}
```

---

## 10. Entity Graph View

```typescript
// Fetch entity neighbors
const traverse = await fetch(
  `/api/hub/graph/traverse?userId=${userId}&startEntityId=${entityId}&maxDepth=2`,
  { headers: { Authorization: `Bearer ${apiKey}` } }
).then((r) => r.json());

// traverse: Array<{ entityId, depth, relationshipType, direction, path }>

// Convert to ReactFlow
function graphToFlow(
  startId: string,
  results: TraversalResult[]
): { nodes: Node[]; edges: Edge[] } {
  const nodes = [
    { id: startId, data: { label: "Start" }, position: { x: 0, y: 0 } },
  ];
  const edges = results.map((r) => ({
    id: `${r.path[r.path.length - 2]}-${r.entityId}`,
    source: r.path[r.path.length - 2],
    target: r.entityId,
    label: r.relationshipType,
    markerEnd:
      r.direction === "outbound" ? { type: MarkerType.Arrow } : undefined,
  }));
  return { nodes, edges };
}
```

---

## 11. AI-to-AI Channels

When the `meta` or `dispatch_agent` tool creates a sub-agent thread, it:

1. Creates a child thread (`parentThreadId` = current thread)
2. Runs the sub-agent in that thread
3. Posts the result back as a `system` role message via `POST /threads/:parentId/messages`

This creates a visible "inter-agent message trail". To display it:

```typescript
// Fetch all system messages injected by sub-agents in this thread
const messages = await trpc.infiniteChat.getMessages.query({ threadId });
const interAgentMessages = messages.filter(
  (m) => m.role === "system" && m.content.startsWith("[Sub-agent:")
);

// A "channel inbox" view: per-thread list of sub-agent results
const childResults = interAgentMessages.map((m) => ({
  agentType: m.content.match(/\[Sub-agent: (\w+)\]/)?.[1],
  content: m.content.replace(/^\[Sub-agent: [^\]]+\] /, ""),
  createdAt: m.createdAt,
}));
```

---

## 12. Memory / Knowledge Facts

```typescript
// List all facts for a user
const facts = await fetch(`/api/hub/memory?userId=${userId}`, { headers }).then(r => r.json());

// Keyword search
const results = await fetch(`/api/hub/memory?userId=${userId}&query=project+alpha`, { headers }).then(r => r.json());

// Semantic search (send embedding from hub)
const results = await fetch("/api/hub/memory/search", {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ userId, embedding: [...], limit: 10 }),
}).then(r => r.json());

// Store a fact
await fetch("/api/hub/memory", {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ userId, fact: "User prefers TypeScript", confidence: 0.9, embedding: [...] }),
});
```

---

## 13. Execution Timeline (Agent Activity)

```typescript
// Fetch recent executions for a workspace/user
const { executions } = await fetch(
  `/intelligence/api/executions?userId=${userId}&limit=20`,
  { headers: { "X-API-Key": apiKey } }
).then((r) => r.json());

// Execution shape
interface ExecutionLog {
  id: string;
  agentType: string;
  userId: string;
  status: "success" | "error" | "running";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  toolCallCount?: number;
  stepCount?: number;
  threadId?: string;
}

// Stats for dashboard
const { stats } = await fetch(
  "/intelligence/api/executions/stats?since=2026-02-18T00:00:00Z",
  { headers }
).then((r) => r.json());
```

---

## 14. Complete UI Feature Map (What to Build)

### Hooks / State

| File                           | Purpose                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `hooks/useSocket.ts`           | Socket.IO singleton, workspace room join, typed event emitter                         |
| `store/chatStore.ts`           | Per-thread `ChatUIState` { isStreaming, content, aiSteps, proposals, branchDecision } |
| `hooks/useChat.ts`             | `sendMessage()` → tRPC mutation + socket subscription                                 |
| `hooks/useStreamingMessage.ts` | Accumulate `chat:stream` chunks + `ai:step` events                                    |
| `hooks/useProposals.ts`        | Subscribe to `ai:proposal`, expose `approve/deny`                                     |
| `hooks/useBranchTree.ts`       | `getBranchTree` tRPC + `buildBranchTree()`                                            |
| `hooks/useEntityGraph.ts`      | `/graph/traverse` + build ReactFlow nodes/edges                                       |
| `hooks/useMemory.ts`           | `listMemory` + `searchMemory` (keyword + semantic)                                    |
| `hooks/useThreadContext.ts`    | Thread's linked entities + documents                                                  |

### Chat UI Components

| Component          | Purpose                                                   |
| ------------------ | --------------------------------------------------------- |
| `ChatPane`         | Full thread view: messages + stream + input + sidebar     |
| `MessageList`      | Scrollable history with react-markdown + shiki            |
| `StreamingMessage` | Live token accumulator with cursor                        |
| `ThinkingSteps`    | Collapsible tool call timeline (type-aware icons)         |
| `ProposalCard`     | Inline approve/deny with args preview                     |
| `BranchCard`       | Sub-agent branch info → link to child thread              |
| `AgentSelector`    | Dropdown to switch agent type mid-conversation            |
| `CommandPalette`   | `/command` picker with workspace commands + template form |
| `ContextSidebar`   | Linked entities + documents panel beside chat             |

### Navigation & Graph Views

| Component           | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| `ThreadBranchTree`  | Git-like thread graph using `@xyflow/react`            |
| `EntityGraph`       | Interactive entity relation graph (`@xyflow/react`)    |
| `AIChannelInbox`    | Cross-thread sub-agent messages timeline               |
| `ExecutionTimeline` | Chronological AI activity (steps, tools, errors)       |
| `KnowledgeTimeline` | Memory facts + entity creation over time               |
| `MemoryBrowser`     | Search + browse knowledge facts                        |
| `CommandRunner`     | Raycast-style command palette → argument form → stream |

### Settings & Admin UI

| Component          | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `AgentConfigPanel` | Per-user agent overrides (systemPrompt, tools, model)            |
| `ToolToggleGrid`   | Enable/disable tools per agent type                              |
| `SkillManager`     | List + install skills (matches `synap skills` / `synap install`) |

---

## 15. Implementation Phases

### Phase 1 — Real-time chat plumbing

1. `useSocket.ts` + `store/chatStore.ts`
2. `useStreamingMessage.ts` + `ChatPane` + `MessageList` + `StreamingMessage`
3. `ThinkingSteps` with type-aware icons (tool_call / tool_result / thinking / decision)
4. Wire `sendMessage` tRPC mutation → streaming chunks appear

### Phase 2 — Proposals + branching

5. `ProposalCard` + `useProposals.ts`
6. `BranchCard` (active + completed states)
7. `AgentSelector` dropdown

### Phase 3 — Commands + context

8. `CommandPalette` + `CommandRunner` with workspace commands + template form
9. `ContextSidebar` (linked entities + documents per thread)
10. `useMemory.ts` + `MemoryBrowser`

### Phase 4 — Graph views

11. `useBranchTree.ts` + `ThreadBranchTree` (ReactFlow)
12. `useEntityGraph.ts` + `EntityGraph` (ReactFlow)
13. `AIChannelInbox` (sub-agent cross-thread messages)

### Phase 5 — Timeline + Admin

14. `ExecutionTimeline` (agent activity feed)
15. `KnowledgeTimeline` (memory + entity creation)
16. `AgentConfigPanel` + `ToolToggleGrid`
17. `SkillManager`

---

## 16. Dependencies to Add

```json
{
  "socket.io-client": "^4.7.0",
  "zustand": "^4.5.0",
  "immer": "^10.0.0",
  "react-markdown": "^9.0.0",
  "remark-gfm": "^4.0.0",
  "shiki": "^1.0.0",
  "@xyflow/react": "^12.0.0"
}
```

---

## 17. Known Backend Gaps to Fix Before Phase 2+

| #   | Gap                                                         | Where                        | Fix needed                                                                         |
| --- | ----------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| 1   | `branch_decision` not Socket.IO-broadcast                   | `infinite-chat.ts` ~line 362 | Add `emitChatEvent("branch_decision", { threadId, decision })`                     |
| 2   | Stream errors not Socket.IO-broadcast                       | `infinite-chat.ts`           | Add `emitChatEvent("chat:stream:error", { threadId, error })` on `error` SSE event |
| 3   | `approveProposal` / `denyProposal` missing from tRPC        | `proposals.ts` router        | Add two mutations wrapping existing REST handler                                   |
| 4   | Thread `parentThreadId` missing from `getMessages` response | `infinite-chat.ts`           | Include `parentThreadId` in `listThreads` output                                   |
| 5   | No `GET /api/hub/threads` list endpoint                     | `hub-protocol-rest.ts`       | Add endpoint (needed for thread tree without tRPC)                                 |

---

_CLI source reference: `/opt/intelligence-hub/apps/cli/src/`_
_Monitor app reference: `/opt/intelligence-hub/apps/monitor/src/`_
