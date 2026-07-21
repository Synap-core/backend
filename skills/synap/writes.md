## Core writes

**Two write doors, one gradient.** `create_entity` is for exactly ONE
fully-structured, typed entity you already have. For anything unstructured,
several entities, or a graph — or **when in doubt** — use the capture door
(`synap_capture`, see `capture.md`): precision comes from sending more structure
in the SAME call, never from picking a different tool or a second commit step.

### Create an entity (one exact typed entity)

Before this call, use `/discover?userId=…&profileSlugs=<kind>` to read the
real fields, required/default values, constraints and reference targets. Omit
`workspaceId` for the pod/base schema and normal profile placement; pass it
only when the user or routing decision explicitly selected that workspace.

```json
POST /api/hub/entities
{
  "userId": "{userId}",
  "profileSlug": "task",          // from /discover — never guess
  "title": "Weekly team sync",
  "description": "Recurring planning sync",
  "properties": { "status": "todo", "dueDate": "2026-07-21" },
  "content": "# Agenda\n- Priorities\n- Risks",
  "projectId": "{existingProjectId}",
  "source": "agent"
}
```

The response has legacy `status`/`id` fields plus `writeReceipt`:
`pending`/`proposed` means a proposal exists and no entity is live yet;
`applied` means the reported direct write completed; `partial` means a follow-up
(for example a facet) failed after the entity applied. **A `proposed`/`pending`
receipt is a governed success, not an error** — surface its `reviewUrl`, never
claim completion, and only enrich again when the receipt identifies a real
missing fact.

For several entities, creation-time roles/facets, or relations that need one
review, send the whole graph through the capture door (`synap_capture` with
`entities[]` + `relations[]`) instead of sequencing independent creates. It is
ONE governed call: policy auto-applies when every op is safe, otherwise the
whole graph is proposed (atomic). There is no separate commit step.

**Name-refs, not UUIDs.** Reference an existing project by name — the server
resolves it against the caller's own projects (exact match files there; no match
proposes, never mis-files). Never ask the user for a UUID.

**Dedup is advisory across kinds.** Strong signals (`email`/`phone`/`website` —
not a bare `url`) dedup within a kind; a same-title hit in a _different_ kind
comes back as an advisory candidate, never an auto-merge. "No exact match" is not
"safe to create" when advisory candidates are returned — review them first.

### Update an entity

```json
PATCH /api/hub/entities/{entityId}
{ "userId": "{userId}", "title": "…", "properties": { "status": "done" } }
```

**Properties are deep-merged — send only the keys you want to change.** An update with `{ "status": "done" }` leaves all other properties untouched. You never need to re-send the full properties object.

### Authored text is content, not a `file`

Something **you** author — a pitch deck, a strategic plan, a note body — is
**never** a `file`- or `document`-kind entity. Create it as the right CONTENT
kind (`note`, `knowledge`, or a fitting domain kind) with `content` set to the
Markdown body; Synap **auto-materializes** that `content` into a real
versioned document behind the scenes (`entities WHERE documentId = ?`) — no
upload step needed. `file` is reserved for real uploaded bytes you actually
have (the upload door / `synap upload`) — an agent has no filesystem, so it
rarely touches `file` at all. Reach for `synap_create_document` /
`POST /api/hub/documents` directly only for a standalone rich document that
isn't itself a title-worthy entity (see below) — never as a substitute for an
entity's `content`.

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

### Remember a fact about the user — use sparingly

A fact _about the user_ goes through `remember_fact` (CLI: `synap capture --type
observation`). It writes a governed `user_observation` — not an ungoverned
throwaway row: a fact the user explicitly stated auto-approves; a fact you
inferred returns `proposed` (normal — surface the review link). Because it's a
real entity it's addressable, linkable and revertible.

**Use it only for loose, unstructured, hard-to-title facts about the user** — a
stated preference, a throwaway detail. Everything with a title-worthy noun or
something to link to is an ENTITY through the capture door, not an observation.

**The test:** if the user later asked "show me all X," could a loose observation
answer? It can only keyword-match — it has no structure. So:

| Input                                                   | Use                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| "User prefers async communication"                      | observation — it's a preference                                 |
| "Garage code is 4321"                                   | observation — throwaway fact                                    |
| "Should we use LangGraph or CrewAI for Eve?"            | **entity `question`** — substantive inquiry, start of flow      |
| "Here's what I found comparing LangGraph and CrewAI…"   | **entity `research`** — investigation with sources + conclusion |
| "We decided to use LangGraph over OpenClaude's native…" | **entity `decision`** — has title, rationale, project           |
| "Key insight: tasks need better retry logic"            | **entity `note` with tag "insight"** + link to project          |
| "John is now head of engineering at Acme"               | **update `contact` entity** — that's a property change          |
| "Launch date moved to May 15"                           | **update `project` entity** — change the startDate              |
| "Action item from meeting: ship MVP by Friday"          | **entity `task`** linked to the `event` (meeting)               |
| "Agreed with Sarah: we'll split backend & frontend"     | **entity `decision`** linked to Sarah + the project             |

**Rule of thumb:** if it has a title-worthy noun OR context to link to (a project, a person, a meeting) OR a lifecycle (status/supersession) — it's an entity through the capture door, not an observation. A user observation is the fallback, not the default.

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
