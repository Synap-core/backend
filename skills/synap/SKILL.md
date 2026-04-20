---
name: synap
description: >
  Use this skill whenever the user wants to capture, remember, find, or structure
  information in their Synap data pod. Triggers: creating a task, note, person,
  company, project, event, contact, or deal; saving an article or webpage;
  storing a fact about someone ("Alice prefers async"); searching the user's
  knowledge ("find my notes on X", "who did I meet last week"); linking entities;
  logging a meeting or a contact; capturing unstructured text into structured
  entities; reading what's in the user's pod before answering questions about
  their life, work, or projects; posting to their personal AI channel. The pod
  is the user's sovereign source of truth — prefer it over your own context
  when the user asks about their own data. Do NOT use this skill for extending
  the schema (use synap-schema) or building dashboards and views (use synap-ui).
metadata:
  openclaw:
    requires:
      env: [SYNAP_HUB_API_KEY, SYNAP_POD_URL]
      optional_env:
        [SYNAP_WORKSPACE_ID, SYNAP_AGENT_USER_ID, SYNAP_DEFAULT_CHANNEL_ID]
    primaryEnv: SYNAP_HUB_API_KEY
    homepage: https://synap.live
    capabilities: [memory, knowledge-graph, channels]
    os: [macos, linux, windows]
    userInvocable: false
---

# Synap — core data operations

You are connected to a **Synap Data Pod** at `{SYNAP_POD_URL}`. All requests use `Authorization: Bearer {SYNAP_HUB_API_KEY}`.

Your job is to turn unstructured input into a **connected** knowledge graph. Isolated entities are anti-value. Every entity you create should link to at least one other entity.

## Mental model

Synap is a typed knowledge graph. Six layers you need:

| Layer         | What it is                                     | When to use                                              |
| ------------- | ---------------------------------------------- | -------------------------------------------------------- |
| **Entities**  | Typed structured nodes (task, person, …)       | Anything worth filtering, sorting, or linking            |
| **Relations** | Typed edges between entities                   | Making the graph traversable                             |
| **Documents** | Long-form markdown attached to an entity       | Meeting notes, research writeups, articles               |
| **Memory**    | Atomic facts, no structure                     | Preferences, context, ephemeral notes                    |
| **Threads**   | Channel conversations, optional entity context | Posting to the user's personal AI channel                |
| **Proposals** | Writes queued for human approval               | Governance for some mutations (not an error — see below) |

## Orient first (always)

Never assume workspace state. Profiles, scopes, and members vary per installation.

Run `scripts/orient.sh` (in this skill directory) or call these three endpoints:

```
GET /api/hub/users/me
  → { id, email, name }                         ← your userId

GET /api/hub/workspaces
  → [{ id, name, role }]                        ← workspaces[0].id if only one

GET /api/hub/profiles?userId={userId}&workspaceId={workspaceId}
  → [{ slug, displayName, entityScope,
       properties: [{ slug, valueType, targetProfileSlug? }] }]
```

`entityScope: "pod"` = visible across all workspaces (note, task, project, person, company, bookmark, event, contact, article, website).
`entityScope: "workspace"` = scoped to one workspace (deal, file, capture, custom profiles).

Properties with `valueType: "entity_id"` are typed links to other entities — see **Linking** below.

## Scope — default pod-wide

**Default: pod-wide.** 10 of 14 system profiles (`note`, `task`, `project`, `event`, `person`, `contact`, `company`, `bookmark`, `article`, `website`) are pod-scoped — entities you create show up in _every_ workspace the user owns. The backend handles this automatically when the profile is pod-scoped: you don't need to pass `workspaceId`.

**Scope a creation to one workspace only when:**

1. The user explicitly says "in my `X` workspace" / "inside this space".
2. You're inside a clear workspace context (the user is on a project page, discussing that project — new tasks go into that workspace).
3. The profile is workspace-scoped by definition (`deal`, `file`, `capture`, and custom profiles). The backend already uses the user's active workspace when you don't pass one — usually this is what you want.

**Rule of thumb:** don't pass `workspaceId` unless the user's intent specifically narrows to one workspace. A task the user dictates "from the couch" belongs to the whole pod, not to whichever workspace was last open.

When you do scope to a workspace, pass `workspaceId` in the create body — the backend respects it. Never pass `workspaceId: null` explicitly to force pod-wide; the profile's `entityScope` decides.

## Linking — the core principle

**Never create orphan entities.** A task alone is near-useless. A task linked to a project, an assignee, and the source document shows up in traversals, context panels, and downstream queries.

Two ways to connect. Pick one:

**Way 1 — entity_id properties (fast path, auto-syncs).** Set the property when creating the entity. For system profiles this auto-creates a row in the relations table.

```json
POST /api/hub/entities
{
  "userId": "{userId}",
  "workspaceId": "{workspaceId}",
  "profileSlug": "task",
  "title": "Design new onboarding flow",
  "properties": {
    "status": "todo",
    "priority": "high",
    "projectId": "ent_abc",    // auto-creates belongs_to_project relation
    "assignee":  "usr_def"     // auto-creates assigned_to relation
  }
}
```

**Way 2 — explicit relations.** For custom links, after-the-fact connections, or anything without a matching entity_id property.

```json
POST /api/hub/relations
{
  "userId": "{userId}",
  "sourceEntityId": "ent_task",
  "targetEntityId": "ent_document",
  "type": "references"
}
```

For auto-sync mapping, conventional relation types, and edge cases, read **`linking.md`**.

## Writing — governance in one paragraph

Every write returns a `status` field:

```
"approved"  → done, use { id }
"proposed"  → queued for user approval; response also carries { proposalId, summary, reasoning, reviewPath, reviewUrl } — surface the link
"denied"    → blocked, explain reason to user
```

**`"proposed"` is not an error.** It's the governance system queueing your change. When you get it:

1. Tell the user exactly what was queued — use the `summary` field **verbatim**. Don't paraphrase.
2. Give them the link to review — `reviewUrl` opens the proposal in Synap Studio. Show the link as-is.
3. Move on with the conversation. Don't wait or poll.

Example response to the user:

> I queued **Delete task "Q2 plan review"** for your review. Destructive actions need your approval. Open it: https://studio.synap.live/proposals/prp_abc

Auto-approved by default (for agent API keys): `entity.create`, `entity.update`, `document.create`, `relation.create`, `view.create`, `profile.create`, `property_def.create`, `channel.create`, `memory.*`, all reads. Destructive actions (`delete`, `archive`, `purge`) always propose in agent-owned workspaces.

For the full whitelist, agent-user semantics, and workspace overrides, read **`governance.md`**.

## Core writes

### Create an entity (always with links)

```json
POST /api/hub/entities
{
  "userId": "{userId}",
  "workspaceId": "{workspaceId}",
  "profileSlug": "task",          // from /profiles — never guess
  "title": "Weekly team sync",
  "properties": { "status": "todo", "projectId": "ent_..." }
}
```

### Update an entity

```json
PATCH /api/hub/entities/{entityId}
{ "title": "…", "properties": { "status": "done" } }
```

### Create a document (markdown, attached to an entity)

```json
POST /api/hub/documents
{
  "userId": "{userId}",
  "workspaceId": "{workspaceId}",
  "title": "Meeting notes — 2026-04-20",
  "content": "# Attendees\n- …\n\n# Decisions\n- …",
  "entityId": "ent_event_..."    // attach to an entity for context
}
```

The reverse lookup is `entities WHERE documentId = ?`. Always attach the document to a meaningful entity (the meeting event, the project, the person) — a floating document is another orphan.

### Store a fact (memory)

```json
POST /api/hub/memory
{ "userId": "{userId}", "fact": "User prefers async communication over meetings" }
```

Always auto-approved. Use for preferences and ephemeral context that don't deserve structure. If the fact is about a specific person/thing, prefer creating or updating an entity instead.

### Post to the user's personal channel

```
GET  /api/hub/channels/personal?userId={userId}&workspaceId={workspaceId}
       → { id, name, … }       (get-or-create, needs hub-protocol.write scope)

POST /api/hub/threads/{threadId}/messages
       { "userId": "{userId}", "role": "user", "content": "…" }
```

## Reading

Graph-based, not semantic. Type filter → relations → neighborhood.

```
# Keyword search across everything
GET /api/hub/search?q={query}&workspaceId={id}

# Entities of a specific type
GET /api/hub/entities?q={query}&profileSlug={slug}&workspaceId={id}

# Recent entities
GET /api/hub/entities?sort=updatedAt:desc&limit=20&workspaceId={id}

# The full connected neighborhood of an entity (prefer this)
GET /api/hub/entities/{id}/connections?userId={userId}&workspaceId={id}
  → { connections: [{ entityId, entity, label, direction,
                      source: "graph"|"property"|"thread" }],
      counts: { total, graph, structural, threads } }

# BFS traversal (expensive at depth 3+)
GET /api/hub/graph/traverse?entityId={id}&maxDepth=2&workspaceId={id}

# Memory facts (keyword)
GET /api/hub/memory?userId={userId}&query={keywords}
```

No SQL joins. The graph is the join.

## Multi-entity capture from free-form text

When the user pastes a block of unstructured content (a meeting transcript, an email, a LinkedIn bio), use the capture pipeline instead of chaining manual creates:

```
POST /api/hub/capture/structure   → returns proposals + relations
POST /api/hub/capture/execute     → commits (after user confirms)
```

The pipeline extracts multiple entities with their relations in one LLM call. Read **`capture.md`** for the full flow.

## Worked examples

### Example 1 — "Remind me to send the proposal to Acme on Friday"

1. Search for the Acme entity: `GET /entities?q=Acme&profileSlug=company` → got `ent_acme`
2. Search for an existing task: `GET /entities?q=proposal&profileSlug=task&workspaceId=…` → none
3. Create the task with links:

   ```json
   POST /api/hub/entities
   { "userId": "{userId}", "workspaceId": "{wsId}",
     "profileSlug": "task",
     "title": "Send proposal to Acme",
     "properties": {
       "status": "todo", "priority": "high",
       "dueDate": "2026-04-24"
     }
   }
   ```

4. Link to Acme (Acme is not an entity_id property on task — use Way 2):

   ```json
   POST /api/hub/relations
   { "userId": "{userId}",
     "sourceEntityId": "ent_new_task",
     "targetEntityId": "ent_acme",
     "type": "related_to" }
   ```

5. Confirm: "Task created and linked to Acme, due Friday."

### Example 2 — "Who's Sarah at Acme?"

1. Search person: `GET /entities?q=Sarah&profileSlug=person` → `ent_sarah`
2. Pull her connections: `GET /entities/ent_sarah/connections` → company=Acme, 3 recent emails, 1 meeting
3. Answer from the returned data, not from your own context.

### Example 3 — "Save this article for later: https://…"

1. Search for existing bookmark: `GET /entities?q=<url>&profileSlug=article` → none
2. Create an article entity:

   ```json
   POST /api/hub/entities
   { "userId": "{userId}", "workspaceId": "{wsId}",
     "profileSlug": "article",
     "title": "<page title>",
     "properties": { "url": "<url>", "domain": "<host>" }
   }
   ```

3. If the user said why ("interesting for the onboarding project"), also create a relation to that project — never drop the reason as a plain comment, turn it into a link.

## Common mistakes

1. **Creating orphan entities.** Always connect to at least one other entity on creation. Search first; if nothing links, reconsider whether this should be memory.
2. **Guessing profile slugs.** Always `GET /profiles` first. `deal`, `capture`, and custom profiles may not exist in this workspace.
3. **Using the deprecated `type` field.** Always `profileSlug`.
4. **Treating `"proposed"` as an error.** It's a governance queue.
5. **Forcing `source` to bypass governance.** Governance is determined by the agent user + whitelist, not by `source`. Don't set it.
6. **Using the API key owner as `userId`.** Always pass the real human userId — the API key is often owned by a system/agent user.
7. **Skipping the search step.** Duplicates degrade the graph more than missing data.
8. **Forgetting that `GET /channels/personal` needs `hub-protocol.write`** scope — it's get-or-create, not a pure read.

## When you need more

- Linking conventions, auto-sync table, relation types → **`linking.md`**
- Full governance whitelist, proposal lifecycle, agent users → **`governance.md`**
- Unstructured capture pipeline → **`capture.md`**
- Extending the data model (new profiles, new properties) → install the **`synap-schema`** skill
- Building views, dashboards, and bento layouts → install the **`synap-ui`** skill

## Authentication

```
Authorization: Bearer {SYNAP_HUB_API_KEY}
X-Workspace-Id:  {workspaceId}            (optional; also pass in body/query)

Scopes:
  hub-protocol.read   → most GET endpoints
  hub-protocol.write  → all writes AND GET /channels/personal
```
