# Channel → Agent Flow — Backend

> **Scope:** This document covers what the Backend enables: channel creation, agent identity storage, request forwarding to the IS, session management, and permission governance. For what the Intelligence Service does with those inputs see [`synap-intelligence-service/docs/AGENT_SYSTEM.md`](../../synap-intelligence-service/docs/AGENT_SYSTEM.md).

---

## 1. Core Principle

The Backend is **storage-authoritative and security-authoritative**. It:

- Stores `agentType` (and `agentConfig`) on the channel row — immutable after creation
- Validates `agentType` at API boundary (format/length, not an allowlist)
- Creates and tags sessions before calling the IS
- Forwards `agentType` + `agentConfig` to the IS on every message
- Governs all write operations via the proposal system (RBAC + approval flow)
- **Never interprets** what `agentType` means — that is the IS's job

---

## 2. One Agent Per Channel

Agent identity is **set at channel creation time and never changed**. This is by design:

- Every message in a channel is answered by the same agent class
- Context accumulates consistently within one agent's perspective
- Switching agents = creating a new branch

The `updateChannel` tRPC procedure accepts `agentType` but it is only used for legacy migrations. In normal operation, channels are read-only after creation.

---

## 3. `agentType` — A Free String

The `agentType` column on `channels` is `text` with **no DB-level CHECK constraint**. Drizzle's `{ enum: [...] }` option was removed — it was TypeScript-only and never created a real Postgres constraint.

```sql
-- channels table
agent_type TEXT NOT NULL DEFAULT 'meta'
```

The `ChannelAgentType` TypeScript enum is kept for internal defaults only:

```typescript
export enum ChannelAgentType {
  DEFAULT = "default", // legacy pre-redesign channels
  META = "meta", // default for new channels
  PROMPTING = "prompting",
  KNOWLEDGE_SEARCH = "knowledge-search",
  CODE = "code",
  WRITING = "writing",
  ACTION = "action",
  ONBOARDING = "onboarding",
  WORKSPACE_CREATION = "workspace-creation",
}
```

**Input validation** on all tRPC procedures that accept `agentType`:

```typescript
agentType: z.string()
  .min(1)
  .max(100)
  .regex(/^[\w:.-]+$/)
  .optional();
```

This allows: `meta`, `knowledge-search`, `persona:cto`, `custom.agent` — blocks injection.

---

## 4. Channel Lifecycle

### 4A. Creation (`createChannel`)

```
Client → trpc.chat.createChannel({ parentChannelId?, agentType?, agentConfig?, ... })
  │
  ├── If parentChannelId → BRANCH channel
  │     agentType defaults to ChannelAgentType.META
  │     Returns { channelId, channel }
  │
  └── If no parentChannelId → AI_THREAD channel
        agentType defaults to ChannelAgentType.META
        Returns { channelId, channel }
```

Both branch and main thread paths return `{ channelId, channel }` — the full channel object.

### 4B. Personal Channel

One permanent `AI_THREAD` per `(userId, workspaceId)` with `metadata.isPersonal = true`. Created lazily via `trpc.chat.getPersonalChannel`. Always `agentType = "meta"`.

### 4C. Branch via Hub Protocol REST

The IS can create branches directly during execution (via `create_branch` tool):

```
IS → POST /api/hub/threads
  { userId, workspaceId, parentChannelId, agentType, branchPurpose }
```

`agentType` is validated with the same regex + length check and stored directly. No allowlist.

### 4D. Agent-to-Agent (A2AI) Channels

Created via `trpc.chat.createA2AIChannel`. No human required as author. Used for agent coordination. Same `agentType` storage rules apply.

---

## 5. `sendMessage` Flow

```
Client → trpc.chat.sendMessage({ channelId, content, agentType?, ... })
  │
  ├── Resolve session (getOrCreate active session for channelId)
  ├── Insert user message (with sessionId)
  ├── Read channel.agentType (stored value)
  ├── Resolve effective agent type:
  │     @mention handle → lookup → overrides channel.agentType for this call only
  │     no @mention → use channel.agentType
  │
  ├── POST /api/chat/stream (IS) with:
  │     { query, threadId: channelId, userId, agentType: effectiveAgentType,
  │       agentConfig: channel.agentConfig, dataPodUrl, dataPodApiKey, ... }
  │
  ├── Stream IS response back to client (SSE)
  ├── Insert assistant message (with sessionId)
  └── Update session stats (last_activity_at, token_count, message_count)
```

### Key: `agentType` forwarding

The backend reads `channel.agentType` from the DB and passes it to the IS. The IS never guesses which agent to use — the backend always tells it.

`agentConfig` (JSONB) is also forwarded as-is. It can contain `{ name, instructions, personality }` for persona overlays without needing a new IS agent class.

---

## 6. @mention Override

Users can temporarily override the channel's agent for a single message:

```
User types: "@cto What do you think about our tech stack?"
```

The backend resolves the handle `cto` → `agentType = "persona:cto"` for that call only. The channel's stored `agentType` is not modified.

This is tracked via `agentHandle` in `sendMessage` input. Resolution is in `channels.ts` around line 693.

---

## 7. Hub Protocol REST (IS → Backend)

The IS calls back into the backend via Hub Protocol when it needs to read/write data during tool execution. Two entry points:

### `POST /threads` (create thread/branch)

Used by `create_branch` tool. Accepts:

```typescript
{ userId, workspaceId, title?, parentChannelId?, agentType?, branchPurpose? }
```

`agentType` is validated with regex + length. Defaults to `"meta"` if absent/invalid.

### `POST /threads/:threadId/messages` (post result message)

Used by `dispatch_agent` tool to post branch result. `agentType` is not re-validated here (it's already on the channel).

---

## 8. Permission Governance

The backend applies RBAC to all write operations that agents request:

```
IS tool call → Hub Protocol → checkPermissionOrPropose()
  ├── Permission granted → execute immediately
  └── Permission denied → create proposal in DB
        User reviews proposal → approves/rejects
```

Auto-approve whitelist (no human review needed):

```
"search.*", "memory.recall", "entity.read", "document.read",
"context.*", "view.create", "profile.*", "property_def.*"
```

Write operations (`entity.create`, `document.create`, etc.) require explicit approval unless the agent has elevated permissions or the user has pre-approved the action.

---

## 9. Session Management

Sessions are scoped to `(channelId, status='active')`. One active session per channel at a time.

Before inserting a user message, the backend:

1. Queries for an active session on the channel
2. If none, inserts a new session
3. Tags both the user message and assistant message with `sessionId`

After the assistant message is saved:

```sql
UPDATE sessions
SET last_activity_at = now(),
    total_tokens_used = COALESCE(total_tokens_used, 0) + N,
    message_count = COALESCE(message_count, 0) + 2
WHERE id = sessionId
```

This powers the Session-Scoped Memory system (compaction, bootstrap context injection).

---

## 10. What Backend Does NOT Do

- **Interpret `agentType`** — forwarded to IS as-is; backend doesn't know what "code" means
- **Route to agent classes** — IS responsibility entirely
- **Apply personality overlays** — forwarded via `agentConfig`; IS applies them
- **Validate `agentType` against an allowlist** — format/length only; IS handles unknown types gracefully
- **Stream AI responses** — SSE comes from IS; backend relays it to the client

---

## 11. Frontend Responsibilities

Frontend is **UI-only** — it never interprets agent types or applies AI logic.

Channel identity (agentType) is read from the channel object and displayed:

- Agent identity chip in the channel header (read-only pill showing agent name)
- Agent selector modal creates a **new branch** with the selected `agentType` — never modifies the current channel

```typescript
// ChatApp.tsx — correct pattern
const handleSelectAgent = async (agentId: string) => {
  const newChannel = await createBranch(
    `Conversation with ${agentName}`,
    agentId
  );
  setActiveChannelId(newChannel.id);
};
```

The `useChannel` hook accepts `AgentTypeString = string` for full type freedom including `persona:*`.
