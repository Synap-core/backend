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
        [SYNAP_WORKSPACE_ID, SYNAP_USER_ID, SYNAP_DEFAULT_CHANNEL_ID]
    primaryEnv: SYNAP_HUB_API_KEY
    homepage: https://synap.live
    capabilities: [memory, knowledge-graph, channels]
    os: [macos, linux, windows]
    userInvocable: false
---

# Synap — core data operations

You are connected to a **Synap Data Pod** at `{SYNAP_POD_URL}`. All requests use `Authorization: Bearer {SYNAP_HUB_API_KEY}`.

**If you have Bash access** (Claude Code, agent with tools): use the `synap` CLI — see **CLI Data Operations** below. Auth is automatic, `--json` gives clean output, no manual header management.

**If you only have HTTP access**: use the REST endpoints documented below. Your `userId` is in `{SYNAP_USER_ID}` (set by `synap connect`). If it's missing, call `GET /api/hub/users/me` → `.id` once.

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

## Quick reference — 90% of tasks in 30 lines

```bash
# CLI (preferred — auth automatic, --json = clean output)
synap orient --json                                    # discover userId + workspaces
synap use <workspace-name-or-id>                       # set active workspace
synap create entity --profile=task --name="…" --props='{"status":"todo","priority":"high"}' --json
synap set entity <id> --props='{"status":"done"}' --json  # merge-patch (only changed keys)
synap search "query" --json
synap remember "fact about the user" --json
synap recall "query" --json
```

```bash
# REST (when no Bash access)
POST   /api/hub/entities          body: { userId, workspaceId?, profileSlug, title, properties }
PATCH  /api/hub/entities/{id}     body: { userId, properties }   ← deep-merges, send only changed keys
POST   /api/hub/documents         body: { userId, workspaceId?, title, content, entityId? }
PATCH  /api/hub/documents/{id}    body: { userId, title?, content? }   ← full content replacement
POST   /api/hub/relations         body: { userId, sourceEntityId, targetEntityId, type }
GET    /api/hub/entities?q=…&profileSlug=task&workspaceId=…
GET    /api/hub/entities/{id}/connections?userId=…
POST   /api/hub/memory            body: { userId, fact }
GET    /api/hub/memory?userId=…&query=…
```

**Profile schemas are runtime-discovered — never hardcoded:**

```bash
synap discover --json            # CLI: full profile tree with property schemas + command map
synap discover --profiles --json # CLI: profiles only
```

```
GET /api/hub/discover?userId={userId}&workspaceId={workspaceId}
→ { profiles: [{ slug, displayName, scope, properties: [{ slug, type, options? }], createCommand }], commands: {...} }
```

Call this once at session start. The response includes every system profile and any custom workspace profiles the user has created, each with its full property schema. Use `createCommand` per profile as a copy-paste template. Do not rely on a static property list — it will drift.

**Load more detail on demand** (`GET /api/hub/skills/system?sections=<id>`):

| Section ID                | When to load                                           |
| ------------------------- | ------------------------------------------------------ |
| `synap:capture`           | User pastes multi-entity text (email, transcript, bio) |
| `synap:governance`        | Write was proposed or denied; need to explain policy   |
| `synap:linking`           | Custom relation types, auto-sync edge cases            |
| `synap-ui:SKILL`          | Building views, bento dashboards, workspaces           |
| `synap-ui:view-types`     | Specific view type config shapes                       |
| `synap-ui:widget-catalog` | Available widget kinds and their configSchema          |
| `synap-schema:SKILL`      | Creating custom profiles or property definitions       |

## Synap-first operating mode

> **MCP clients** (Claude Desktop, Raycast, OpenClaw with MCP): use `synap_*` tool names — they wrap auth and governance automatically. **REST / HTTP clients**: use the endpoints below.

These five rules override default assistant behavior when connected to a Synap pod:

**1. Orient before acting**  
Run `scripts/orient.sh` or call these endpoints at the start of every session — before searching, before creating, before answering any question about the user's data:

```
GET /api/hub/manifest
  → static capability map: view types, bento block kinds, inline patterns, browser-native cells

GET /api/hub/users/me
  → { id, email, name }                         ← your userId

GET /api/hub/workspaces
  → [{ id, name, role }]                        ← workspaces[0].id if only one

GET /api/hub/discover?userId={userId}&workspaceId={workspaceId}
  → { profiles: [{ slug, displayName, scope, properties, createCommand }], commands: {...} }
  ← replaces /profiles — includes property schemas + custom workspace profiles
```

`scope: "pod"` = visible across all workspaces (note, task, project, person, company, bookmark, event, contact, article, website).  
`scope: "workspace"` = scoped to one workspace (deal, file, capture, custom profiles).  
Each profile includes its full property schema. Use `createCommand` as a template.

**2. Search before answering**  
Before answering any question about the user's projects, tasks, contacts, decisions, or anything they might have captured — search Synap first. Do not answer from your training or context window when Synap may have the authoritative answer.

**3. Save proactively — without waiting to be asked**  
When the user shares a decision, task, meeting outcome, contact, or any durable information: save it. Don't ask "should I save this?" for obviously important information. Use:

- entities for structured data (tasks, people, projects, decisions)
- `remember_fact` / `POST /api/hub/memory` for preferences, context, loose facts
- documents for long-form notes (meeting notes, research, writeups)

**4. Link everything**  
An isolated entity has no value in a knowledge graph. When creating entities, immediately link them to related entities. A task belongs to a project. A note belongs to a meeting or a person. A decision belongs to a project and may supersede another decision.

**5. Persist facts, not just conversation**  
Facts about the user — preferences, team, working style, recurring context — belong in Synap memory, not in your context window. Memory survives sessions and is accessible across all AI surfaces. Context does not.

Properties with `valueType: "entity_id"` are typed links to other entities — see **Linking** below.

## CLI Data Operations (Bash tool)

When Claude Code (or any agent with Bash access) is using this skill, prefer the `synap` CLI over raw HTTP calls — auth is automatic, output is clean JSON, no spinners in `--json` mode.

**Session context — set once, never repeat:**

The CLI reads the active pod and workspace from `~/.synap/config.json`. Set context once at the start of a session; all subsequent commands inherit it automatically. Do NOT pass `--pod-url`, `--api-key`, or `--workspace` on every command.

```bash
synap pods use <profile-name>          # switch active pod
synap use <workspace-id>               # switch active workspace
synap workspace provision-agent --json # provision your agent workspace + auto-sets it active
```

**Always orient first:**

```bash
synap orient --json
# Returns: userId, podUrl, workspaces[{id, name, slug}]
# Never hardcode workspace IDs — discover them here.
```

**Search (Typesense-powered, cross-collection):**

```bash
synap search "project ideas" --json
synap search "Antoine" --type=entity --workspace=<id> --json
synap search "meeting notes" --type=doc --limit=5 --json
# Omit --workspace to search pod-wide. Include it to scope to one workspace.
# Use search for name/keyword queries. For semantic/conceptual search, use Hub Protocol memory endpoints.
```

**Read entities:**

```bash
synap list workspaces --json
synap list entities --workspace=<id> --json
synap list entities --profile=task --workspace=<id> --json
synap get entity <id> --json
```

**Episodic memory (session facts, loose context):**

```bash
synap remember "Key decision: use Typesense for search" --json
synap recall "Typesense" --limit=5 --json
```

**Structured knowledge (durable, typed, searchable — preferred for engineering learnings):**

```bash
# Capture a gotcha, lesson, decision, or reference into your agent workspace
synap capture --type gotcha --claim "Hono static routes must come before /:id" \
  --why "First-match routing; dynamic routes eat static ones" \
  --tags "repo:synap-backend,layer:routing" --json

synap capture --type lesson --claim "code-read ≠ runtime-true for library APIs" \
  --evidence "tldraw 2.4.6 binding API changed silently from props.start.boundShapeId"

# Recall across your knowledge base with full-text search
synap recall "hono routing" --structured --json
synap recall "tldraw" --structured --type gotcha --json

# Prerequisite (run once): provision your agent workspace and set it active
synap workspace provision-agent --json
```

`synap capture` / `synap recall --structured` uses the `engineering_knowledge` entity profile.
`synap remember` / `synap recall` (without `--structured`) uses the ephemeral `/memory` store.
Use structured knowledge for anything worth remembering across sessions and projects.

**Write:**

```bash
synap create entity --profile=note --name="Meeting notes" --workspace=<id> --json
synap set entity <id> --props='{"status":"done"}' --json
```

**Multi-agent:** If `SYNAP_AGENT` env var is set, the CLI uses that named identity's API key from `~/.synap/config.json` instead of the default pod credentials. Use `synap agents list` to see configured identities.

**Rules:**

- Always use `--json` when calling from code — clean stdout, no spinners, machine-parseable
- Run `synap orient` first to discover workspace IDs — never hardcode them
- Omit `--workspace` to operate pod-wide; include it to scope to a specific workspace
- `synap search` is Typesense (fast keyword/name search). Semantic search → Hub Protocol `GET /api/hub/memory?query=…`

---

## Scope — default pod-wide

**Default: pod-wide.** 13 of 17 system profiles (`note`, `task`, `project`, `event`, `person`, `contact`, `company`, `bookmark`, `article`, `website`, `decision`, `question`, `research`) are pod-scoped — entities you create show up in _every_ workspace the user owns. The backend handles this automatically when the profile is pod-scoped: you don't need to pass `workspaceId`.

**Scope a creation to one workspace only when:**

1. The user explicitly says "in my `X` workspace" / "inside this space".
2. You're inside a clear workspace context (the user is on a project page, discussing that project — new tasks go into that workspace).
3. The profile is workspace-scoped by definition (`deal`, `file`, `capture`, and custom profiles). The backend already uses the user's active workspace when you don't pass one — usually this is what you want.

**Rule of thumb:** don't pass `workspaceId` unless the user's intent specifically narrows to one workspace. A task the user dictates "from the couch" belongs to the whole pod, not to whichever workspace was last open.

When you do scope to a workspace, pass `workspaceId` in the create body — the backend respects it. Never pass `workspaceId: null` explicitly to force pod-wide; the profile's `entityScope` decides.

## The work flow — question → research → decision → action

AI-assisted work has a shape. When the user is actually _thinking about something_, it flows through four structural nodes. Each is a first-class entity. None of these are optional "nice-to-have" labels — they're the graph that makes the work _durable_ and transferrable between AIs.

| Stage       | Entity     | What it captures                                         | Typical trigger                                                    |
| ----------- | ---------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| Inquiry     | `question` | What the user is trying to figure out                    | "I'm wondering about X" / "Should we Y or Z?" / "What's the best…" |
| Exploration | `research` | Investigation: sources consulted, conclusion, confidence | Reading articles, comparing options, summarizing findings          |
| Resolution  | `decision` | What was chosen + rationale + alternatives               | "We decided to…" / "Let's go with…" / "I'm going with…"            |
| Execution   | `task`     | Concrete action items that follow the decision           | "Now I need to…" / "TODO: ship Y by…"                              |

**Link each stage to the next:**

- `question.answeredByDecisionId` → the decision that closed it
- `research.questionId` → the question it investigates
- `decision.projectId` → the project it affects (same for question / research)
- Use `POST /relations type=source` to link research to its sources (articles, websites, documents)

Traversing in either direction gives the user answers like:

- "What am I currently exploring about Project Eve?" → `GET /entities?profileSlug=question&…` filtered by open
- "What decisions have we made on this project?" → filtered by `projectId`
- "What was the research behind this decision?" → reverse-lookup from `decision` via the research entities that reference the same `projectId` and question

### When to create each

**`question` — substantive inquiries only.** The test: _would the user want to find this later?_ "What's the weather" = no, don't create. "Should we use LangGraph or CrewAI?" = yes, create. Casual chitchat never becomes a question.

**`research` — when you investigate.** Any time you go off and read articles / websites / past notes to answer something, that's research. Create the entity upfront (`status: "ongoing"`), link sources as you pull them (`POST /relations type=source`), set `conclusion` when you're done (`status: "concluded"`).

**`decision` — when the user picks a path.** Already covered in the memory-vs-entity section above. Link back to the question it answers (set `question.answeredByDecisionId`).

**`task` — when the decision implies concrete work.** Link with `projectId` if not already inferred.

### Worked example

User: _"I'm trying to figure out whether we should build our own orchestrator or standardize on OpenClaude's. Can you help me think through it?"_

1. Create the question:

   ```json
   POST /api/hub/entities
   { "profileSlug": "question",
     "title": "Build custom orchestrator or use OpenClaude native?",
     "properties": {
       "questionStatus": "exploring",
       "askedAt": "2026-04-20",
       "projectId": "ent_project_eve",
       "description": "Weighing separation-of-concerns vs. out-of-the-box capability."
     } }
   ```

2. As you investigate, create a research entity and link sources:

   ```json
   POST /api/hub/entities
   { "profileSlug": "research",
     "title": "LangGraph vs CrewAI capability survey",
     "properties": {
       "researchStatus": "ongoing",
       "questionId": "ent_question_1",
       "projectId": "ent_project_eve"
     } }

   POST /api/hub/relations
   { "sourceEntityId": "ent_research_1", "targetEntityId": "ent_article_langgraph_docs", "type": "source" }
   ```

3. When you reach a conclusion, update the research:

   ```json
   PATCH /api/hub/entities/ent_research_1
   { "properties": {
       "researchStatus": "concluded",
       "conclusion": "LangGraph separates orchestration brain from UX. CrewAI adds agent abstractions but couples to its runtime.",
       "researchConfidence": "high"
     } }
   ```

4. When the user picks, create a decision linked to the question:

   ```json
   POST /api/hub/entities
   { "profileSlug": "decision",
     "title": "Use LangGraph orchestrator over OpenClaude native",
     "properties": {
       "decisionStatus": "accepted",
       "decidedAt": "2026-04-22",
       "rationale": "Separates Orchestration Brain from UX.",
       "alternatives": "Standardize on OpenClaude's multi-agent logic.",
       "projectId": "ent_project_eve"
     } }

   PATCH /api/hub/entities/ent_question_1
   { "properties": {
       "questionStatus": "answered",
       "answeredByDecisionId": "ent_decision_1"
     } }
   ```

5. Tasks follow as usual, linked to the project.

**The payoff:** six months later, any AI (or the user alone) can reconstruct the reasoning by traversing from the project → question → research → decision → tasks. That's the durability Synap provides on top of chat.

### Creation is silent by default

Don't interrupt the conversation to ask "should I log this as a question?" — just do it and add a one-line trailer at the end of your response:

> (Logged as question on Project Eve. Review: https://studio.synap.live/proposals/…)

If the creation was auto-approved (entity.create is on the whitelist), there's no proposal; just show a link to the entity:

> (Logged as question → https://studio.synap.live/entities/ent_question_1)

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
{ "userId": "{userId}", "title": "…", "properties": { "status": "done" } }
```

**Properties are deep-merged — send only the keys you want to change.** An update with `{ "status": "done" }` leaves all other properties untouched. You never need to re-send the full properties object.

### Create a document (attach to an entity)

```json
POST /api/hub/documents
{
  "userId": "{userId}",
  "workspaceId": "{workspaceId}",
  "title": "Meeting notes — 2026-04-20",
  "content": "# Attendees\n- …\n\n# Decisions\n- …",
  "type": "markdown",              // "markdown" | "html" | "text" | "code"
  "entityId": "ent_event_..."      // attach to an entity for context
}
```

`type: "html"` stores self-contained HTML. The browser renders it via the `html-doc` cell in a sandboxed iframe. Use for AI-generated reports, rich visualisations, custom charts, or anything beyond markdown.

**Full HTML cell workflow** (AI → visible custom UI in any bento):

```json
// 1. Create the HTML document
POST /api/hub/documents
{ "userId": "{userId}", "workspaceId": "{workspaceId}",
  "title": "Q2 Revenue Report", "type": "html",
  "content": "<!DOCTYPE html><html>…</html>",
  "entityId": "ent_project_..." }
// → { "document": { "id": "doc_abc" }, ... }

// 2. Place the html-doc cell in any bento view
POST /api/hub/views/{bentoViewId}/arrange
{ "userId": "{userId}", "workspaceId": "{workspaceId}",
  "widgets": [
    { "id": "b1", "kind": "html-doc", "config": { "documentId": "doc_abc" },
      "layout": { "x": 0, "y": 0, "w": 8, "h": 6 } }
  ] }

// 3. Update the HTML (cell auto-refreshes)
PATCH /api/hub/documents/doc_abc
{ "userId": "{userId}", "content": "<!DOCTYPE html>…updated…</html>" }
```

The iframe uses `sandbox="allow-scripts"` — scripts run but have no same-origin access to the parent app. The HTML is fully isolated.

### Update a document (title and/or content)

```json
PATCH /api/hub/documents/{documentId}
{
  "userId": "{userId}",
  "title": "Updated title",          // optional
  "content": "# Full replacement\n…" // full string — not a diff
}
```

Content is a **full replacement**, not a patch. Fetch the current content first if you want to append: `GET /api/hub/documents/{id}?userId={userId}` → `.content`, append, then PATCH.

The reverse lookup is `entities WHERE documentId = ?`. Always attach the document to a meaningful entity (the meeting event, the project, the person) — a floating document is another orphan.

### Store a fact (memory) — use sparingly

```json
POST /api/hub/memory
{ "userId": "{userId}", "fact": "User prefers async communication over meetings" }
```

Always auto-approved. **Memory is for loose, unstructured, hard-to-title facts only.** The seductive thing about memory is it has zero friction — no dedup, no linking, no proposals. That makes it easy to misuse.

**The test:** if the user later asked "show me all X," can memory answer? Memory can only keyword-match — it has no structure. So:

| Input                                                   | Use                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| "User prefers async communication"                      | memory — it's a preference                                      |
| "Garage code is 4321"                                   | memory — throwaway fact                                         |
| "Should we use LangGraph or CrewAI for Eve?"            | **entity `question`** — substantive inquiry, start of flow      |
| "Here's what I found comparing LangGraph and CrewAI…"   | **entity `research`** — investigation with sources + conclusion |
| "We decided to use LangGraph over OpenClaude's native…" | **entity `decision`** — has title, rationale, project           |
| "Key insight: tasks need better retry logic"            | **entity `note` with tag "insight"** + link to project          |
| "John is now head of engineering at Acme"               | **update `contact` entity** — that's a property change          |
| "Launch date moved to May 15"                           | **update `project` entity** — change the startDate              |
| "Action item from meeting: ship MVP by Friday"          | **entity `task`** linked to the `event` (meeting)               |
| "Agreed with Sarah: we'll split backend & frontend"     | **entity `decision`** linked to Sarah + the project             |

**Rule of thumb:** if it has a title-worthy noun OR context to link to (a project, a person, a meeting) OR a lifecycle (status/supersession) — it's an entity, not memory. Memory is the fallback, not the default.

**For decisions specifically** — use the `decision` system profile:

```json
POST /api/hub/entities
{
  "userId": "{userId}",
  "profileSlug": "decision",
  "title": "Use LangGraph orchestrator over OpenClaude native",
  "properties": {
    "decisionStatus": "accepted",
    "decidedAt": "2026-04-20",
    "summary": "Dedicated orchestrator service; OpenClaude CLI as UX",
    "rationale": "Separates the Orchestration Brain (LangGraph) from the UX (OpenClaude CLI).",
    "alternatives": "Standardize entirely on OpenClaude's multi-agent logic.",
    "projectId": "ent_project_eve"
  }
}
```

This creates a first-class decision entity linked to Project Eve. It shows up in traversals, can be superseded later (`supersededBy: newDecisionId`), and survives governance. Memory can't do any of that.

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
# Keyword search across everything (entities, documents, views, threads)
GET /api/hub/search?query={query}&userId={SYNAP_USER_ID}&workspaceId={id}

# Entities of a specific type (q= is the param for entities endpoint)
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

## CRM Workspaces — 4-Entity Model

Some workspaces use a CRM data structure with four entities: `person` and `company` (identity records), `deal` (pipeline record), and `client` (post-win relationship marker). Understand this pattern when proposing lead captures, deal updates, or campaign membership.

**The model:**

- **`person` + `company`** — Identity only, no sales state. Persist across deals.
- **`deal`** — Pipeline record with `dealStage` property (lead, contacted, qualifying, proposal, negotiating, won, lost, inactive). Represents what people often call a "lead" (when stage=lead). Linked to person/company via `linked_to_deal` relation.
- **`client`** — Post-win relationship marker. Created automatically when deal transitions to stage=won. Status: active, paused, or churned. Linked via `is_client` (party → client) and `produced_by_deal` (deal → client).
- **`journey`** — Documents anchored to a deal (not a person). Linked via `has_journey`.

**AI behavior — lead capture:**

When the user describes a lead (inbound person, prospect, or company lead), propose the full bundle:

1. Create `person` entity (if not exists) with email, role, company name
2. Create `company` entity (if not exists)
3. Create `deal` entity with `dealStage: "lead"` and `estimatedValue` (if known)
4. Create `linked_to_deal` relation connecting person/company to deal

Never create a person with a sales-state flag. The deal is the lead container.

```json
POST /api/hub/entities
{ "userId": "{userId}", "workspaceId": "{wsId}",
  "profileSlug": "person",
  "title": "Alice Johnson",
  "properties": { "email": "alice@acme.com", "role": "VP Engineering" }
}

POST /api/hub/entities
{ "userId": "{userId}", "workspaceId": "{wsId}",
  "profileSlug": "deal",
  "title": "Acme prospect",
  "properties": { "dealStage": "lead", "estimatedValue": 50000 }
}

POST /api/hub/relations
{ "userId": "{userId}",
  "sourceEntityId": "ent_person_alice",
  "targetEntityId": "ent_deal_acme",
  "type": "linked_to_deal"
}
```

**AI behavior — moving deals to won:**

When a deal transitions to `dealStage: "won"`, also propose client creation if not yet linked:

```json
PATCH /api/hub/entities/ent_deal_acme
{ "properties": { "dealStage": "won" } }

POST /api/hub/entities
{ "userId": "{userId}", "workspaceId": "{wsId}",
  "profileSlug": "client",
  "title": "Acme (active)",
  "properties": { "clientStatus": "active" }
}

POST /api/hub/relations
{ "userId": "{userId}",
  "sourceEntityId": "ent_person_alice",
  "targetEntityId": "ent_client_acme",
  "type": "is_client"
}

POST /api/hub/relations
{ "userId": "{userId}",
  "sourceEntityId": "ent_deal_acme",
  "targetEntityId": "ent_client_acme",
  "type": "produced_by_deal"
}
```

**AI behavior — campaign membership:**

When the user describes campaign members (segment for outreach, tracking, or automation), use polymorphic `member_of` relations. Members can be persons, companies, or deals:

```json
POST /api/hub/relations
{ "userId": "{userId}",
  "sourceEntityId": "ent_person_alice",
  "targetEntityId": "ent_campaign_enterprise",
  "type": "member_of"
}

// Same relation type, different entity type
POST /api/hub/relations
{ "userId": "{userId}",
  "sourceEntityId": "ent_deal_acme",
  "targetEntityId": "ent_campaign_enterprise",
  "type": "member_of"
}
```

**Property names:**

- `dealStage` (not `crmStatus` or `status`) — values: lead, contacted, qualifying, proposal, negotiating, won, lost, inactive
- `clientStatus` (post-win only) — values: active, paused, churned
- Identities (person, company) carry no sales state

**Why separate identity from state:**

This model enables renewals (new deal linking to existing client), multi-stakeholder deals (multiple `linked_to_deal` relations per deal), campaigns with mixed entity types (persons + companies + deals as members), and clean churn tracking. It matches Synap's core pattern: entities + relations = graph.

## Common mistakes

1. **Creating orphan entities.** Always connect to at least one other entity on creation. Search first; if nothing links, reconsider whether this should be memory.
2. **Guessing profile slugs.** Always `GET /profiles` first. `deal`, `capture`, and custom profiles may not exist in this workspace.
3. **Using the deprecated `type` field.** Always `profileSlug`.
4. **Treating `"proposed"` as an error.** It's a governance queue.
5. **Forcing `source` to bypass governance.** Governance is determined by the agent user + whitelist, not by `source`. Don't set it.
6. **Not knowing your userId.** Use `{SYNAP_USER_ID}` from the env (set by `synap connect`). Or call `GET /api/hub/users/me` → `.id` once and cache it. Never hardcode or guess.
7. **Skipping the search step.** Duplicates degrade the graph more than missing data.
8. **Forgetting that `GET /channels/personal` needs `hub-protocol.write`** scope — it's get-or-create, not a pure read.

## AI Inline Patterns — reference entities in your replies

When the user is interacting with Synap's AI Companion (the in-browser chat panel), you can embed **inline chips** directly in your reply text. These render as clickable buttons the user can tap to open entities, views, or documents without leaving the conversation.

### Syntax

| Pattern                      | Renders as                  | Effect                            |
| ---------------------------- | --------------------------- | --------------------------------- |
| `[[entity:UUID\|Name]]`      | Purple entity chip          | Opens entity detail in side panel |
| `[[view:UUID\|Name]]`        | Blue view chip              | Opens view                        |
| `[[open:side\|view:UUID]]`   | Amber "Open in side" button | Opens view in side panel          |
| `[[open:main\|view:UUID]]`   | Amber "Open" button         | Opens view in main panel          |
| `[[open:side\|entity:UUID]]` | Amber "Open in side" button | Opens entity in side panel        |
| `[[run:UUID\|Label]]`        | Green "Run" button          | Navigates to automation entity    |
| `[[doc:UUID\|Name]]`         | Gray doc chip               | Opens document                    |

### Rules

- **Always use real IDs.** Never hallucinate UUIDs. Only emit patterns for entities/views you just created or retrieved via Hub Protocol.
- **Emit after creation.** When you create a view or entity, immediately reference it: `"Created your pipeline → [[view:abc123|Active Tasks]]"`
- **Prefer side panel.** Use `[[open:side|view:UUID]]` so the user keeps their current context.
- **Only in Companion replies.** These patterns are silently ignored in non-companion channels, documents, and memory. Do not use them there.
- **Combine with prose.** Don't lead with a chip — embed it naturally: `"Here are your open deals → [[view:xyz|Deals Pipeline]] · [[open:side|view:xyz]]"`

## When you need more

- Linking conventions, auto-sync table, relation types → **`linking.md`**
- Full governance whitelist, proposal lifecycle, agent users → **`governance.md`**
- Unstructured capture pipeline → **`capture.md`**
- Extending the data model (new profiles, new properties) → install the **`synap-schema`** skill
- Building views, dashboards, and bento layouts → install the **`synap-ui`** skill

## ViewFrame Cells — Custom View Generation

ViewFrame is the standard way to create custom data visualizations in Synap. Use it whenever an existing cell (table, kanban, list, chart) does not cover the needed chart type, 3D layout, map, or bespoke AI-generated UI.

### When to Use ViewFrame

| Situation                                                              | Action                        |
| ---------------------------------------------------------------------- | ----------------------------- |
| An existing cell or view type covers the need                          | Use the existing cell or view |
| User asks for a specific chart type, map, 3D scene, or custom layout   | Generate a ViewFrame widget   |
| User says "show X as a [funnel / heatmap / treemap / scatter / globe]" | Generate a ViewFrame widget   |

### What ViewFrame Is

- A sandboxed iframe that renders any ES module (React component or plain JS module)
- Dependencies resolved at runtime via **esm.sh import maps** — no build step
- The host injects a `SynapWidget` bridge for data access (same postMessage protocol as iframe widgets)
- Security: `sandbox="allow-scripts allow-modals allow-popups"`, no `allow-same-origin`, no cookies, no pod token

### Register a Widget via the Hub Protocol

List installed widgets:

```
GET /api/hub/widget-definitions?workspaceId={workspaceId}
Authorization: Bearer {SYNAP_HUB_API_KEY}
```

Install a new ViewFrame widget (creates a proposal for user review):

```
POST /api/hub/widget-definitions
Authorization: Bearer {SYNAP_HUB_API_KEY}
Content-Type: application/json

{
  "userId": "{SYNAP_USER_ID}",
  "workspaceId": "{workspaceId}",
  "typeKey": "deal-stage-funnel",
  "name": "Deal Stage Funnel",
  "description": "Funnel chart of deal pipeline stages",
  "rendererType": "iframe",
  "rendererSource": "<full HTML document — see template below>",
  "defaultSize": { "w": 8, "h": 6 },
  "category": "visualization"
}
```

`typeKey` must be kebab-case matching `/^[a-z][a-z0-9-]+$/`. Use a descriptive name specific to the widget's content.

The response carries `status: "ok"` (installed immediately) or `status: "proposed"` (queued for user review — surface `reviewUrl` to the user).

### The SynapWidget Bridge (inside the iframe)

`window.SynapWidget` is injected automatically — do NOT import or `<script>` it.

```js
SynapWidget.onInit(async ({ config, context }) => {
  // context: { workspaceId, viewId?, entityId?, sdkVersion }
  const items = await SynapWidget.query("list_entities", {
    profileSlug: "deal", // or 'task', 'person', 'company', any custom slug
    limit: 200,
  });
  render(items ?? []);
  SynapWidget.resize(document.body.scrollHeight);
});
```

All `query()` calls return a Promise. Entity shape: `{ id, title, profileSlug, properties, createdAt, … }`.

Navigation and notifications:

```js
SynapWidget.navigate({ entityId: "entity-uuid" }); // opens entity detail
SynapWidget.toast("Done!", "success"); // 'success' | 'error' | 'info'
```

### Common Dependency Patterns (esm.sh import map)

```html
<script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@19",
      "react-dom/client": "https://esm.sh/react-dom@19/client",
      "react/jsx-runtime": "https://esm.sh/react@19/jsx-runtime",
      "recharts": "https://esm.sh/recharts@2.12.0"
    }
  }
</script>
```

Common library choices:

| Category | Packages                                                       |
| -------- | -------------------------------------------------------------- |
| Data viz | `recharts@2.12.0`, `d3@7`, `chart.js@4`, `observable-plot@0.6` |
| Tables   | `@tanstack/react-table@8`                                      |
| 3D       | `three@0.165.0`, `@react-three/fiber@8`, `@react-three/drei@9` |
| Maps     | `leaflet@1.9.4`, `react-leaflet@4`                             |

### Minimal Widget Template

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * {
        box-sizing: border-box;
        margin: 0;
      }
      body {
        font-family: -apple-system, sans-serif;
        padding: 16px;
        background: transparent;
      }
    </style>
    <script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@19",
          "react-dom/client": "https://esm.sh/react-dom@19/client",
          "react/jsx-runtime": "https://esm.sh/react@19/jsx-runtime"
        }
      }
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import { createRoot } from "react-dom/client";

      SynapWidget.onInit(async ({ context }) => {
        const items = await SynapWidget.query("list_entities", {
          profileSlug: "deal",
          limit: 200,
        }).catch(() => []);

        // Build your UI here. Plain DOM or React both work.
        document.getElementById("root").textContent =
          `Loaded ${(items ?? []).length} deals`;

        SynapWidget.resize(document.body.scrollHeight);
      });
    </script>
  </body>
</html>
```

### Rules

- **Always call `SynapWidget.onInit()`** — the host will not send data until you register this handler.
- **Call `SynapWidget.resize()`** after rendering to prevent clipping.
- **Handle errors** — `query()` can fail; always `.catch()`.
- **Transparent background** — `background: transparent` on `body` inherits the host surface color.
- **No external fetch** — the sandbox has no cross-origin access; all data must go through `SynapWidget`.
- **Inline all styles** — no external CSS imports; CDN JS via import map is fine.

---

## Authentication

```
Authorization: Bearer {SYNAP_HUB_API_KEY}
X-Workspace-Id:  {workspaceId}            (optional; also pass in body/query)

Scopes:
  hub-protocol.read   → most GET endpoints
  hub-protocol.write  → all writes AND GET /channels/personal
```
