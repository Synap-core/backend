# Channel System — V2

> Status: **IMPLEMENTED** — Migration `0066_channel_system_v2.sql` shipped.  
> Last updated: 2026-04-11

---

## Mental Model

A channel is a **conversation surface with a context scope**.

Every channel belongs to exactly one context. The context is what the conversation is _about_ — a workspace, an entity, a project, a document, the user themselves. The channel type encodes the _structure_ of that conversation (who participates, whether AI is active, whether it has a parent). The context encodes the _subject matter_.

**The personal AI is always the user's agent.** What changes is what context gets injected. When a user opens a thread linked to a project, the same personal AI runs with that project's entities, documents, and history in scope.

The previous proliferation of specialised types (`entity_comments`, `document_review`, `view_discussion`) was a design smell. They were all the same thing — a conversation linked to an object — with different `contextObjectType` values. V2 collapses them.

---

## Type System — 6 Canonical Types

### `personal`

**The user's permanent AI assistant channel — pod-wide.**

One per user across the entire data pod. Created automatically on first login. Never deleted. Accumulates AI memory across all workspaces (intentional — this is the user's longitudinal relationship with their AI).

- Scope: always `pod`
- AI: always active, personal agent
- Context: `contextObjectType = 'user'`, `contextObjectId = userId`
- Parent: none
- User-facing label: "Chat" or "My AI"

**Was:** `ai_thread` + `channelPurpose = 'chat'`

---

### `thread`

**A conversation linked to a specific context object.**

The general-purpose conversation type. Replaces `ai_thread` (free-form workspace conversation), `entity_comments`, `document_review`, and `view_discussion`. The context object determines what the conversation is about. The `agentType` field determines whether AI participates.

- Scope: `workspace` or `pod` (based on context object scope)
- AI: depends on `agentType` — off (`none`) by default for entity/doc links, on for workspace threads
- Context: `contextObjectType` + `contextObjectId` always set
- Parent: none

**Context object types for `thread`:**

| `contextObjectType` | `contextObjectId` | Was                     | Default AI   |
| ------------------- | ----------------- | ----------------------- | ------------ |
| `workspace`         | workspaceId       | `ai_thread` (free-form) | on (`meta`)  |
| `entity`            | entityId          | `entity_comments`       | off (`none`) |
| `document`          | documentId        | `document_review`       | off (`none`) |
| `view`              | viewId            | `view_discussion`       | off (`none`) |
| `project`           | projectEntityId   | (new)                   | on (`meta`)  |
| `task`              | taskEntityId      | (new)                   | off (`none`) |

**Was:** `ai_thread`, `entity_comments`, `document_review`, `view_discussion`

---

### `sub_thread`

**A specialised sub-agent task spawned within a parent channel.**

Always created within a parent channel. Carries a specific agent persona for a focused task. Expected to conclude (producing a `resultSummary` that feeds back to the parent).

- Scope: inherits from parent
- AI: always active, specialised agent (`agentType` = specific persona)
- Context: inherits parent's context + optional additional context
- Parent: always set (`parentChannelId` required)
- Fields: `branchPurpose` (task description), `resultSummary` (output), `mergedAt`

**Creation:** AI-initiated (requires proposal if governance is on) or user-initiated ("start sub-thread" action).

**Was:** `branch`

---

### `feed`

**A proactive AI broadcast channel — AI posts, users read.**

Not a conversation. AI posts content here (morning briefings, digests, connector sync summaries, automation results). Users read and tap to "Continue in a thread".

- AI: system posts only (no user→AI back-and-forth from here)
- Input: hidden — users cannot write; `readOnlyBanner` shown
- Parent: none

**Feed scopes (`feedScope` column):**

| `feedScope` | Scope     | One per   | What appears here                                                 |
| ----------- | --------- | --------- | ----------------------------------------------------------------- |
| `user`      | pod       | user      | Personal proactive: morning briefing, insights, capture summaries |
| `workspace` | workspace | workspace | Team-wide: connector sync, automation results, workspace digests  |

**Was:** `ai_thread` + `channelPurpose = 'feed'` (user-scoped only)

---

### `external`

**An ingested conversation from an external platform.**

One per external conversation linked to Synap. Messages from the external platform are replayed into this channel. Historical messages are read-only; the user can write new messages (optionally routed back to the external platform).

- AI: off for imported messages; on for new user messages
- Context: `contextObjectType = 'external'`, `contextObjectId = externalChannelId`
- Fields: `externalSource` (`'whatsapp' | 'slack' | 'gmail' | 'telegram' | 'sms'`), `externalChannelId`

**Was:** `external_import`

---

### `agent_collab`

**An internal multi-agent collaboration channel.**

Persistent async channel where multiple AI agents (and optionally human observers) communicate. Created by workspace admins or automation to set up agent teams. Humans can observe and inject messages at any time.

- Scope: `workspace`
- AI: multiple agents; no single owner
- Input: hidden by default (human injection is a deliberate action)

**Distinction from Google A2A:**

|              | `agent_collab`            | Google A2A               |
| ------------ | ------------------------- | ------------------------ |
| Persistence  | Permanent channel history | Ephemeral per task       |
| Scope        | Within a pod              | Cross-system             |
| Participants | Fixed or open set         | Two agents               |
| Human access | Yes, always               | Out of scope             |
| Use case     | Ongoing agent team        | One-time task delegation |

**Was:** `a2ai`

---

## Removed Types

| Old type          | Status                                    | Reason                                                   |
| ----------------- | ----------------------------------------- | -------------------------------------------------------- |
| `entity_comments` | → `thread` + `contextObjectType=entity`   | Redundant specialisation                                 |
| `document_review` | → `thread` + `contextObjectType=document` | Redundant specialisation                                 |
| `view_discussion` | → `thread` + `contextObjectType=view`     | Was never implemented                                    |
| `direct`          | Deferred                                  | No user story; slot: `thread` + `contextObjectType=user` |

---

## Removed: `channelPurpose`

The `channel_purpose` column is fully dropped. Its values were absorbed:

- `chat` → `channelType = 'personal'`
- `feed` → `channelType = 'feed'`
- `audit` → archived + purged; capture history = event log query

---

## `ChannelAgentType.NONE` (was `DEFAULT`)

`DEFAULT` was renamed `NONE` — "default" implied AI is on by default, which was the opposite of the actual behavior (it suppressed AI). All rows with `agentType = 'default'` migrated to `agentType = 'none'`.

---

## Scope Dimension

New `scope` column (`pod | workspace | user`) added to channels. Orthogonal to type; controls visibility and filtering.

| Type           | Default scope               | Rationale                                |
| -------------- | --------------------------- | ---------------------------------------- |
| `personal`     | `pod`                       | One across all workspaces                |
| `thread`       | `workspace`                 | Scoped to where the context object lives |
| `sub_thread`   | inherits parent             | Same scope as parent channel             |
| `feed`         | `pod` (user) or `workspace` | Depends on `feedScope`                   |
| `external`     | `workspace`                 | External imports are workspace-specific  |
| `agent_collab` | `workspace`                 | Agent teams are workspace-scoped         |

---

## AI Routing Gate (V2)

```typescript
// Implemented in: packages/api/src/routers/channels.ts → sendMessage

const isAiActive =
  channel.channelType === ChannelType.PERSONAL ||
  channel.channelType === ChannelType.SUB_THREAD ||
  channel.channelType === ChannelType.AGENT_COLLAB ||
  (channel.channelType === ChannelType.THREAD &&
    !!channel.agentType &&
    channel.agentType !== ChannelAgentType.NONE) ||
  (channel.channelType === ChannelType.EXTERNAL &&
    !!channel.agentType &&
    channel.agentType !== ChannelAgentType.NONE);
// feed: never triggers IS — system posts only
```

---

## Schema (Current State)

```sql
-- channels table after migration 0066
channels (
  id                  UUID PRIMARY KEY,
  user_id             TEXT NOT NULL,
  workspace_id        UUID,                     -- null for pod-wide (personal, feed/user)
  channel_type        channel_type NOT NULL,    -- personal | thread | sub_thread | feed | external | agent_collab
  scope               TEXT NOT NULL DEFAULT 'workspace', -- pod | workspace | user
  feed_scope          TEXT,                     -- user | workspace (feed type only)
  status              channel_status,           -- active | merged | archived
  title               TEXT,
  parent_channel_id   UUID REFERENCES channels, -- sub_thread only
  branch_purpose      TEXT,                     -- sub_thread task description
  result_summary      TEXT,                     -- sub_thread output summary
  merged_at           TIMESTAMPTZ,
  agent_id            TEXT,
  agent_type          TEXT DEFAULT 'none',      -- 'none' | 'meta' | 'persona:cto' | any custom
  agent_config        JSONB,
  context_object_type TEXT,                     -- user | workspace | entity | document | view | external
  context_object_id   UUID,
  external_source     TEXT,                     -- whatsapp | slack | gmail | telegram | sms
  external_channel_id TEXT,
  context_summary     TEXT,
  metadata            JSONB,
  created_at          TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ
)
```

**Active indexes:**

```sql
channels_user_id_idx          ON channels(user_id)
channels_workspace_id_idx     ON channels(workspace_id)
channels_parent_channel_id_idx ON channels(parent_channel_id)
channels_status_idx           ON channels(status)
channels_type_idx             ON channels(channel_type)        -- NEW in 0066
channels_scope_idx            ON channels(scope)               -- NEW in 0066
channels_context_idx          ON channels(context_object_type, context_object_id)
  WHERE context_object_id IS NOT NULL
```

---

## Migration History

| Migration                    | Description                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `0038_channels_refactor.sql` | Original channels table (V1)                                                                       |
| `0066_channel_system_v2.sql` | V2: add scope/feed_scope, rename types, drop channel_purpose, agent_type default→none, new indexes |

---

## Frontend — Composition System

The frontend single source of truth lives at:

```
synap-app/packages/core/channels/src/composition.ts
```

Every channel-type-specific behavior is defined there as a `ChannelComposition` record — no switch statements in UI components. Key exported helpers:

```typescript
import {
  getChannelComposition, // full config for a type
  getChannelAccentColorVar, // CSS var string for accent color
  getSectionKeyForType, // sidebar section for a type
  isAlwaysAIChannel, // always-on AI types (personal | sub_thread | agent_collab)
  isAICapableChannel, // AI possible (+ thread with agentType set)
  isWritableChannel, // users can write to this channel
  CHANNEL_SECTION_CONFIGS, // sidebar section metadata (label, emptyHint, canCreate)
  ChannelTypeIcon, // React component: canonical icon per type
  ReadOnlyBanner, // React component: banner for non-writable channels
} from "@synap-core/channels";
```

**Adding a new channel type:**

1. Add entry to `COMPOSITIONS` in `composition.ts` — all behavior follows
2. Register a renderer in `registry.ts` (or `registerChannelCells.ts`)
3. No other files need touching

---

## Frontend — Renderer Registry

```
ChannelRenderer → registry.resolveChannelRenderer(channelType)
  ├── "personal"      → AIChannelView    (registered by @synap-core/ai-chat)
  ├── "thread"        → AIChannelView    (registered by @synap-core/ai-chat)
  ├── "sub_thread"    → AIChannelView    (registered by @synap-core/ai-chat)
  ├── "feed"          → ViewDiscussionView (registered by @synap-core/channels)
  ├── "external"      → ExternalImportView (registered by @synap-core/channels)
  ├── "agent_collab"  → AgentToAgentView   (registered by @synap-core/channels)
  └── (unknown)       → ChannelPanel (generic fallback)
```

---

## Key Files

| File                                                                            | Role                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/database/src/schema/channels.ts`                                      | Drizzle schema + enums                                    |
| `packages/database/src/repositories/channel-repository.ts`                      | CRUD                                                      |
| `packages/database/src/utils/personal-channel.ts`                               | `ensurePersonalChannel()`, `ensureProactiveFeedChannel()` |
| `packages/api/src/routers/channels.ts`                                          | Main tRPC router (key: `trpc.chat.*`)                     |
| `packages/api/src/routers/hub-protocol-rest.ts`                                 | REST adapter for IS                                       |
| `packages/api/src/routers/hub-protocol/channels.ts`                             | Hub Protocol channel ops                                  |
| `packages/jobs/src/workers/proactive-post.ts`                                   | Personal + feed channel provisioning                      |
| `packages/jobs/src/workers/automation-executor.ts`                              | Automation → channel routing                              |
| `synap-app/packages/core/channels/src/composition.ts`                           | Frontend: single source of truth                          |
| `synap-app/packages/core/channels/src/registry.ts`                              | Frontend: renderer registry                               |
| `synap-app/packages/core/channels/src/components/ChannelPanel/ChannelPanel.tsx` | Frontend: generic channel panel                           |

---

## Open Questions (Deferred)

1. **Workspace feed** — currently all proactive posts go to the user feed. The workspace feed (`feedScope = 'workspace'`) schema is ready; the delivery router split (`user_feed` vs `workspace_feed`) is not yet wired.

2. **Thread context required?** Going forward, should all `thread` channels require a `contextObjectType`? Proposal: require it, default to `contextObjectType = 'workspace'`. Tracked in Phase 4 above.

3. **Sub-thread visibility.** Should AI-spawned sub-threads appear in the channel list? Proposal: hidden by default, accessible via parent's branch panel. Only promoted to visible if user pins.

4. **External A2A protocol.** Cross-system agent delegation (IS → external agent) result surface — artifact to originating thread, entity, or notification. Needs a separate spec.

5. **Direct messaging (user-to-user).** Deferred. Implementation: `thread` + `contextObjectType = 'user'` + `agentType = 'none'`. No new channel type needed.
