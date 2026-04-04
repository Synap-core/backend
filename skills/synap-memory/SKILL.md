---
name: synap-memory
description: >
  Structured knowledge graph for AI agents. Store entities, documents, and
  facts in PostgreSQL. Search, link, and govern all AI writes.
version: 1.0.0
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
    primaryEnv: SYNAP_HUB_API_KEY
    emoji: "\U0001F9E0"
    homepage: https://synap.live/openclaw
    capabilities:
      - memory
      - knowledge-graph
    os:
      - macos
      - linux
      - windows
user-invocable: false
---

# Synap Memory — OpenClaw Skill

You are connected to a **Synap pod** at `{SYNAP_POD_URL}`. You have structured,
persistent, sovereign memory. Unlike flat text files, your memory is a typed
knowledge graph with entities, relationships, and full-text + semantic search.
Your user ID is `{SYNAP_AGENT_USER_ID}` and your workspace is
`{SYNAP_WORKSPACE_ID}`.

Your knowledge graph is stored in PostgreSQL with Typesense full-text search and
pgvector semantic search. Every write goes through Synap's governance system —
some operations auto-approve, others create proposals for the user to review.
You never lose data, and you never need to organize it manually.

---

## Setup

### Automatic setup (recommended)

When provisioned via the Synap admin panel or control plane, set two bootstrap
variables. All other configuration is pulled automatically on startup:

```
SYNAP_HUB_API_KEY   = hub_xxxx                                                          # Hub Protocol API key (shown once at provision)
SYNAP_CONFIG_URL    = https://pod.synap.live/trpc/intelligenceRegistry.getServiceConfig   # Config pull endpoint
```

OpenClaw fetches its full config on startup:

```bash
# Called automatically by the skill on boot — no manual step needed
curl -X POST "$SYNAP_CONFIG_URL" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
# Returns: { "result": { "data": { "json": { "SYNAP_POD_URL": "...", "SYNAP_WORKSPACE_ID": "...", "SYNAP_AGENT_USER_ID": "..." } } } }
```

The response is merged into the runtime environment — no restart required.

### Manual setup

If installing without the provisioning flow, set all variables explicitly:

```
SYNAP_HUB_API_KEY    = hub_xxxx                      # Hub Protocol API key
SYNAP_POD_URL        = https://pod.synap.live         # Your Synap pod URL
SYNAP_WORKSPACE_ID   = <uuid>                         # Your workspace ID
SYNAP_AGENT_USER_ID  = <uuid>                         # Your agent user ID in Synap
```

All API calls use Bearer token authentication:

```
Authorization: Bearer {SYNAP_HUB_API_KEY}
Content-Type: application/json
```

> **Important**: The key must have `hub-protocol.read` AND `hub-protocol.write` scopes.
> Keys created by the Synap control plane (`/openclaw/register`) have both scopes.
> Keys created manually in Settings → API Keys must have both scopes explicitly set.

---

## Data Model — Four Knowledge Primitives

### Entities

Typed objects with a name, a profile type, and structured properties. Entities
are the fundamental unit of knowledge — anything with identity lives here.

| System Profile | Use for                              | Key Properties               |
| -------------- | ------------------------------------ | ---------------------------- |
| `note`         | Unstructured knowledge               | content, tags                |
| `task`         | Actionable work items                | status, priority, dueDate    |
| `project`      | Containers and groupings             | status, tags                 |
| `event`        | Time-bound occurrences               | startDate, endDate, location |
| `person`       | Individuals                          | email, phone                 |
| `contact`      | Business contacts (extends person)   | role                         |
| `company`      | Organizations                        | website, industry, employees |
| `deal`         | Sales opportunities                  | stage, value, closeDate      |
| `bookmark`     | Web references                       | url, domain, source          |
| `article`      | Published content (extends bookmark) | author, publishedAt          |
| `file`         | File attachments                     | fileName, mimeType, fileSize |

Profiles can be extended. A "lead" extends `person`. A "webinar" extends `event`.
Use `list_profiles` to discover what exists, and `create_profile` to define new types.

### Documents

Long-form Markdown content. Use for reports, summaries, analysis, meeting notes,
specs, or anything that deserves more than a property field. Documents can be
attached to entities or standalone.

Content is full Markdown — headings, lists, tables, code blocks.

### Facts (Memory)

Atomic pieces of knowledge stored in long-term memory. Facts are lightweight and
searchable — use them for preferences, decisions, context that should persist
across sessions.

Examples: "Marc prefers email over Slack", "Budget for Q3 is $50K",
"API key rotation happens on the 1st of each month".

### Relations

Typed connections between entities. Build the knowledge graph by linking entities
together. Relation types: `related`, `parent`, `child`, `belongs-to`.

---

## Decision Tree — When to Use What

| Situation                                     | Action                                                           | Primitive             |
| --------------------------------------------- | ---------------------------------------------------------------- | --------------------- |
| "Remember that Marc prefers email over Slack" | `POST /api/hub/memory`                                           | Fact                  |
| "Create a task to follow up with Marc"        | `POST /api/hub/entities` with profileSlug=task                   | Entity                |
| "Write a summary of today's meeting"          | `POST /api/hub/documents`                                        | Document              |
| "Marc works at Acme Corp"                     | Create person + company entities, then `POST /api/hub/relations` | Entities + Relation   |
| "What do I know about Marc?"                  | `GET /api/hub/search?query=Marc`                                 | Search (always first) |
| "Link these two projects together"            | `POST /api/hub/relations`                                        | Relation              |
| "Track this article for later"                | `POST /api/hub/entities` with profileSlug=bookmark or article    | Entity                |

---

## Search-First Pattern

**ALWAYS search before creating.** This prevents duplicates.

```
1. GET /api/hub/search?query=Acme+Corp&userId=...&workspaceId=...&limit=5
   → found: entity id = "abc-123", type = "company"
   → use PATCH /api/hub/entities/abc-123 to update, NOT POST /api/hub/entities to create

2. GET /api/hub/search?query=Acme+Corp&userId=...&workspaceId=...&limit=5
   → no results
   → safe to POST /api/hub/entities to create
```

Also search memory before storing a new fact:

```
1. GET /api/hub/memory?userId=...&query=Marc+preferences
   → found: "Marc prefers email over Slack"
   → no need to store again (or update if changed)
```

---

## Governance

Every write operation is evaluated against the workspace permission policy.

### Auto-approved (no proposal needed):

- All reads and searches
- Memory recall (`GET /api/hub/memory`)
- Memory storage (`POST /api/hub/memory`)
- Profile creation (`POST /api/hub/profiles`)
- Property definition creation (`POST /api/hub/property-defs`)

### May create a proposal (user approval needed):

- Entity creation (`POST /api/hub/entities`)
- Entity updates (`PATCH /api/hub/entities/:id`)
- Document creation (`POST /api/hub/documents`)
- Relation creation (`POST /api/hub/relations`)
- Relation deletion (`DELETE /api/hub/relations/:id`)

### Every write returns one of:

- `{ "status": "approved", ... }` — executed immediately
- `{ "status": "proposed", "proposalId": "..." }` — queued for user approval
- `{ "status": "denied", "reason": "..." }` — blocked by policy

### When you receive `status: "proposed"`:

1. Inform the user: "I've requested [action] but it needs your approval in Synap."
2. Do NOT retry the same call — the proposal is already queued.
3. Continue with other tasks if possible.

### When you receive `status: "denied"`:

1. Respect the decision — do NOT retry.
2. Inform the user if relevant.

### Auto-approve configuration (optional):

Workspaces that trust OpenClaw fully can add actions to `autoApproveFor` in
workspace settings:

```json
{ "autoApproveFor": ["entity.create", "document.create", "relation.create"] }
```

Auto-approved actions are still audited — a record is kept in the proposals table
with status `auto_approved`.

---

## API Reference

The Hub Protocol has two types of endpoints:

All endpoints are **REST** at `{SYNAP_POD_URL}/api/hub/*`.
Authentication: `Authorization: Bearer {SYNAP_HUB_API_KEY}` on every request.

---

### Reading Data (auto-approved)

#### Search workspace

Full-text search across all entities and documents.

```
GET {SYNAP_POD_URL}/api/hub/search?userId={SYNAP_AGENT_USER_ID}&workspaceId={SYNAP_WORKSPACE_ID}&query=Marc&limit=10
```

#### Get entity by ID

```
GET {SYNAP_POD_URL}/api/hub/entities/<entityId>?userId={SYNAP_AGENT_USER_ID}&workspaceId={SYNAP_WORKSPACE_ID}
```

Returns: name, profileSlug, properties, timestamps, documentId (if attached).

#### List entities (with type filter)

```
GET {SYNAP_POD_URL}/api/hub/users/{SYNAP_AGENT_USER_ID}/entities?workspaceId={SYNAP_WORKSPACE_ID}&type=task&limit=50
```

#### Get document content

```
GET {SYNAP_POD_URL}/api/hub/documents/<documentId>?userId={SYNAP_AGENT_USER_ID}
```

Returns: title, content (Markdown), timestamps.

#### List available entity types (profiles)

```
GET {SYNAP_POD_URL}/api/hub/profiles?userId={SYNAP_AGENT_USER_ID}&workspaceId={SYNAP_WORKSPACE_ID}
```

Returns all profiles (system + custom) with their property definitions.

#### Get relations for an entity

```
GET {SYNAP_POD_URL}/api/hub/relations?userId={SYNAP_AGENT_USER_ID}&workspaceId={SYNAP_WORKSPACE_ID}&entityId=<uuid>
```

Returns all relations (inbound + outbound) for the entity.

#### Get workspace context (recent activity)

```
GET {SYNAP_POD_URL}/api/hub/users/{SYNAP_AGENT_USER_ID}/context?workspaceId={SYNAP_WORKSPACE_ID}
```

Returns: recent entities, open views, workspace summary.

#### Traverse the knowledge graph

```
GET {SYNAP_POD_URL}/api/hub/graph/traverse?userId={SYNAP_AGENT_USER_ID}&startEntityId=<uuid>&maxDepth=2
```

BFS traversal from a starting entity. Returns all reachable entities within
maxDepth hops (max 3). Use to explore the neighborhood of any entity.

---

### Memory — Facts

#### Store a fact

```
POST {SYNAP_POD_URL}/api/hub/memory
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "fact": "Marc prefers email over Slack for async communication",
  "confidence": 0.9
}
```

Facts are auto-approved. The `embedding` field is optional — if omitted, the
server generates a zero vector and the fact is still searchable by keyword.
If you have an embedding model, you can pass `"embedding": [0.01, -0.03, ...]`
(1536-dim float array) for better semantic search ranking.

#### Search facts by keyword

```
GET {SYNAP_POD_URL}/api/hub/memory?userId={SYNAP_AGENT_USER_ID}&query=Marc+preferences&limit=10
```

Returns matching facts ranked by keyword relevance.

#### Semantic search for facts

```
POST {SYNAP_POD_URL}/api/hub/memory/search
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "embedding": [0.01, -0.03, ...],
  "limit": 10
}
```

Cosine-distance search using a pre-computed embedding vector. Use when keyword
search is too narrow.

#### Delete a fact

```
DELETE {SYNAP_POD_URL}/api/hub/memory/<fact-id>?userId={SYNAP_AGENT_USER_ID}
```

---

### Writing Data (governed — may create proposals)

#### Create entity

```
POST {SYNAP_POD_URL}/api/hub/entities
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "profileSlug": "task",
  "title": "Follow up with Marc",
  "properties": {
    "status": "todo",
    "priority": "high",
    "dueDate": "2026-04-10"
  },
  "reasoning": "User asked to track follow-up"
}
```

Always use `profileSlug` (not the deprecated `type` field). Call `list_profiles`
first to find the right profile. If no suitable profile exists, create one with
`POST /api/hub/profiles`, then create the entity.

**Property value conventions:**

| Type           | Format                   | Example                  |
| -------------- | ------------------------ | ------------------------ |
| `text`         | String                   | `"Acme Corp"`            |
| `select`       | Option value (not label) | `"in_progress"`          |
| `multi_select` | Array of option values   | `["urgent", "client"]`   |
| `date`         | ISO 8601 date            | `"2026-03-15"`           |
| `datetime`     | ISO 8601 datetime        | `"2026-03-15T10:00:00Z"` |
| `boolean`      | Boolean                  | `true`                   |
| `number`       | Number (no quotes)       | `42`                     |
| `email`        | Email string             | `"marc@acme.com"`        |
| `url`          | URL string               | `"https://acme.com"`     |
| `relation`     | Target entity UUID       | `"abc-123"`              |

#### Update entity

```
PATCH {SYNAP_POD_URL}/api/hub/entities/<entityId>
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "properties": {
    "status": "done"
  },
  "reasoning": "Task completed per user confirmation"
}
```

Updates merge properties — you only need to pass the fields that changed.

#### Create document

```
POST {SYNAP_POD_URL}/api/hub/documents
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "title": "Q1 Sales Summary",
  "content": "# Q1 Sales Summary\n\n## Key Metrics\n\n- Revenue: $1.2M\n- New customers: 47\n...",
  "reasoning": "User requested quarterly summary"
}
```

Content is full Markdown. Use headings, lists, tables, and code blocks.

#### Create relation (link entities)

```
POST {SYNAP_POD_URL}/api/hub/relations
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "sourceEntityId": "<uuid>",
  "targetEntityId": "<uuid>",
  "type": "related",
  "reasoning": "Marc works at Acme Corp"
}
```

Relation types: `related`, `parent`, `child`, `belongs-to`.

#### Delete relation

```
DELETE {SYNAP_POD_URL}/api/hub/relations/<relationId>
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "agentUserId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "reasoning": "Relationship no longer valid"
}
```

#### Create new entity type (profile — auto-approved)

```
POST {SYNAP_POD_URL}/api/hub/profiles
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "name": "Lead",
  "slug": "lead",
  "parentProfileId": "<parent-profile-uuid>",
  "description": "Sales lead contact"
}
```

Slugs must be lowercase and hyphenated: `crm-contact`, `sales-opportunity`.
`parentProfileId` is the UUID of the parent profile — call `GET /api/hub/profiles`
first to find the ID. Always extend a system base type when the concept is a
specialization (a "lead" IS a person, a "webinar" IS an event).

#### Add property definition to a profile (auto-approved)

```
POST {SYNAP_POD_URL}/api/hub/property-defs
{
  "userId": "{SYNAP_AGENT_USER_ID}",
  "workspaceId": "{SYNAP_WORKSPACE_ID}",
  "profileId": "<uuid>",
  "name": "Company",
  "slug": "company",
  "valueType": "string"
}
```

Valid `valueType` values: `string`, `number`, `boolean`, `date`, `entity_id`,
`array`, `object`, `secret`.

For `select`/`multi_select` types, include a `config` object with `options`:

```json
{
  "valueType": "string",
  "config": {
    "options": [
      { "value": "lead", "label": "Lead", "color": "#94a3b8" },
      { "value": "customer", "label": "Customer", "color": "#22c55e" }
    ]
  }
}
```

---

## Error Handling

| HTTP Status | Meaning                    | Action                                               |
| ----------- | -------------------------- | ---------------------------------------------------- |
| 200         | Success                    | Process response normally                            |
| 401         | Invalid or expired API key | Check `SYNAP_HUB_API_KEY` is correct                 |
| 403         | Insufficient scopes        | Key needs `hub-protocol.read` + `hub-protocol.write` |
| 404         | Resource not found         | Entity/document/relation does not exist              |
| 429         | Rate limited               | **Wait 60 seconds** before any retry                 |
| 500         | Server error               | Log and retry once after 30 seconds                  |

**`status: "proposed"` in response body is NOT an error.** It means the write
was accepted and is queued for user approval. Do not retry.

**`status: "denied"` is NOT an error.** It is a governance decision. Do not retry.

---

## Best Practices

1. **Search before creating** — always check if the entity/fact already exists
   to prevent duplicates. This is your most important habit.

2. **Use specific entity types** — store a person as `person`, not `note`. Store
   a company as `company`, not `bookmark`. The type system enables structured
   queries and views.

3. **Store atomic facts** — for preferences, decisions, and contextual knowledge
   that should persist across sessions, use `POST /api/hub/memory`. Embedding is
   optional — omit it and the server handles it. Facts are lightweight and
   always auto-approved.

4. **Use relations to connect entities** — when two entities are related (person
   works at company, task belongs to project), create a relation. This builds
   the knowledge graph and enables graph traversal.

5. **Include `reasoning`** — all write operations accept an optional `reasoning`
   field. Use it to explain why you're making the change. This creates an audit
   trail and helps users understand proposals.

6. **Batch related operations** — when creating a person + their company + the
   relation between them, do all three in sequence. Don't create orphaned
   entities.

7. **Read before updating** — always fetch an entity or document before updating
   it. For documents, `update_document` replaces the full content (not a diff),
   so you need the current content first.

8. **Respect governance responses** — when you get `"proposed"`, tell the user
   and move on. When you get `"denied"`, respect it. Never retry either.

9. **Use graph traversal for context** — when exploring what's connected to an
   entity, use `GET /api/hub/graph/traverse` to walk the knowledge graph up to 3
   hops deep.

10. **Profile inheritance** — extend system base types instead of creating root
    profiles. A "webinar" should extend `event`, a "lead" should extend
    `person`. Only create root profiles for genuinely new concepts.

---

## Quick Reference

```bash
# Search workspace
curl "$SYNAP_POD_URL/api/hub/search?userId=$SYNAP_AGENT_USER_ID&workspaceId=$SYNAP_WORKSPACE_ID&query=meeting+notes&limit=10" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY"

# Create entity
curl -X POST "$SYNAP_POD_URL/api/hub/entities" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"'$SYNAP_AGENT_USER_ID'","agentUserId":"'$SYNAP_AGENT_USER_ID'","workspaceId":"'$SYNAP_WORKSPACE_ID'","profileSlug":"task","title":"Follow up with Marc","properties":{"status":"todo","priority":"high"},"reasoning":"User requested task"}'

# Store a fact
curl -X POST "$SYNAP_POD_URL/api/hub/memory" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"'$SYNAP_AGENT_USER_ID'","fact":"Marc prefers email over Slack","confidence":0.9}'

# Search facts
curl "$SYNAP_POD_URL/api/hub/memory?userId=$SYNAP_AGENT_USER_ID&query=Marc+preferences&limit=10" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY"

# List profiles
curl "$SYNAP_POD_URL/api/hub/profiles?userId=$SYNAP_AGENT_USER_ID&workspaceId=$SYNAP_WORKSPACE_ID" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY"

# Create relation
curl -X POST "$SYNAP_POD_URL/api/hub/relations" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":"'$SYNAP_AGENT_USER_ID'","agentUserId":"'$SYNAP_AGENT_USER_ID'","workspaceId":"'$SYNAP_WORKSPACE_ID'","sourceEntityId":"<uuid>","targetEntityId":"<uuid>","type":"related","reasoning":"Person works at company"}'

# Graph traversal
curl "$SYNAP_POD_URL/api/hub/graph/traverse?userId=$SYNAP_AGENT_USER_ID&startEntityId=<uuid>&maxDepth=2" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY"

# Get workspace context
curl "$SYNAP_POD_URL/api/hub/users/$SYNAP_AGENT_USER_ID/context?workspaceId=$SYNAP_WORKSPACE_ID" \
  -H "Authorization: Bearer $SYNAP_HUB_API_KEY"
```

---

_synap-memory skill v1.0.0 — maintained at github.com/synap-app/synap-backend/tree/main/skills/synap-memory_
