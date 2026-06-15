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
