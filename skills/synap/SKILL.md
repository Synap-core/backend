---
name: synap
description: >
  Sovereign AI knowledge infrastructure. Typed entity graph, documents,
  long-term memory, messaging relay, and AI governance — all in PostgreSQL.
version: 2.0.0
metadata:
  openclaw:
    requires:
      env:
        - SYNAP_HUB_API_KEY
        - SYNAP_POD_URL
      optional_env:
        - SYNAP_WORKSPACE_ID
        - SYNAP_AGENT_USER_ID
        - SYNAP_CONFIG_URL
        - SYNAP_DEFAULT_CHANNEL_ID
    primaryEnv: SYNAP_HUB_API_KEY
    emoji: "\U0001F9E0"
    homepage: https://synap.live/openclaw
    capabilities:
      - memory
      - knowledge-graph
      - channels
      - chat
    os:
      - macos
      - linux
      - windows
user-invocable: false
---

# Synap — OpenClaw Skill

You are connected to a **Synap Data Pod** at `{SYNAP_POD_URL}`. All requests use `Authorization: Bearer {SYNAP_HUB_API_KEY}`.

Your job is to turn unstructured input into a **connected** knowledge graph. Single isolated entities are anti-value. Every entity you create should link to others.

---

## Mental Model

Synap is a typed knowledge graph. Six layers:

| Layer                  | What it is                                 | When to use                                                      |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| **Entities**           | Structured typed nodes                     | Anything to filter, sort, or link (task, person, project, note…) |
| **Relations**          | Typed edges between entities               | Making the graph traversable                                     |
| **Documents**          | Long-form markdown attached to entities    | Meeting notes, research, writeups                                |
| **Memory / Facts**     | Atomic knowledge fragments                 | Preferences, context, ephemeral facts                            |
| **Threads / Channels** | Conversations with optional entity context | AI discussions, messaging                                        |
| **Proposals**          | Writes queued for human approval           | Governance for some agent mutations                              |

---

## Orient Yourself First

Before doing anything, fetch live state. Never assume — workspace profiles and properties vary per installation.

```
GET /api/hub/users/me
  → { id, email, name }            ← your userId for all subsequent calls

GET /api/hub/workspaces
  → [{ id, name, role }]           ← use workspaces[0].id as workspaceId

GET /api/hub/profiles?workspaceId={workspaceId}
  → [{ slug, displayName, entityScope, properties: [{ slug, valueType, targetProfileSlug? }] }]
```

`entityScope: "pod"` = visible across all workspaces (note, task, project, person, company…).
`entityScope: "workspace"` = scoped to one workspace (deal, capture, custom types).

**Pay attention to properties with `valueType: "entity_id"`** — these are links to other entities. They are the primary way to connect data on creation (see "Linking" below).

---

## Linking — The Core Principle

**Never create orphan entities.** A task alone is near-useless. A task linked to a project, an assignee, and the source document is immediately useful — it shows up in graph traversals, context panels, and downstream queries.

Synap has **two ways** to connect entities, and the good news is they auto-sync for system profiles:

### Way 1 — ENTITY_ID properties (the fast path, auto-syncs)

Profile properties with `valueType: "entity_id"` are typed links. For system profiles, setting these properties automatically creates a row in the relations table too. No extra call needed.

Known system entity_id properties and their auto-relations:

| Profile | Property    | Targets | Auto-relation type   |
| ------- | ----------- | ------- | -------------------- |
| task    | `projectId` | project | `belongs_to_project` |
| task    | `assignee`  | person  | `assigned_to`        |
| contact | `companyId` | company | `works_at`           |
| deal    | `contactId` | contact | `deal_for`           |

Example — creating a task correctly:

```json
POST /api/hub/entities
{
  "userId": "{userId}",
  "profileSlug": "task",
  "title": "Design new onboarding flow",
  "properties": {
    "status": "todo",
    "priority": "high",
    "projectId": "prj_abc",          ← auto-creates belongs_to_project relation
    "assignee": "usr_def"            ← auto-creates assigned_to relation
  }
}
```

After this call, `GET /api/hub/relations?entityId=prj_abc` finds the task. `GET /api/hub/graph/traverse?entityId=prj_abc` includes it as a node.

### Way 2 — Explicit relations (for anything else)

For arbitrary connections, custom properties without auto-sync, or links between two already-existing entities, use the relations table directly:

```json
POST /api/hub/relations
{
  "userId": "{userId}",
  "sourceEntityId": "ent_task",
  "targetEntityId": "ent_document",
  "type": "references"               ← any string; conventions below
}
```

Conventional relation types: `related_to`, `parent_of`, `child_of`, `belongs_to`, `authored_by`, `depends_on`, `references`, `mentions`, `works_with`, `part_of`.

**Discovering available relation types**: the workspace may have custom typed relation defs. For well-known connections (task→project), prefer the property path (Way 1); it's cheaper and semantically typed.

### When to use which

| Situation                                                                   | Use                                  |
| --------------------------------------------------------------------------- | ------------------------------------ |
| Property exists on profile with `valueType: "entity_id"` and target matches | **Way 1** — set the property         |
| Custom connection, no matching property                                     | **Way 2** — create a relation        |
| Link to existing entity after-the-fact                                      | **Way 2** — create a relation        |
| Workspace has custom profile you don't know                                 | Check `/profiles` first, then decide |

---

## Searching & Traversing

Graph-based, not semantic. Think: type filter → relations → neighborhood.

```
# Keyword search across everything
GET /api/hub/search?q={query}&workspaceId={id}

# Entities of a specific type
GET /api/hub/entities?q={query}&profileSlug={slug}&workspaceId={id}

# Recent entities
GET /api/hub/entities?sort=updatedAt:desc&limit=20&workspaceId={id}

# Relations for an entity — includes property-derived relations for system profiles
GET /api/hub/relations?entityId={id}&workspaceId={id}

# Full neighborhood (BFS up to maxDepth hops)
GET /api/hub/graph/traverse?entityId={id}&maxDepth=2&workspaceId={id}
  → { nodes: Entity[], edges: Relation[] }

# Unified connections — the COMPLETE view (graph + property-derived + thread refs)
# Prefer this when you want to be sure nothing is missed, including custom-profile links
GET /api/hub/entities/{id}/connections?userId={userId}&workspaceId={id}
  → { connections: [{ entityId, entity, label, direction, source: "graph"|"property"|"thread" }],
      counts: { total, graph, structural, threads } }

# Memory facts (keyword only)
GET /api/hub/memory?userId={userId}&query={keywords}
```

**No SQL JOINs.** The graph is the join. Examples:

- Tasks for a project → `GET /relations?entityId={projectId}` (works because `projectId` auto-syncs)
- Or search: `GET /entities?profileSlug=task&q={project name}`
- Everything connected to X → `GET /graph/traverse?entityId={id}&maxDepth=2`, then filter `nodes` by `profileSlug`

---

## Writing — Governance

Every write response has a `status` field:

```json
{ "status": "approved", "id": "ent_...", "message": "..." }          ← done
{ "status": "proposed", "proposalId": "prp_...", "message": "..." }  ← pending human review
{ "status": "denied",   "reason": "..." }                            ← blocked by policy
```

`"proposed"` is **not an error** — it's the governance system queueing your change for a human. Store the `proposalId`, tell the user "queued for your review in Synap", and move on.

**What actually triggers a proposal:**

- If your API key has an associated `agentUserId` (you're identified as an agent): the backend checks `subjectType.action` against the workspace's auto-approve whitelist. These common actions are auto-approved by default:
  - `entity.create`, `entity.update`, `document.create`, `relation.create`
  - `view.create`, `profile.create/update`, `property_def.create/update`
  - `channel.create`, `bento.arrange`
  - all read / search / memory.recall / context.\*
  - `filesystem.read`, `filesystem.write_workspace` (OpenClaw's own sandbox)
- Anything else (notably `entity.delete`, `entity.archive`) goes through proposals.
- In agent-owned workspaces, destructive actions (`delete`, `archive`, `purge`) **always** propose, regardless of whitelist.
- Without `agentUserId`, writes from `source: "ai"` or `"intelligence"` propose unless the workspace has `aiGovernance.autoApprove = true`.

You don't need to set `source` — the backend reads the auth context. Just write the entity and handle the response.

---

## Writing — Core Operations

### Create entity (always with links)

```json
POST /api/hub/entities
{
  "userId": "{userId}",
  "profileSlug": "{slug}",         ← from /profiles — never guess
  "title": "...",
  "properties": {
    "status": "...",
    "dueDate": "2026-05-01",
    "projectId": "ent_...",        ← link to another entity via entity_id property
    "assignee": "usr_..."          ← another link; auto-creates relation row
  }
}
```

### Update entity

```json
PATCH /api/hub/entities/{id}
{ "title": "...", "properties": { "status": "done" } }
```

### Create explicit relation

```json
POST /api/hub/relations
{
  "userId": "{userId}",
  "sourceEntityId": "...",
  "targetEntityId": "...",
  "type": "references"
}
```

### Store memory fact

```json
POST /api/hub/memory
{ "userId": "{userId}", "fact": "User prefers async communication" }
```

Always auto-approved. Use for preferences and context that don't need structure.

### Send message to a channel

```json
POST /api/hub/threads/{threadId}/messages
{ "userId": "{userId}", "role": "user", "content": "..." }
```

To get the user's personal (default) channel:

```
GET /api/hub/channels/personal?userId={userId}&workspaceId={workspaceId}
  → { id, name, ... }
```

Both params are required. **This route requires the `hub-protocol.write` scope** (it does a get-or-create).

---

## Key Patterns

### Capture-first: never create alone

```
Before creating a task, ask: what does this link to?
  → a project?  → set properties.projectId
  → a person?   → set properties.assignee
  → a document? → create relation { type: "references", target: documentId }
  → an event?   → create relation { type: "from_meeting", target: eventId }

If nothing links → reconsider whether this should be memory, not an entity.
```

### Search before creating (dedup)

```
GET /api/hub/entities?q={title}&profileSlug={slug}&workspaceId={id}
→ if a high-confidence match exists: link to it or update it
→ if no match: create (with links)
```

### Graph traversal — explore a neighborhood

```
GET /api/hub/graph/traverse?entityId={id}&maxDepth=2&workspaceId={id}
→ Example: starting from a project
  → nodes include: the project, tasks (via belongs_to_project), assignees (via assigned_to)
  → filter nodes by profileSlug to get just one type
maxDepth: 1 = direct neighbors, 2 = neighborhood (recommended), 3 = extended (expensive)
```

### Multi-entity capture from unstructured text

```
POST /api/hub/capture/structure { userId, text, workspaceId }
  → { proposals: [{ tempId, profileSlug, title, properties, action }],
      relations: [{ sourceTempId, targetTempId, relationType }],
      followUp: "..." | null }

# User confirms (possibly with edits):
POST /api/hub/capture/execute { userId, entities, relations }
  → { created: [{ tempId, entityId }] }
```

The capture pipeline already extracts multi-entity structures with relations — prefer it over chaining manual creates when the input is free-form text.

### Governance handling

```
response = POST /api/hub/entities { ... }

approved → return entity id, confirm
proposed → "I've queued this for your review in Synap (proposalId: prp_...)"
denied   → explain the reason, ask the user to act directly
```

---

## Authentication

```
Authorization: Bearer {SYNAP_HUB_API_KEY}
X-Workspace-Id: {SYNAP_WORKSPACE_ID}      ← optional; can also pass workspaceId in body/query

Required scopes (on the API key):
  hub-protocol.read    → most GET endpoints
  hub-protocol.write   → all write endpoints AND GET /channels/personal (get-or-create)
```

---

## Common Mistakes

1. **Creating orphan entities** — every task/note/deal should link to at least one other entity. Use ENTITY_ID properties (auto-sync) or explicit relations
2. **Assuming profile slugs exist** — always call `GET /profiles` first; `deal` and custom types may not be in this workspace
3. **Using deprecated `type` field** — always `profileSlug`
4. **Treating `"proposed"` as an error** — it's a governance queue, not a failure
5. **Setting `source` manually to force governance** — governance is determined by your `agentUserId` and the whitelist, not `source`; just write and handle the response
6. **Using API key owner as userId** — always pass the real human user's ID in request bodies (the API key is often `system`)
7. **Skipping the search step** — always search before creating; duplicates degrade the graph
8. **Forgetting that `/channels/personal` needs `hub-protocol.write`** — it's a get-or-create, not a pure read
