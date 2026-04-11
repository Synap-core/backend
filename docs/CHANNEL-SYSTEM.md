# Channel System — V2 Design Spec

> Status: **DRAFT** — supersedes scattered notes in `CHANNEL_AGENT_FLOW.md`, the audit results from 2026-04-11, and the original schema comments.
> Last updated: 2026-04-11

---

## Mental Model

A channel is a **conversation surface with a context scope**.

Every channel belongs to exactly one context. The context is what the conversation is _about_ — a workspace, an entity, a project, a document, the user themselves. The channel type encodes the _structure_ of that conversation (who participates, whether AI is active, whether it has a parent). The context encodes the _subject matter_.

**The personal AI is always the user's agent** — it doesn't change per channel. What changes is what context gets injected. When a user opens a thread linked to a project, the same personal AI runs with that project's entities, documents, and history in scope.

This means the proliferation of specialized types (`entity_comments`, `document_review`, `view_discussion`) is a design smell. They are all the same thing — a conversation linked to an object — with different `contextObjectType` values. The spec below collapses them.

---

## Type System

Six canonical channel types going forward.

### `personal`

**The user's permanent AI assistant channel — pod-wide.**

One per user across the entire data pod. Created automatically on first login. Never deleted. Accumulates AI memory across all workspaces (intentional — this is the user's longitudinal relationship with their AI).

- Scope: always `pod`
- AI: always active, personal agent
- Context: `contextObjectType = 'user'`, `contextObjectId = userId`
- Parent: none
- `channelPurpose`: n/a (absorbed into this type)
- User-facing label: "Chat" or "My AI"

This was: `ai_thread` + `channelPurpose = 'chat'`

---

### `thread`

**A conversation linked to a specific context object.**

The general-purpose conversation type. Replaces `ai_thread` (free-form workspace conversation), `entity_comments`, `document_review`, and `view_discussion`. The context object determines what the conversation is about. The `agentType` field determines whether AI participates.

- Scope: `workspace` or `pod` (set at creation, based on context object scope)
- AI: depends on `agentType` — off (`none`) by default for entity/doc links, on for workspace threads
- Context: always required — see Context Object Types below
- Parent: none
- `channelPurpose`: null

**Context object types for `thread`:**

| `contextObjectType` | `contextObjectId` | Was                     | Default AI   |
| ------------------- | ----------------- | ----------------------- | ------------ |
| `workspace`         | workspaceId       | `ai_thread` (free-form) | on (`meta`)  |
| `entity`            | entityId          | `entity_comments`       | off (`none`) |
| `document`          | documentId        | `document_review`       | off (`none`) |
| `view`              | viewId            | `view_discussion`       | off (`none`) |
| `project`           | projectEntityId   | (new)                   | on (`meta`)  |
| `task`              | taskEntityId      | (new)                   | off (`none`) |

"Project" and "task" are entity subtypes — `contextObjectId` is the entity UUID, `contextObjectType` is the profile slug-equivalent label. This keeps the context table generic.

**The AI default rule:**
When a user explicitly starts a conversation (workspace or project context) → AI on.
When a system auto-creates a channel for an object (entity, document, task) → AI off until opted in via `agentType` update or @mention.

---

### `sub_thread`

**A specialized sub-agent task spawned within a parent channel.**

What was called `branch` — and what `thread` was supposed to become. A sub_thread is always created within a parent channel, carries a specific agent persona for a focused task, and is expected to conclude (producing a `resultSummary` that feeds back to the parent).

- Scope: inherits from parent
- AI: always active, specialized agent (`agentType` = specific persona)
- Context: inherits parent's context + optional additional context
- Parent: always set (`parentChannelId` required)
- `channelPurpose`: null
- Has: `branchPurpose` (task description), `resultSummary` (output), `mergedAt`

**User mental model:** The main conversation is flowing. The AI says "let me spin up a research thread for this." That thread is a `sub_thread`. When done, it posts its findings back and closes. The user stays in the parent.

**Creation paths:**

- AI-initiated (requires proposal if governance is on): during a message response
- User-initiated: explicit "start sub-thread" action on a message

This replaces: `branch`, and the unimplemented `thread` type.

---

### `feed`

**A proactive AI broadcast channel — AI posts, users read.**

Not a conversation. AI posts content here (morning briefings, digests, connector sync summaries, automation results). Users read and optionally tap to "continue in a thread". Has an explicit `feedScope`.

- AI: system posts only (no user→AI back-and-forth initiated from here)
- Context: `contextObjectType = feedScope` (see below)
- Parent: none
- `channelPurpose`: n/a (absorbed into type)

**Feed scopes:**

| `feedScope` | Scope     | One per   | What appears here                                                                    |
| ----------- | --------- | --------- | ------------------------------------------------------------------------------------ |
| `user`      | pod       | user      | Personal proactive: morning briefing, personal insights, capture summaries           |
| `workspace` | workspace | workspace | Workspace-wide: connector sync summaries, team automation results, workspace digests |

Both can exist simultaneously. The delivery router routes by signal domain:

- Personal signals (proactive, ai_insight) → `user` feed
- Workspace signals (connector, automation) → `workspace` feed (or both, depending on delivery prefs)

**Workspace feed is new** — currently everything goes to the user feed. The workspace feed is where connector sync completions, automation channel_message output, and team-wide AI summaries should land.

This was: `ai_thread` + `channelPurpose = 'feed'` (user-scoped only)

---

### `external`

**An ingested conversation from an external platform.**

One per external conversation linked to Synap. Messages from the external platform are replayed into this channel. The user can continue the conversation in Synap; responses can optionally be routed back to the external platform.

- AI: off for imported messages (historical); on for new user messages
- Context: `contextObjectType = 'external'`, `contextObjectId = externalChannelId`
- `externalSource`: `'whatsapp' | 'slack' | 'gmail' | 'telegram' | 'sms'`
- `externalChannelId`: the ID of the conversation in the external system

This was: `external_import` (renamed, same semantics)

---

### `agent_collab`

**An internal multi-agent collaboration channel.**

A persistent async channel where multiple AI agents (and optionally human observers) communicate. Not user-initiated — created by workspace admins or automation to set up agent teams for ongoing tasks. Distinct from the Google A2A protocol (see below).

- AI: multiple agents can post; no single "owner" agent
- Scope: `workspace`
- Visibility: `open` (any agent can join, first post requires proposal) or `closed` (fixed participant list)
- Humans can observe and inject messages at any time
- Context: `contextObjectType = 'workspace'` or a specific project/task

**Distinction from Google A2A:**
`agent_collab` is a **persistent, stateful, multi-turn** channel between agents within a pod. It accumulates history, supports governance, and allows human oversight. Google's A2A protocol is **ephemeral, task-scoped, cross-system** — Agent A sends a task to Agent B on a different server, gets an artifact back, and the interaction is done. They solve different problems:

|              | `agent_collab`            | Google A2A                        |
| ------------ | ------------------------- | --------------------------------- |
| Persistence  | Permanent channel history | Ephemeral per task                |
| Scope        | Within a pod              | Cross-system (different servers)  |
| Participants | Fixed or open set         | Two agents (delegator + executor) |
| Human access | Yes, always               | Out of scope                      |
| Use case     | Ongoing agent team        | One-time task delegation          |

We keep `agent_collab` as an internal channel type. We will separately implement A2A protocol support for cross-pod and cross-system agent delegation — that's a transport layer, not a channel type.

This was: `a2ai` (renamed for clarity)

---

## Removed Types

| Old type          | Status                                          | Reason                                                                     |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `entity_comments` | Removed → `thread` + contextObjectType=entity   | Redundant specialization                                                   |
| `document_review` | Removed → `thread` + contextObjectType=document | Redundant specialization                                                   |
| `view_discussion` | Removed → `thread` + contextObjectType=view     | Was never implemented                                                      |
| `direct`          | Deferred                                        | No user story driving it yet; slot reserved via `contextObjectType='user'` |

`direct` (user-to-user messaging) is not built. When it is, it becomes `thread` + `contextObjectType = 'user'` + `contextObjectId = targetUserId`. No new type needed.

---

## Scope Dimension

A new `scope` column (`pod | workspace | user`) is added to channels. It's orthogonal to type and controls visibility and filtering.

| Type           | Default scope               | Rationale                                      |
| -------------- | --------------------------- | ---------------------------------------------- |
| `personal`     | `pod`                       | One across all workspaces — the user's root AI |
| `thread`       | `workspace`                 | Scoped to where the context object lives       |
| `sub_thread`   | inherits parent             | Same scope as parent channel                   |
| `feed`         | `pod` (user) or `workspace` | Depends on feedScope                           |
| `external`     | `workspace`                 | External imports are workspace-specific        |
| `agent_collab` | `workspace`                 | Agent teams are workspace-scoped               |

---

## Context Object Types

`contextObjectType` is a free string (not an enum in the DB) to stay extensible. Canonical values:

```
user         — the user themselves (personal channel)
workspace    — a specific workspace (free-form workspace thread)
entity       — any entity (uses profileSlug to sub-classify if needed)
document     — a document entity
view         — a view
project      — a project entity
task         — a task entity
external     — external platform conversation (for external type)
```

---

## AI Routing

The current complex gate:

```typescript
// BEFORE (confusing)
const isAiChannel =
  type === AI_THREAD ||
  type === BRANCH ||
  ((type === THREAD || type === ENTITY_COMMENTS) &&
    agentType &&
    agentType !== "default");
```

Becomes:

```typescript
// AFTER (clear)
const isAiActive =
  channelType === "personal" ||
  channelType === "sub_thread" ||
  channelType === "agent_collab" ||
  (channelType === "thread" && agentType !== "none") ||
  (channelType === "external" &&
    /* user message, not imported */ messageIsFromUser) ||
  (channelType === "feed" && false); // feed: system posts only, no user→IS
```

**`ChannelAgentType.DEFAULT` → renamed to `ChannelAgentType.NONE`**

The current `DEFAULT` value suppresses AI — the opposite of what "default" implies. Migration: all rows with `agentType = 'default'` update to `agentType = 'none'`. New channels that want AI off explicitly set `agentType = 'none'`.

---

## Delivery Surfaces

The delivery router's surface map expands:

| Surface          | Target                                           | Signal domains                          |
| ---------------- | ------------------------------------------------ | --------------------------------------- |
| `user_feed`      | User's `feed` channel (feedScope=user)           | proactive, ai_insight                   |
| `workspace_feed` | Workspace's `feed` channel (feedScope=workspace) | connector, automation (workspace-level) |
| `chat`           | User's `personal` channel                        | Any domain if configured                |
| `notification`   | Notifications table (not a channel)              | connector (default), governance         |
| `suppress`       | No-op                                            | Any domain                              |

```typescript
type SignalSurface =
  | "user_feed"
  | "workspace_feed"
  | "chat"
  | "notification"
  | "suppress";
```

`feed` in the old schema → split into `user_feed` and `workspace_feed`. Old `deliveryPreferences.proactive.surfaces = ['feed']` maps to `['user_feed']` during migration.

---

## Capture Audit Trail

**`channelPurpose = 'audit'` is removed.**

The capture history audit trail is already in the event log (`capture.complete.completed` events contain the full extraction). Maintaining a separate hidden channel that duplicates this is unnecessary and confusing.

Going forward:

- Capture history is a query: `GET /api/hub/events?types[]=capture.complete.completed&userId=X`
- Frontend shows this as a "Capture History" view in settings, not a channel
- Existing `audit` purpose channels can be archived and eventually purged

---

## Schema Delta

```sql
-- New column: scope
ALTER TABLE channels ADD COLUMN scope TEXT NOT NULL DEFAULT 'workspace'
  CHECK (scope IN ('pod', 'workspace', 'user'));

-- New column: feed_scope (only for feed type)
ALTER TABLE channels ADD COLUMN feed_scope TEXT
  CHECK (feed_scope IN ('user', 'workspace'));

-- Rename channel types in-place
UPDATE channels SET channel_type = 'thread'
  WHERE channel_type IN ('ai_thread', 'entity_comments', 'document_review', 'view_discussion');

UPDATE channels SET channel_type = 'sub_thread'
  WHERE channel_type = 'branch';

UPDATE channels SET channel_type = 'external'
  WHERE channel_type = 'external_import';

UPDATE channels SET channel_type = 'agent_collab'
  WHERE channel_type = 'a2ai';

-- Set scope for existing personal channels
UPDATE channels SET channel_type = 'personal', scope = 'pod'
  WHERE channel_purpose = 'chat';

-- Set type + scope for existing feed channels
UPDATE channels SET channel_type = 'feed', scope = 'pod', feed_scope = 'user'
  WHERE channel_purpose = 'feed';

-- Archive audit channels (no data loss — event log is source of truth)
UPDATE channels SET status = 'archived'
  WHERE channel_purpose = 'audit';

-- Rename agentType DEFAULT → NONE
UPDATE channels SET agent_type = 'none'
  WHERE agent_type = 'default';

-- Set scope for remaining channels
UPDATE channels SET scope = 'pod'
  WHERE workspace_id IS NULL AND scope = 'workspace';

-- Drop channel_purpose column (absorbed into type)
-- Run after verifying all rows migrated
ALTER TABLE channels DROP COLUMN channel_purpose;
```

**Drizzle schema changes needed:**

- Update `ChannelType` enum: remove `AI_THREAD`, `BRANCH`, `ENTITY_COMMENTS`, `DOCUMENT_REVIEW`, `VIEW_DISCUSSION`, `EXTERNAL_IMPORT`, `A2AI`, `DIRECT`, `THREAD`; add `PERSONAL`, `THREAD`, `SUB_THREAD`, `FEED`, `EXTERNAL`, `AGENT_COLLAB`
- Remove `ChannelPurpose` enum + `channelPurpose` column
- Add `scope: text('scope', { enum: ['pod', 'workspace', 'user'] })`
- Add `feedScope: text('feed_scope', { enum: ['user', 'workspace'] })`
- Rename `ChannelAgentType.DEFAULT` → `ChannelAgentType.NONE`
- Expand `contextObjectType` canonical values in comments

---

## Implementation Phases

### Phase 1 — Schema + migration (no behavior change)

1. Add `scope` and `feed_scope` columns with defaults
2. Run UPDATE migrations above
3. Update Drizzle schema TypeScript
4. Update `ChannelAgentType.DEFAULT → NONE` everywhere
5. Update `ChannelType` enum + any type guards

### Phase 2 — AI routing simplification

1. Replace complex AI gate with the simplified rule
2. Update `sendMessage` router + hub-protocol message handler
3. Remove `channelPurpose` reads (all replaced by `channelType = 'personal'` / `'feed'` checks)

### Phase 3 — Workspace feed

1. Add `ensureWorkspaceFeedChannel()` alongside `ensureProactiveFeedChannel()`
2. Update delivery router: split `feed` surface → `user_feed` + `workspace_feed`
3. Update `DeliveryPreferences` schema: add `workspace_feed` surface option
4. Wire connector sync completion + workspace-level automation output → workspace feed

### Phase 4 — Context object expansion

1. Expand `contextObjectType` to accept `project` and `task`
2. Update channel creation UI to link any new thread to a context object
3. Default new workspace threads to `contextObjectType = 'workspace'`

### Phase 5 — Capture audit removal

1. Add "Capture History" view in settings (query against event log)
2. Archive existing `audit` channels
3. Remove `recordCaptureMessages()` function (or make it a no-op)

---

## What Stays Intentionally Unchanged

**Personal AI is pod-wide.** The user has one AI companion across all workspaces. Memory is shared. This is a product choice — the AI grows with the user, not per-workspace. Workspace-specific context is injected at query time via the context system, not by having different AI instances.

**Sub-threads require governance.** `sub_thread` creation (what was `branch`) goes through `checkPermissionOrPropose()` by default. This is the AI autonomy boundary — humans stay in control of when AI spins up parallel work.

**`agent_collab` is internal only.** It's not exposed to end users as a channel they create. It's workspace admin / automation territory. No user-facing creation UI.

**`agentType` remains a free string.** No DB-level enum constraint. The IS handles unknown agentType values gracefully (falls back to OrchestratorAgent + logs warn). This keeps the agent system extensible without requiring DB migrations for every new persona.

---

## Open Questions

1. **Thread context required or optional?** Going forward, should all `thread` channels require a `contextObjectType`? Or allow null for "generic workspace conversation"? Proposal: require it, default to `contextObjectType = 'workspace'` with `contextObjectId = workspaceId`. This makes every channel traceable to something.

2. **Workspace feed ownership.** When multiple users in a workspace have the workspace feed, do they all see the same posts? Yes — workspace feed is a shared channel, like a team bulletin board. All members are effectively subscribed. Access controlled by workspace membership.

3. **Sub-thread lifecycle.** When a sub_thread is created by the AI during a conversation, should it appear in the channel list? Or stay hidden in the parent? Proposal: hidden by default, accessible via parent's branch panel. Only promoted to visible if the user pins it.

4. **External A2A protocol.** When we implement cross-system A2A task delegation (IS → external agent), what's the surface for the result? Options: artifact posted to the originating thread, entity created, or notification. Needs a separate spec.

5. **Direct (user-to-user) messaging.** Still deferred. When built: `thread` + `contextObjectType = 'user'` + `agentType = 'none'` by default. AI can be added via @mention like entity threads.
