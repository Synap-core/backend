# Session-Scoped AI Memory System

**Status:** Implemented, awaiting frontend integration
**Feature flag:** `SESSION_SCOPED_MEMORY=true`
**Date:** 2026-03-05

---

## Overview

The session-scoped memory system replaces the previous **online context compression** approach (which made an LLM call on every single request) with an **offline compaction** model:

- **Before**: Every user message → LLM call to compress thread history → inject into prompt → LLM call for actual response. Two LLM calls per message, 2–5s added latency.
- **After**: Session ends → compaction runs in background → next session reads a deterministic snapshot → inject into prompt. One LLM call per message, ~50ms overhead.

The new system introduces two first-class concepts: **Sessions** and **Compacted States**.

---

## Core Concepts

### Session

A bounded period of interaction within a channel. A new session starts when:

- There is no active session for the channel, OR
- The last message in the active session was more than 30 minutes ago (configurable via `SESSION_TIMEOUT_MINUTES` env)

Sessions group messages so the compaction engine knows exactly which messages are new vs. already processed.

**Lifecycle:** `active` → `compacting` → `closed`

### Compacted State

A structured snapshot of everything the AI needs to know at the start of a new session. Five memory blocks, each with its own token budget:

| Block                | Budget     | Content                                                                    |
| -------------------- | ---------- | -------------------------------------------------------------------------- |
| `identityBlock`      | 400 tokens | AI persona, communication style, user-defined preferences                  |
| `userModelBlock`     | 600 tokens | What the AI knows about the user: preferences, projects, expertise         |
| `continuityBlock`    | 800 tokens | Narrative history with recency gradient (recent = detail, old = key facts) |
| `activeGoalsBlock`   | 400 tokens | Current goals, tasks, open requests, pending follow-ups                    |
| `entityContextBlock` | 800 tokens | Key entities recently interacted with and their context                    |

**Total: ~3,000 tokens** — approximately 2% of a 200K context window.

### The Parallel Compaction Trick (Zero Latency)

When a session times out and a new one starts:

1. Old session compaction is **triggered in the background** (no await)
2. Message 1 of the new session uses the **previous** compacted state (already available)
3. The new compaction completes before message 2 arrives

The user never waits for compaction. It's invisible.

---

## Architecture

```
User sends message
       │
       ▼
assembleContext()  ──[SESSION_SCOPED_MEMORY=true]──▶  assembleContextSessionScoped()
       │                                                        │
       │                                               startOrContinueSession()
       │                                                        │
       │                               ┌────────────────────────┴────────────────────────┐
       │                               │ Active session (< 30min)?                        │
       │                               │   YES → assembleBootstrap() (DB read, no LLM)    │
       │                               │   NO  → triggerBackgroundCompaction() (async)    │
       │                               │          assembleBootstrap() from prev state      │
       │                               └─────────────────────────────────────────────────┘
       │                                        │
       │                               bootstrapPrompt (deterministic string)
       │                                        │
       ▼                                        ▼
ReAct loop  ◀─────────────────  systemPromptAdditions injected
       │
       ▼
Response complete → recordSessionUsage() [fire-and-forget]
                    → triggers mid-session compaction if > 80k tokens used
```

### Legacy Path (default, `SESSION_SCOPED_MEMORY=false`)

The old `compressContext()` path is preserved unchanged. The feature flag gates which path runs inside `assembleContext()`. Zero risk to existing behavior.

---

## Database Schema

### `sessions` table

```sql
CREATE TABLE sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id          UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'active',  -- active | compacting | closed
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,
  bootstrap_state_id  UUID,  -- FK to compacted_states (set after table created)
  produced_state_id   UUID,  -- FK to compacted_states (set after compaction)
  total_tokens_used   INTEGER NOT NULL DEFAULT 0,
  message_count       INTEGER NOT NULL DEFAULT 0,
  compaction_count    INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_channel_id_idx ON sessions(channel_id);
CREATE INDEX sessions_status_idx ON sessions(status);
```

### `compacted_states` table

```sql
CREATE TABLE compacted_states (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id            UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id            UUID REFERENCES sessions(id) ON DELETE SET NULL,
  version               INTEGER NOT NULL DEFAULT 1,

  -- Five memory blocks
  identity_block        TEXT NOT NULL DEFAULT '',
  user_model_block      TEXT NOT NULL DEFAULT '',
  continuity_block      TEXT NOT NULL DEFAULT '',
  active_goals_block    TEXT NOT NULL DEFAULT '',
  entity_context_block  TEXT NOT NULL DEFAULT '',

  -- Compression metrics
  raw_token_count       INTEGER,
  compressed_token_count INTEGER,

  -- Operational
  compaction_model      TEXT,
  metadata              JSONB,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (channel_id, version)
);
```

### Modified existing tables

- **`messages`**: Added `session_id UUID REFERENCES sessions(id) ON DELETE SET NULL` — links each message to the session it was sent in
- **`channel_context_items`**: Added `relevance_score REAL` — set during compaction to rank entity importance
- **`channels`**: Added `result_summary TEXT` (branch result on completion) and `merged_into_state_id UUID` (for branch merges)

**Migration:** `synap-backend/packages/database/migrations-custom/0047_session_scoped_memory.sql`

---

## Hub Protocol API (backend → intelligence service boundary)

The intelligence hub talks to the data pod via Hub Protocol. New endpoints were added to both the tRPC router and the REST adapter.

### Session endpoints

| Method  | Path                                           | Description                                   |
| ------- | ---------------------------------------------- | --------------------------------------------- |
| `POST`  | `/api/hub-protocol/sessions/getOrCreate`       | Get active session or create new one          |
| `GET`   | `/api/hub-protocol/sessions/active?channelId=` | Get active session for channel (null if none) |
| `GET`   | `/api/hub-protocol/sessions/:sessionId`        | Get specific session                          |
| `GET`   | `/api/hub-protocol/sessions?channelId=`        | List sessions for channel                     |
| `PATCH` | `/api/hub-protocol/sessions/:sessionId`        | Update session (status, token count, etc.)    |
| `POST`  | `/api/hub-protocol/sessions/:sessionId/close`  | Close session, optionally link produced state |

### Compacted state endpoints

| Method | Path                                                   | Description                                           |
| ------ | ------------------------------------------------------ | ----------------------------------------------------- |
| `POST` | `/api/hub-protocol/compacted-states`                   | Create new compacted state (version auto-incremented) |
| `GET`  | `/api/hub-protocol/compacted-states/latest?channelId=` | Get latest state for channel (bootstrap path)         |
| `GET`  | `/api/hub-protocol/compacted-states/:stateId`          | Get specific state by ID                              |
| `GET`  | `/api/hub-protocol/compacted-states?channelId=`        | List states (metadata only, no block content)         |

All endpoints require the hub-protocol API key with `hub-protocol.read` or `hub-protocol.write` scope.

**tRPC routers:**

- `synap-backend/packages/api/src/routers/hub-protocol/sessions.ts`
- `synap-backend/packages/api/src/routers/hub-protocol/compacted-states.ts`

**REST adapter:** `synap-backend/packages/api/src/routers/hub-protocol-rest.ts`

**Intelligence hub client:** `synap-intelligence-service/apps/intelligence-hub/src/clients/hub-protocol.ts`

---

## Intelligence Service Layer

### `services/compaction-engine.ts`

Produces a `CompactionResult` from raw messages. All 5 blocks run in **parallel** via `Promise.all`. If a block fails, the previous block content is preserved (graceful degradation).

**Key API:**

```typescript
// Run compaction only (caller persists)
runCompaction(input: CompactionInput): Promise<CompactionResult>

// Run compaction + persist to data pod in one call
compactAndPersist(input: CompactionInput): Promise<{ id, version, compressedTokenCount }>
```

**Model selection:**

- Session-end compaction (async, offline): `claude-sonnet` — quality over speed
- Mid-session compaction (hot path): `claude-haiku` — speed over quality

### `services/bootstrap-assembler.ts`

Assembles the AI system prompt from a compacted state. **No LLM call** — pure string formatting.

```typescript
assembleBootstrap(params: {
  channelId: string;
  currentContext?: BootstrapContext;   // current page, device type
  activeBranches?: ActiveBranchSummary[];
}): Promise<AssembledBootstrap>
```

Returns a formatted string with sections in this order:

1. `## Your Identity` (identityBlock)
2. `## About the User` (userModelBlock)
3. `## Recent History` (continuityBlock)
4. `## Current Goals & Pending Tasks` (activeGoalsBlock)
5. `## Key Entities & Context` (entityContextBlock)
6. `## Active Branches` (freshly computed, not from state)
7. `## Current Session` (date, time, current page — always fresh)

First-ever session returns a minimal prompt: "This is your first interaction with this user in this channel. No prior conversation history exists."

### `services/session-manager.ts`

The orchestrator. Called once per agent invocation.

```typescript
// Main entry point — call before the ReAct loop
startOrContinueSession(params: {
  channelId: string;
  currentContext?: BootstrapContext;
  defaultAgentIdentity?: string;
}): Promise<SessionStartResult>

// Call after agent response (fire-and-forget)
recordSessionUsage(params: {
  sessionId: string;
  channelId: string;
  tokensUsed: number;
  currentTotalTokens: number;
}): Promise<void>
```

`SessionStartResult` carries:

- `sessionId` — for token tracking
- `bootstrapPrompt` — the formatted system prompt sections
- `isFirstSession` — true if no compacted state exists yet
- `isNewSession` — true if a new session was created (vs. continuing existing)

### `agents/utils/context-manager.ts`

The integration point. `assembleContext()` checks the feature flag and routes to the correct path:

```typescript
// Feature-flagged: session-scoped path when SESSION_SCOPED_MEMORY=true and threadId present
if (isSessionScopedMemoryEnabled() && threadId) {
  return assembleContextSessionScoped(userId, query, threadId, config);
}
// Legacy: compressContext() inline LLM call
```

`AssembledContext` now carries `sessionId?` — passed back to `agent.ts` for `recordSessionUsage()`.

### `agents/base/agent.ts`

Both `execute()` and `executeWithStream()` now call `recordSessionUsage()` after generation completes, guarded by `assembledContext?.sessionId`:

```typescript
if (assembledContext?.sessionId && usage?.totalTokens) {
  recordSessionUsage({
    sessionId,
    channelId,
    tokensUsed,
    currentTotalTokens,
  }).catch(() => {}); // fire-and-forget, never blocks response
}
```

---

## Configuration

| Environment variable          | Default | Description                                       |
| ----------------------------- | ------- | ------------------------------------------------- |
| `SESSION_SCOPED_MEMORY`       | `false` | Enable new session-scoped path                    |
| `SESSION_TIMEOUT_MINUTES`     | `30`    | Inactivity timeout before new session             |
| `MID_SESSION_TOKEN_THRESHOLD` | `80000` | Token threshold to trigger mid-session compaction |

---

## What's NOT Done Yet (Frontend)

The backend and intelligence service are complete. The frontend work still needed:

1. **Pass `currentContext` to `startOrContinueSession`**: The browser/web app knows the current page and device type. Wire `BootstrapContext` through `ChatStreamRequest` → agent context → session manager. This enriches the `## Current Session` block with real app context.

2. **Surface session info in the UI**: Optional — show users their current session continuity state, e.g. "Synap remembers your last 3 sessions in this channel."

3. **Branch merge → state update**: When a branch is merged back into its parent channel, `channels.mergedIntoStateId` and `channels.resultSummary` should be set. The compaction engine should then incorporate the branch's compacted state into the parent's next compaction. The schema columns exist; the trigger logic does not.

4. **Admin visibility**: A debug panel showing compacted state blocks and session history per channel. Useful for tuning and QA.

---

## File Map

```
synap-backend/
├── packages/database/src/schema/
│   ├── sessions.ts                          NEW — sessions table + SessionStatus enum
│   ├── compacted-states.ts                  NEW — compacted_states table
│   ├── messages.ts                          MODIFIED — added sessionId column
│   ├── channel-context-items.ts             MODIFIED — added relevanceScore column
│   ├── channels.ts                          MODIFIED — added resultSummary, mergedIntoStateId
│   └── index.ts                             MODIFIED — exports sessions + compacted-states
├── packages/database/migrations-custom/
│   └── 0047_session_scoped_memory.sql       NEW — full migration
└── packages/api/src/routers/hub-protocol/
    ├── sessions.ts                          NEW — tRPC sessions router
    ├── compacted-states.ts                  NEW — tRPC compacted-states router
    ├── index.ts                             MODIFIED — registers new routers
    └── hub-protocol-rest.ts                 MODIFIED — REST adapter endpoints

synap-intelligence-service/apps/intelligence-hub/src/
├── services/
│   ├── compaction-engine.ts                 NEW — 5-block parallel compaction
│   ├── bootstrap-assembler.ts               NEW — deterministic prompt assembly
│   ├── session-manager.ts                   NEW — session lifecycle orchestration
│   └── index.ts                             MODIFIED — barrel exports for new services
├── agents/
│   ├── utils/context-manager.ts             MODIFIED — session-scoped path + feature flag
│   └── base/agent.ts                        MODIFIED — recordSessionUsage wired in
└── clients/
    └── hub-protocol.ts                      MODIFIED — session + compacted-state client methods
```

---

## Frontend Work — Audit & Plan

### Current State (what exists today)

The frontend sends chat messages through this chain:

```
ChatView (ai-chat)
  → useSendMessage (channels)
    → trpc.chat.sendMessage (backend)
      → IntelligenceHubClient.sendMessageStream()
        → POST {hub}/api/chat/stream
          → assembleContext(userId, query, threadId, parentThreadId)
            → [legacy] compressContext()
            → [new]    startOrContinueSession({ channelId })
```

**`IntelligenceHubRequest`** (the payload sent backend → hub) currently carries:

```typescript
{
  query: string;
  threadId: string;
  userId: string;
  agentId?: string;
  agentType?: string;
  workspaceId?: string;
  sourceMessageId?: string;
  agentUserId?: string;
  dataPodUrl?: string;
  dataPodApiKey?: string;
  mcpServers?: McpServerConfig[];
  requestId?: string;
}
```

There is **no `currentContext` field** today. The `BootstrapContext` (current page, device type, visible entities) never reaches the intelligence hub. The `## Current Session` block in the bootstrap prompt only has date + time.

### What Needs to Be Added

#### 1. `currentContext` through the call chain

The `BootstrapContext` shape is already defined in `bootstrap-assembler.ts`:

```typescript
interface BootstrapContext {
  currentPage?: string; // e.g. "Entity: Acme Corp", "View: Pipeline"
  visibleEntityIds?: string[]; // IDs of entities in viewport
  deviceType?: "mobile" | "desktop";
}
```

**Three layers to update:**

**A. `IntelligenceHubRequest`** — add `currentContext?` field
(`synap-backend/packages/api/src/clients/intelligence-hub.ts`)

**B. tRPC `chat.sendMessage`** — accept `currentContext?` from the frontend and forward to hub
(`synap-backend/packages/api/src/routers/channels.ts` — the `sendMessage` procedure around line 660)

**C. `useSendMessage` + `ChatAppProps`** — the frontend hook and entry component

- `synap-app/packages/apps/chat/src/ChatApp.tsx` — add `currentPage?: string` and `device?: string` props
- `synap-app/packages/features/ai-chat/src/hooks/useSendMessage.ts` — forward to tRPC mutation

The frontend already has access to:

- `currentPage` — from the router / active app state (workspace page knows what's open)
- `visibleEntityIds` — theoretically from viewport intersection observers (not implemented)
- `deviceType` — `window.innerWidth < 768 ? 'mobile' : 'desktop'`

For V1, `visibleEntityIds` can be omitted (optional field). `currentPage` and `deviceType` are cheap and immediately available.

**D. Hub streaming endpoint** — forward `currentContext` from request body into `assembleContext()` call
(`synap-intelligence-service/apps/intelligence-hub/src/routes/` — the SSE stream handler)

Then in `context-manager.ts`:

```typescript
// assembleContextSessionScoped already accepts config but not context
// startOrContinueSession needs currentContext passed through
startOrContinueSession({ channelId, currentContext });
```

#### 2. `sessionId` tracking in messages

Today `messages.session_id` is set to `null` for all new messages because the backend doesn't know the session ID at insert time — that lives in the intelligence service.

Two options:

- **Option A (simple)**: Hub returns `sessionId` in the stream `complete` event → backend updates the assistant message after the fact
- **Option B (proper)**: Hub receives `sessionId` from `startOrContinueSession` and includes it in the stream response header/metadata → backend sets it on insert

Option A is one extra DB write. Option B requires a new field in the SSE protocol. **Option A is recommended for V1.**

#### 3. UI signals (optional, lower priority)

The session system creates an opportunity for UI improvements that weren't possible before:

- **"Synap remembers" indicator**: A subtle pill in the chat header — "Remembering since [date]" or "3 sessions of context" — based on `isFirstSession` and state version from `SessionStartResult`
- **Memory blocks inspector**: Debug/power-user panel showing the 5 blocks for the current channel's latest compacted state. Useful for users who want to understand what the AI knows about them.
- **Session boundary in message history**: A visual divider showing "New session — [date]" between messages from different sessions (using `message.sessionId` FK).

None of these are blocking for the initial feature launch. The core value (better context, less latency) is entirely backend/service-side.

### Implementation Order

```
1. Add currentContext to IntelligenceHubRequest type     (30 min)
2. Forward currentContext through chat.ts tRPC → hub     (30 min)
3. Pass currentContext into startOrContinueSession()     (20 min)
4. Collect currentPage + deviceType in useSendMessage    (45 min)
5. Enable SESSION_SCOPED_MEMORY=true in dev env          (env change)
6. Test: first session shows "first interaction" prompt  (manual)
7. Test: second session shows userModel + continuity     (manual)
8. Option A: return sessionId in complete event          (1 hr)
9. Backend: update message.session_id on complete        (1 hr)
```

Steps 1–5 are the minimum to make the new path live and useful. Steps 6–9 complete the data model.

### Exact File Locations (from audit)

| File                                                              | What to change                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| `synap-backend/packages/api/src/routers/channels.ts:660`          | Add `currentPage?`, `deviceType?` to `sendMessage` input schema     |
| `synap-backend/packages/api/src/clients/intelligence-hub.ts:33`   | Add `currentContext?: BootstrapContext` to `IntelligenceHubRequest` |
| `synap-backend/packages/api/src/clients/intelligence-hub.ts:261`  | Pass `currentContext` in `sendMessageStream` body                   |
| `synap-intelligence-service/src/agents/base/types.ts:43`          | Add `currentContext?: BootstrapContext` to `AgentContext`           |
| `synap-intelligence-service/src/agents/utils/context-manager.ts`  | Pass `currentContext` into `startOrContinueSession()`               |
| `synap-app/packages/apps/chat/src/ChatApp.tsx:40`                 | Add `currentPage?`, `device?` to `ChatAppProps`                     |
| `synap-app/packages/features/ai-chat/src/hooks/useSendMessage.ts` | Include `currentPage`, `deviceType` in mutation payload             |

---

### What the Frontend Does NOT Need to Build

- Any compaction UI — entirely backend/service concern
- Session management — zero-latency design means it's invisible
- Any change to the existing chat message flow — messages are sent the same way
- Any new API endpoints — same `trpc.chat.sendMessage`, just enriched payload
