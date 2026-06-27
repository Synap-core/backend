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

---

## Mental model

Synap is a typed knowledge graph. **Reading is one verb (`synap ask`) — it routes for you.** Writing is where you must pick the right lane: the destination is decided by the **KIND** of knowledge, not by whichever workspace happens to be active.

### Where to write what — the three lanes (decide by KIND)

Ask yourself: _who does this knowledge serve?_ **There is no private AI scratchpad** — structuring knowledge into a real lane IS your job. Never write a `note` (that's the human's raw inbox); always `capture` into a lane.

| If it…                                                                                                                          | Lane                 | Where it goes                                                                            | Governance                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **is about the CURRENT WORK** — domain know-how for the project/task you're on (incl. a domain-specific gotcha/lesson/decision) | **Work** _(default)_ | a `knowledge` entity in the **active workspace** (`synap capture --type …`)              | proposal-gated (it's the user's real data; the workspace IS the domain — Builder ≠ marketing)              |
| **is GLOBAL truth** — a best-practice / runbook / how-to that holds across ALL projects                                         | **Global**           | pod-wide procedural `knowledge_keys` (`synap capture --global --type … [--key ns:slug]`) | reviewed for shared truth                                                                                  |
| **is about the USER** — how they work/talk/decide, their preferences, their life                                                | **User**             | pod-wide `user_observation` (`synap observe write` / `record_observation` tool)          | inferences are **proposed** (you review); explicit "I always X" auto-saves — never model the user silently |

> **Why this matters:** writing to the wrong lane degrades the graph. A gotcha you learned about the **current project** is **Work** (the active workspace — its domain). A best-practice that holds **everywhere** is **Global** (`--global`, pod-wide). A fact about **how the user works** is **User** (pod-wide, inferences proposed). `synap capture` echoes which lane + governance it used; check it.

> **Read the write outcome — it guides your next move (it never blocks you).** Every write (`capture`, `observe`, `create entity`, `create relation`, `note`) reports one of two outcomes (and `--json` carries `"outcome"`):
>
> - **`stored`** → it's **live now**, recallable via `synap ask`.
> - **`proposed`** → queued for the human's review, **like a git PR — not a failure, not a block.** Keep working: compose a whole graph of proposed changes in one session (reference the proposed entities, link them, add more) — they're staged together and go live when the human approves the batch. The only thing to remember: it's _under review_, so don't tell the user it's already applied. (Inferences about the user and writes to real workspaces are gated by design — expected, normal.)

> **Substrate names (tables under the hood):** _semantic_ = `entities` (the `knowledge` profile, workspace-scoped = domain separation), _episodic_ = `knowledge_facts`, _procedural_ = `knowledge_keys` (pod-wide runbooks). `ask` queries across them so you never pick on read.

### Data layers — the graph itself

| Layer         | What it is                                     | When to use                                              |
| ------------- | ---------------------------------------------- | -------------------------------------------------------- |
| **Entities**  | Typed structured nodes (task, person, …)       | Anything worth filtering, sorting, or linking            |
| **Relations** | Typed edges between entities                   | Making the graph traversable                             |
| **Documents** | Long-form markdown attached to an entity       | Meeting notes, research writeups, articles               |
| **Threads**   | Channel conversations, optional entity context | Posting to the user's personal AI channel                |
| **Proposals** | Writes queued for human approval               | Governance for some mutations (not an error — see below) |

### Key profiles for AI use

| Profile slug       | Scope     | Who writes     | Purpose                                                                                                                                                                                                                                       |
| ------------------ | --------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `note`             | pod       | **human only** | The human's raw "dump now, structure later" inbox. **The AI never writes a note** — structuring into a lane is its job; use `capture` instead.                                                                                                |
| `knowledge`        | workspace | AI             | Validated gotchas/lessons/decisions — the **Work lane** (default `synap capture --type`; ek_type/ek_claim/ek_why). DOMAIN = the workspace (a Builder gotcha ≠ a marketing one). Cross-project runbooks go to `knowledge_keys` via `--global`. |
| `user_observation` | pod       | AI only        | Durable user model — habits, communication style, preferences                                                                                                                                                                                 |
| `decision`         | pod       | human + AI     | Architectural decisions with rationale                                                                                                                                                                                                        |
| `research`         | pod       | AI             | Investigation with sources + conclusion                                                                                                                                                                                                       |
| `question`         | pod       | human + AI     | Open inquiry, closed when a decision answers it                                                                                                                                                                                               |

---

## Quick reference — 90% of tasks in 30 lines

```bash
# CLI (preferred — auth automatic, --json = clean output)
synap orient --json                                    # discover userId + workspaces
synap use <workspace-name-or-id>                       # set active workspace
synap create entity --profile=task --name="…" --props='{"status":"todo","priority":"high"}' --json
synap set entity <id> --props='{"status":"done"}' --json  # merge-patch (only changed keys)
synap ask "your question" --json                       # THE read verb — routes to the right store(s) + shows which answered
synap capture --type=lesson --claim="…" --json         # Work lane (default) — domain knowledge → active workspace
synap capture --global --type=reference --claim="…" --json  # Global lane — pod-wide cross-cutting runbook (knowledge_keys)
synap observe write "…" --json                          # User lane — durable user model (inferences proposed)
```

**The canonical verbs:** `ask` (read) · `capture` (structured write — pick a lane:
Work default / `--global` / `observe` for User) · `orient` (bootstrap). `note` exists
for the HUMAN's raw "dump now, structure later" inbox — **the AI always `capture`s
instead.** **Reading is one verb: `ask`** — it classifies your
question and routes across the three memory substrates (semantic = the typed entity
graph, procedural = how-to docs, episodic = raw captures), returning one answer
tagged with which substrate(s) answered (and which, if any, were unavailable). Don't
pick a store; `ask` picks for you and tells you what it did. (`graph` for an explicit
traversal and `get`/`show`/`browse` for direct lookups remain; there is no `search`
or `recall` — `ask` is the door.)

```bash
# REST (when no Bash access)
POST   /api/hub/entities          body: { userId, workspaceId?, profileSlug, title, properties }
PATCH  /api/hub/entities/{id}     body: { userId, properties }   ← deep-merges, send only changed keys
POST   /api/hub/documents         body: { userId, workspaceId?, title, content, entityId? }
PATCH  /api/hub/documents/{id}    body: { userId, title?, content? }   ← full content replacement
POST   /api/hub/relations         body: { userId, sourceEntityId, targetEntityId, type }
GET    /api/hub/entities?q=…&profileSlug=task&workspaceId=…
GET    /api/hub/entities/{id}/connections?userId=…
POST   /api/hub/knowledge/ask     body: { query, workspaceId?, limit? }   ← ONE read door, routes across substrates
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

---

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

**2. Ask before answering**  
Before answering any question about the user's projects, tasks, contacts, decisions, or anything they might have captured — `ask` Synap first (`synap ask "…"` / `POST /api/hub/knowledge/ask`). It routes across all three memory substrates in one call. Do not answer from your training or context window when Synap may have the authoritative answer.

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

---

## CLI Data Operations (Bash tool)

When Claude Code (or any agent with Bash access) is using this skill, prefer the `synap` CLI over raw HTTP calls — auth is automatic, output is clean JSON, no spinners in `--json` mode.

**Session context — set once, never repeat:**

The CLI reads the active pod and workspace from `~/.synap/config.json`. Set context once at the start of a session; all subsequent commands inherit it automatically. Do NOT pass `--pod-url`, `--api-key`, or `--workspace` on every command.

```bash
synap pods use <profile-name>          # switch active pod
synap use <workspace-id>               # switch active workspace (captures land here — it IS the domain)
```

**Always orient first:**

```bash
synap orient --json
# Returns: userId, podUrl, workspaces[{id, name, slug}]
# Never hardcode workspace IDs — discover them here.
```

**Ask (the one read verb — routes across all substrates):**

```bash
synap ask "project ideas" --json
synap ask "what did Antoine decide about auth" --workspace=<id> --json
synap ask "how do I deploy the backend" --json   # routes to procedural how-to docs
# Omit --workspace for pod-wide; include it to scope to one workspace.
# `ask` classifies intent and unions the right substrate(s) — it replaces search/recall.
```

**Read entities:**

```bash
synap list workspaces --json
synap list entities --workspace=<id> --json
synap list entities --profile=task --workspace=<id> --json
synap get entity <id> --json
```

**Capturing a decision (the AI structures — it never `note`s):**

```bash
synap capture --type decision --claim "Use Typesense for entity search" --json
# Retrieve later with the one read verb: synap ask "Typesense decision"
```

> `synap note` is the HUMAN's raw "dump now, structure later" inbox. As the AI, always `capture` into a lane — structuring is your job.

**Structured knowledge (durable, typed, searchable — preferred for engineering learnings):**

```bash
# Work lane (default): a domain gotcha/lesson/decision → knowledge entity in the ACTIVE workspace
synap capture --type gotcha --claim "Hono static routes must come before /:id" \
  --why "First-match routing; dynamic routes eat static ones" \
  --tags "repo:synap-backend,layer:routing" --json

synap capture --type lesson --claim "code-read ≠ runtime-true for library APIs" \
  --evidence "tldraw 2.4.6 binding API changed silently from props.start.boundShapeId"

# A quick decision-note is a typed knowledge entry (ek_type=decision):
synap capture --type decision --claim "Use Typesense for entity search" \
  --why "pgvector deferred to V1; Typesense ships now" --json

# Global lane: a runbook/best-practice that holds across ALL projects → pod-wide knowledge_keys
synap capture --global --type reference --claim "Always fix the canonical path, never a workaround" \
  --key "principle:root-cause" --json

# Retrieve any of it later with the one read verb (it spans every lane):
synap ask "hono routing gotcha" --json
```

`synap capture --type` writes a typed **`knowledge`** entity in the **active workspace** (the Work lane); `ek_type` (gotcha|lesson|decision|reference) discriminates the kind — **one store, type tags, not a residual dump**. It's workspace-scoped, so the active workspace supplies the domain — a Builder gotcha ≠ a marketing one (there is no `engineering_knowledge`). Add **`--global`** to write a pod-wide cross-cutting runbook to `knowledge_keys` instead. A formal **decision RECORD** (rationale, alternatives, superseded-by lifecycle) is a different artifact — use smart `synap capture "<free text>"` or `synap create entity --profile=decision`. Retrieve everything with `synap ask`.
Use `capture` for anything worth remembering across sessions and projects.

**Open (the one display door):**

```bash
synap open <id>                               # resolves type automatically, opens in browser
synap open entity <id>                        # open entity detail
synap open proposal <id>                      # open proposal review
synap open view <id>                          # open a view
synap open cell <typeKey>                     # open a registered cell by typeKey
synap open document <id>                      # open a document
```

The bare-ID form calls `GET /api/hub/resolve/:id` to determine the type before dispatching. Use this when you don't know what type a UUID is — `synap open <id>` always works.

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
- `synap ask` is the one read verb — it routes keyword + semantic + procedural automatically; you never choose a search backend.

---

---

## Scope — default pod-wide

**Default: pod-wide.** 13 of 17 system profiles (`note`, `task`, `project`, `event`, `person`, `contact`, `company`, `bookmark`, `article`, `website`, `decision`, `question`, `research`) are pod-scoped — entities you create show up in _every_ workspace the user owns. The backend handles this automatically when the profile is pod-scoped: you don't need to pass `workspaceId`.

**Scope a creation to one workspace only when:**

1. The user explicitly says "in my `X` workspace" / "inside this space".
2. You're inside a clear workspace context (the user is on a project page, discussing that project — new tasks go into that workspace).
3. The profile is workspace-scoped by definition (`deal`, `file`, `capture`, and custom profiles). The backend already uses the user's active workspace when you don't pass one — usually this is what you want.

**Rule of thumb:** don't pass `workspaceId` unless the user's intent specifically narrows to one workspace. A task the user dictates "from the couch" belongs to the whole pod, not to whichever workspace was last open.

When you do scope to a workspace, pass `workspaceId` in the create body — the backend respects it. Never pass `workspaceId: null` explicitly to force pod-wide; the profile's `entityScope` decides.

---

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

> (Logged as question on Project Eve. Review: synap://open/proposal/…)

If the creation was auto-approved (entity.create is on the whitelist), there's no proposal; just show a link to the entity:

> (Logged as question → synap://open/entity/ent_question_1)

---

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

---

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

### The `reasoning` field — required, structured, contextual

Every write call (create, update, delete) must include a `reasoning` field. This is what the governance reviewer reads to understand your decision. It is **not optional**.

Use this exact structure:

```
Context: [what the user said or what event triggered this write — one sentence]
Intent:  [what this entity or change accomplishes — one sentence]
Links:   [actual entity IDs or slugs this relates to, e.g. "ent_abc, ent_xyz"]
```

For updates, add:

```
Changed: [field] [old value] → [new value]
```

**Example (create):**

```
Context: User asked to track the Acme deal they mentioned in today's call.
Intent:  Creates a deal entity for Acme at lead stage linked to Alice Johnson.
Links:   ent_person_alice_johnson, ent_company_acme
```

**Example (update):**

```
Context: User confirmed the Acme deal moved to proposal stage.
Intent:  Advances the deal through the pipeline so it appears in the proposal view.
Links:   ent_deal_acme, ent_person_alice_johnson
Changed: dealStage lead → proposal
```

Rules:

- One sentence per field. No padding.
- `Links` must reference real entity IDs or slugs visible in the current context — not descriptions like "the related project".
- **"Agent requires proposal for all write operations."** is never acceptable as a `reasoning` value. That is an internal governance message, not agent reasoning. Write it and the proposal is meaningless to the reviewer.

Example response to the user:

> I queued **Delete task "Q2 plan review"** for your review. Destructive actions need your approval. Open it: synap://open/proposal/prp_abc

Auto-approved by default (for agent API keys): `entity.create`, `entity.update`, `document.create`, `relation.create`, `view.create`, `profile.create`, `property_def.create`, `channel.create`, `memory.*`, all reads. Destructive actions (`delete`, `archive`, `purge`) always propose in agent-owned workspaces.

For the full whitelist, agent-user semantics, and workspace overrides, read **`governance.md`**.

---

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

---

## Garden the graph — writes tell you their impact (the circling of action)

A write is no longer blind. When you create or update an entity, the response tells you what it did to the graph — **READ it and act**, so the graph stays connected instead of accumulating isolated, duplicated nodes.

**On create**, the response carries a `resolution` block:

- `existingSameProfile` — an entity with this exact name ALREADY exists as the same profile. Prefer **updating** it (`synap set entity <id>` · `PATCH /api/hub/entities/:id` · `update_entity`) over creating a duplicate.
- `autoConnected` — same-name entities of a DIFFERENT profile are facets of one real thing, and the system has already woven them together with a `same_subject` relation. Acknowledge it; add a more specific relation if the real relationship is narrower than "same subject".
- `suggestions` — entities worth linking. Create the relations that genuinely apply (`synap create relation` · `POST /api/hub/relations` · `create_relation`).

**On update**, the response carries an `impact` block — the entity's immediate relation neighbors. Read it and resolve secondary effects: supersede a now-stale entity, update its dependents, re-link.

**The circling of action** for any structural write (updating the vision, the architecture, a decision record, a codebase map):

1. **Write** — the response shows collisions + connections; don't ignore it.
2. **If it already exists** (`existingSameProfile`) → update it, don't duplicate.
3. **The same-name facets are auto-woven** (`autoConnected`) → extend the links where the relationship is more specific than `same_subject`.
4. **Act on `suggestions`** → link what genuinely relates.
5. **On update** → resolve the `impact` neighbors (supersede / update / re-link).

The principle: **more data is better when it is structured.** The graph now helps you keep it structured — never leave an entity isolated, never blindly overwrite. (Matching is exact-name today; it will deepen over time — so still link deliberately when you know two things relate but their names differ.)

---

## Decide the next action — advance the goal, don't just answer

You are an adjunct, not a reply box. A good assistant doesn't wait to be told the next step — after you answer, you ask **what is the highest-leverage next move toward the goal, and should I make it now?** — then you make it. Proactivity is this habit, run every turn; it is not a tone.

### The session is the spine of real work

A **focus session** is a goal-bound work room. It holds the goal, the promised outputs (deliverables), the tools/skills in play, and what's been produced so far — so it answers both _"where am I"_ and _"what am I working toward"_. Operate it with the triplet:

| Move                      | CLI                                      | REST                                        | IS tool          |
| ------------------------- | ---------------------------------------- | ------------------------------------------- | ---------------- |
| open a session            | `synap session start --goal "…"`         | `POST /api/hub/focus-sessions`              | `start_session`  |
| read it                   | `synap session get <id>`                 | `GET /api/hub/focus-sessions/:id`           | `get_session`    |
| see active ones           | `synap session list`                     | `GET /api/hub/focus-sessions?status=active` | `list_sessions`  |
| record progress / outputs | `synap session update <id> --progress N` | `PATCH /api/hub/focus-sessions/:id`         | `update_session` |

- If you're already in a session (or a `## Active Session` block is in your context) → that's your frame. Read its goal and the gap between _promised outputs_ and _what's produced_, and pursue that gap.
- If the user's intent is a **unit of work with a deliverable** (research, a plan, a build, an investigation) and no session is active → **open one** with a clear goal + expected outputs, so the work has a spine that accrues results. Don't open a session for a one-shot lookup or a casual reply.

### Decide ONE move, then make it

Pick the single highest-leverage next action toward the goal — not a checklist: answer · capture/structure what was said · create a task · link entities · advance or produce a promised deliverable · update the session's progress · propose an automation for a repeating pattern.

**Spin off a branch / sub-agent** when there's side-work that advances the goal but would **bloat the main channel** — e.g. "go find best practices for X", a deep research dive, a parallel investigation. Keep the main thread clean and let the branch do the heavy lifting and report back. Judge by complexity + channel hygiene, not by a fixed category.

**Land it through governance — act, don't just suggest.** When the move is clear, _make_ it: create the task, the research entity, the branch, the link, the session update. Every write passes through governance — it either auto-applies (safe, whitelisted writes) or becomes a one-click review. Either way, making the move is the safe path. Don't downgrade a clear next action into "you might want to…". Say _why_ in one line, then act.

**Reflect back into the session.** When work lands, update the session's progress and link what you produced — so the next turn reads a richer state and the loop compounds.

**Know when to stop.** When the promised outputs are produced and verified, the goal is done — say so and stop. Surface a _real_ next move when there is one; stay quiet when there isn't. Never manufacture busywork to seem active.

### The nudge vs. propose line

A concrete next action toward a _known_ goal → propose it (gated). A _speculative_ restructuring the user hasn't asked for (a new profile, a new view, splitting a workspace) → raise it as a question and let them decide.

### If you are a coding / terminal agent working _in_ a repo

Same habit, one addition: before you finish a piece of work, ask **"what's the next action, and what belongs in Synap?"** A decision you made, a gotcha you hit, a follow-up the work revealed, a task it spun off — capture it (`synap capture` / `synap note` / a task) and, when the work is a real unit, track it in a session. The point of the second brain is that the _next_ agent (or you, tomorrow) starts from what this turn learned instead of re-deriving it.

---

## Reading

**Start with `ask` — the one routed read door.** It classifies the question and
queries the right substrate(s) for you, returning a glass-box answer (which
substrates answered, which were unavailable, plus the engine's verdict). Reach for
the low-level doors below only when you deliberately want a single substrate or a
specific shape (a graph traversal, a typed-entity filter, an entity's neighborhood).

```
# THE read door — routes across semantic / procedural / episodic, tells you which answered
POST /api/hub/knowledge/ask   body: { query, workspaceId?, limit? }
  → { query, routedTo: [...], primary, answers: [{ substrate, items, status }], degraded, understanding, verdict }
```

Low-level doors (`ask` routes to these — graph-based, not semantic; type filter →
relations → neighborhood):

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

---

## Multi-entity capture from free-form text

When the user pastes a block of unstructured content (a meeting transcript, an email, a LinkedIn bio), use the capture pipeline instead of chaining manual creates:

```
POST /api/hub/capture/structure   → returns proposals + relations
POST /api/hub/capture/execute     → commits (after user confirms)
```

The pipeline extracts multiple entities with their relations in one LLM call. Read **`capture.md`** for the full flow.

---

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

---

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

---

## Common mistakes

1. **Creating orphan entities.** Always connect to at least one other entity on creation. Search first; if nothing links, reconsider whether this should be memory.
2. **Guessing profile slugs.** Always `GET /profiles` first. `deal`, `capture`, and custom profiles may not exist in this workspace.
3. **Using the deprecated `type` field.** Always `profileSlug`.
4. **Treating `"proposed"` as an error.** It's a governance queue.
5. **Forcing `source` to bypass governance.** Governance is determined by the agent user + whitelist, not by `source`. Don't set it.
6. **Not knowing your userId.** Use `{SYNAP_USER_ID}` from the env (set by `synap connect`). Or call `GET /api/hub/users/me` → `.id` once and cache it. Never hardcode or guess.
7. **Skipping the search step.** Duplicates degrade the graph more than missing data.
8. **Forgetting that `GET /channels/personal` needs `hub-protocol.write`** scope — it's get-or-create, not a pure read.

---

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

---

## Focus Sessions — Goal-Bound Work Rooms

A **focus session** is a named, multi-step work room where you and AI agents collaborate on a specific goal. Use one whenever the work has a clear end state, will take more than one exchange, or involves multiple agents.

**When to propose a session** (via the proposal system — always ask first):

- Research with 5+ sources → decision memo
- Lead generation sprint → qualified list + outreach drafts
- Incident investigation → postmortem doc
- Data import → structured knowledge base
- Any task you'd naturally call "a project" rather than "a question"

**How the AI proposes a session:**

```
create_proposal with targetType: "focus_session"
→ user reviews goal + rationale + expected outputs in ProposalReviewBoard
→ on approval, session is created in focus_sessions table
→ AI updates progress (0→100) via PATCH /api/hub/focus-sessions/:id { workspaceId, progress: N }
→ session auto-surfaces in the Active Sessions bento widget on the user's home
```

**Session templates** (pass as `templateId`):
`research-room` · `lead-sprint` · `decision-memo` · `import-cleanup` · `incident-room` · `campaign-intel`

**Hub Protocol REST** (for IS → backend; always include `workspaceId`):

- `POST /api/hub/focus-sessions` — create (include `correlationId` for idempotency)
- `GET /api/hub/focus-sessions/:id?workspaceId=<id>` — read
- `PATCH /api/hub/focus-sessions/:id` — update `{ workspaceId, progress, status, goal, agentIds }`

**CLI** (use when running as Claude Code / OpenClaw agent):

```bash
synap session start --goal "<goal>" [--workspace <id>]                 # create + start a session
synap session list [--workspace <id>] [--status active|paused|closed]  # list sessions
synap session get <id> [--workspace <id>]                               # read a session
synap session update <id> --workspace <id> --progress 50               # report progress
synap session update <id> --workspace <id> --status paused             # pause
synap session close <id> --workspace <id> [--recap "what was done"]    # close + recap
```

Note: `synap session start` creates a session directly (the agent-facing path). All hub-protocol writes are governance-gated server-side; the in-browser AI companion surfaces session creation through the proposal flow.

**Discoverability**: the `active-sessions` bento widget is on the default home dashboard. Sessions group their related proposals under a shared `correlationId` in the Proposal Review Board.

---

# Automations

Create workflow automations that trigger automatically based on events, schedules, or webhooks.

## Automation Structure

Every automation has:

1. **Trigger** (exactly one) — what starts the automation
2. **Steps** (one or more) — commands, conditions, delays, outputs connected in a flow

## Trigger Types

| Type      | Config                       | Example                              |
| --------- | ---------------------------- | ------------------------------------ |
| `event`   | `{ eventPattern, filters? }` | Entity created with specific profile |
| `cron`    | `{ expression }`             | Daily at 9am: `"0 9 * * *"`          |
| `webhook` | `{ webhookSubscriptionId }`  | External service sends data          |
| `manual`  | `{}`                         | User-triggered from UI               |

### Event Patterns

Format: `{subjectType}.{action}.completed`

Common patterns:

- `entity.create.completed` — entity created and persisted
- `entity.update.completed` — entity updated
- `entity.delete.completed` — entity deleted
- `document.create.completed` — document created
- `document.update.completed` — document updated

Filters narrow the event to specific conditions:

```json
{
  "eventPattern": "entity.create.completed",
  "filters": { "profileSlug": "task", "metadata.priority": "high" }
}
```

### Cron Expressions

Standard 5-field cron (minute hour day month weekday):

- `"0 9 * * *"` — daily at 9am
- `"0 9 * * MON"` — every Monday at 9am
- `"*/30 * * * *"` — every 30 minutes
- `"0 0 1 * *"` — first day of month at midnight

## Step Types

### command

Execute an intelligence command. Reference by `commandId` or describe inline.

```json
{
  "id": "extract",
  "type": "command",
  "data": {
    "commandTitle": "Extract key entities",
    "inputMapping": {
      "content": "{{trigger.payload.entity.content}}",
      "context": "{{trigger.payload.entity.name}}"
    }
  }
}
```

**Input mapping** uses template syntax:

- `{{trigger.payload.*}}` — data from the triggering event
- `{{steps.<stepId>.output.*}}` — output from a prior step
- `{{loop.item}}` — current item in a loop

### condition

Branch the flow based on a boolean expression.

```json
{
  "id": "check-priority",
  "type": "condition",
  "data": {
    "label": "High priority?",
    "expression": "trigger.payload.entity.metadata.priority === 'high'",
    "trueLabel": "Yes",
    "falseLabel": "No"
  }
}
```

Conditions have two output handles: `yes` and `no`. Connect subsequent steps to the appropriate handle.

### delay

Wait before continuing.

```json
{
  "id": "wait",
  "type": "delay",
  "data": { "duration": "5m", "label": "Cool down" }
}
```

Supported durations: `30s`, `5m`, `1h`, `1d`, `1w`.

### output

Terminal action — the end result of the automation.

```json
{
  "id": "notify",
  "type": "output",
  "data": {
    "label": "Send notification",
    "outputType": "notification",
    "config": {
      "message": "New high-priority task: {{trigger.payload.entity.name}}"
    }
  }
}
```

Output types:

- `notification` — in-app notification to the user
- `entity_create` — create a new entity (config: `{ profileSlug, title, properties }`)
- `entity_update` — update an existing entity (config: `{ entityId, properties }`)
- `webhook` — POST to external URL (config: `{ url, headers?, body }`)
- `channel_message` — post a message to a channel (config: `{ channelId, content }`)

### loop

Iterate over a collection from a prior step.

```json
{
  "id": "for-each-result",
  "type": "loop",
  "data": {
    "label": "For each search result",
    "iteratorExpression": "steps.search.output.results",
    "itemVariable": "item"
  }
}
```

Inside the loop, reference `{{loop.item}}` for the current element.

## Connecting Steps

Steps are connected via `dependsOn` (which step must complete first) and optional `conditionBranch` (which branch to follow from a condition).

```json
{
  "steps": [
    { "id": "check", "type": "condition", "data": {...} },
    { "id": "notify-high", "type": "output", "data": {...}, "dependsOn": ["check"], "conditionBranch": "yes" },
    { "id": "log-normal", "type": "output", "data": {...}, "dependsOn": ["check"], "conditionBranch": "no" }
  ]
}
```

## Discovering Commands

Before creating automations with command steps, call `list_commands` to discover available intelligence commands in the workspace. Use the command `id` in the step's `commandId` field.

If no suitable command exists, you can leave `commandId` empty and set `commandTitle` + `inputMapping` — the execution engine will use the title as a prompt template.

## Vault References

Automation configs that need secrets (API keys, auth tokens) should use vault references instead of hardcoded values:

- `vault://secret-uuid` — resolves to the full secret value at runtime
- `vault://secret-uuid/field-name` — resolves a specific field from a JSON secret

Only server-encrypted secrets can be resolved by the automation engine. The user must store the credential in the vault first.

## Best Practices

1. **Keep it simple** — Start with trigger → command → output. Add complexity only when needed.
2. **Name clearly** — Use descriptive labels: "When task created with high priority" not "Trigger 1".
3. **One purpose** — Each automation should do one thing well. Compose multiple automations rather than building one complex flow.
4. **Filter early** — Use trigger filters to avoid unnecessary execution. Don't use a condition step when a trigger filter suffices.
5. **Test first** — Create automations as `draft` status. Let the user review the flow visualization before activating.

## Example: Auto-archive completed tasks

```json
{
  "name": "Auto-archive completed tasks",
  "description": "When a task status changes to 'done', archive it after 24 hours",
  "trigger": {
    "type": "event",
    "config": {
      "eventPattern": "entity.update.completed",
      "filters": { "profileSlug": "task", "metadata.status": "done" }
    }
  },
  "steps": [
    {
      "id": "wait-24h",
      "type": "delay",
      "data": { "duration": "1d", "label": "Wait 24h" }
    },
    {
      "id": "archive",
      "type": "output",
      "data": {
        "label": "Archive task",
        "outputType": "entity_update",
        "config": {
          "entityId": "{{trigger.payload.entity.id}}",
          "properties": { "archived": true }
        }
      },
      "dependsOn": ["wait-24h"]
    }
  ]
}
```

## Example: Notify on high-priority tasks

```json
{
  "name": "High-priority task alerts",
  "description": "Send a notification when a high-priority task is created",
  "trigger": {
    "type": "event",
    "config": {
      "eventPattern": "entity.create.completed",
      "filters": { "profileSlug": "task" }
    }
  },
  "steps": [
    {
      "id": "check-priority",
      "type": "condition",
      "data": {
        "label": "High priority?",
        "expression": "trigger.payload.entity.metadata.priority === 'high'"
      }
    },
    {
      "id": "notify",
      "type": "output",
      "data": {
        "label": "Alert: high-priority task",
        "outputType": "notification",
        "config": {
          "message": "New urgent task: {{trigger.payload.entity.name}}"
        }
      },
      "dependsOn": ["check-priority"],
      "conditionBranch": "yes"
    }
  ]
}
```

---

## When you need more

- Linking conventions, auto-sync table, relation types → **`linking.md`**
- Full governance whitelist, proposal lifecycle, agent users → **`governance.md`**
- Unstructured capture pipeline → **`capture.md`**
- Extending the data model (new profiles, new properties) → install the **`synap-schema`** skill
- Building views, dashboards, and bento layouts → install the **`synap-ui`** skill

---

## ViewFrame Cells — Custom View Generation

ViewFrame is the standard way to create custom data visualizations in Synap. Use it whenever an existing cell (table, kanban, list, chart) does not cover the needed chart type, 3D layout, map, or bespoke AI-generated UI.

### When to Use ViewFrame

| Situation                                                              | Action                        |
| ---------------------------------------------------------------------- | ----------------------------- |
| An existing cell or view type covers the need                          | Use the existing cell or view |
| User asks for a specific chart type, map, 3D scene, or custom layout   | Generate a ViewFrame widget   |
| User says "show X as a [funnel / heatmap / treemap / scatter / globe]" | Generate a ViewFrame widget   |

### What ViewFrame Is

- A sandboxed iframe that renders **one ES module** that default-exports a React component (or plain JS)
- Dependencies resolved at runtime via **esm.sh import maps** built from the `deps` map — no build step required
- The host injects a `SynapWidget` bridge for data access and shell actions
- Security: `sandbox="allow-scripts allow-modals allow-popups"`, no `allow-same-origin`, no cookies, no pod token

### Authoring contract

A ViewFrame cell is **one self-contained ES module** (inline in `rendererSource`):

- The module **default-exports a React component** (or calls `SynapWidget.onInit()` for plain JS).
- Bare imports (`"react"`, `"recharts"`, etc.) are resolved via the esm.sh import map generated from `deps`.
- **No bundler, no `import` of local files** — everything is either inlined or declared in `deps`.
- External CSS is not supported; inline `<style>` tags or CSS-in-JS only.

### Register a Cell via the Hub Protocol (canonical path)

**Use `POST /api/hub/cells/define` — this is the canonical Hub Protocol path for AI-generated cells.**

It is idempotent (upserts on typeKey), pod-global by default (no workspaceId needed), and immediately available across all of the user's workspaces without any proposal step.

```
POST /api/hub/cells/define
Authorization: Bearer {SYNAP_HUB_API_KEY}
Content-Type: application/json

{
  "name": "Deal Stage Funnel",
  "rendererSource": "<!DOCTYPE html>…</html>",
  "typeKey": "deal-stage-funnel",        // optional — derived from name if omitted
  "description": "Funnel chart of deal pipeline stages",  // optional
  "defaultSize": { "w": 8, "h": 6 },    // optional
  "deps": {                              // optional — npm packages pinned for the import map
    "recharts": "2.12.0",
    "@tanstack/react-table": "8"
  }
}
```

**`deps` rules:**

- Keys are npm package names (`pkg` or `@scope/pkg`). URLs and protocols are rejected.
- Values are version strings or `"latest"` — used verbatim in the esm.sh import map URL.
- Maximum 30 entries. Omit `deps` (or pass `{}`) for React-only cells (React is always available).

**`workspaceId` is intentionally omitted** — cells defined without it are pod-global (`workspaceId IS NULL`), visible in every workspace the user owns. Pass `workspaceId` only when you explicitly want a cell scoped to a single workspace.

Response: `{ "success": true, "typeKey": "generated:deal-stage-funnel" }`

The typeKey is auto-prefixed `generated:` when not explicitly provided.

**List cells (all pod-global + optionally workspace-specific):**

```
GET /api/hub/cells                         — pod-global only
GET /api/hub/cells?workspaceId={id}        — pod-global + workspace-scoped
Authorization: Bearer {SYNAP_HUB_API_KEY}
```

**Delete a cell:**

```
DELETE /api/hub/cells/{typeKey}            — pod-global row
DELETE /api/hub/cells/{typeKey}?workspaceId={id}  — workspace-scoped row
Authorization: Bearer {SYNAP_HUB_API_KEY}
```

**Open the cell in the browser (deep link):**

```
synap://open/cell/{typeKey}
```

The browser receives this deep link, looks the typeKey up in the cell registry (which polls `widget_definitions` every 10s), and opens it as a side panel tab with the cell's registered `meta.name` as the tab title.

**Full AI artifact workflow:**

```
// 1. Generate the HTML/React cell
POST /api/hub/cells/define
{ "name": "Q2 Revenue Report", "rendererSource": "<!DOCTYPE html>…</html>",
  "deps": { "recharts": "2.12.0" } }
// → { "success": true, "typeKey": "generated:q2-revenue-report" }

// 2. Open it in the user's browser
synap://open/cell/generated:q2-revenue-report
```

The cell appears immediately in the side panel with "Q2 Revenue Report" as the tab title. It persists across sessions and is available from any workspace.

> **Note:** `POST /api/hub/widget-definitions` (tRPC path) still works but is the internal/admin path. Use `POST /api/hub/cells/define` for all agent-generated cells.

### CLI commands (when running as Claude Code / OpenClaw agent)

```bash
# Build a multi-file cell source into a single ES module bundle + emit deps map
synap cell build <entry>           # e.g. synap cell build ./src/my-chart.tsx
# → prints bundled source to stdout and writes deps.json alongside the entry

# Push a built cell (source + deps) to the pod
synap cell define \
  --name "My Chart" \
  --source ./dist/my-chart.js \
  --deps ./deps.json \
  [--typeKey my-chart] \
  [--workspace <id>]

# Document operations (attach prose or reports to entities)
synap doc create --title "Q2 Report" --content ./report.md --entity <entityId>
synap doc update <docId> --content ./updated-report.md

# Arrange widgets on an existing bento view
synap view arrange <viewId> --blocks '[{"id":"b1","kind":"widget","widgetKind":"generated:my-chart","layout":{"x":0,"y":0,"w":8,"h":6}}]'
```

### The SynapWidget Bridge (inside the iframe)

`window.SynapWidget` is injected automatically — do NOT import or `<script>` it.

#### Queries (read-only, always approved)

```js
SynapWidget.onInit(async ({ config, context }) => {
  // context: { workspaceId, viewId?, entityId?, sdkVersion }

  // List entities
  const deals = await SynapWidget.query("entities.list", {
    profileSlug: "deal",
    limit: 200,
  });

  // Get a single entity
  const entity = await SynapWidget.query("entities.get", { id: "uuid" });

  // List views
  const views = await SynapWidget.query("views.list", {
    workspaceId: context.workspaceId,
  });

  // List profiles
  const profiles = await SynapWidget.query("profiles.list", {});

  render(deals ?? []);
  SynapWidget.resize(document.body.scrollHeight);
});
```

All `query()` calls return a Promise. Entity shape: `{ id, title, profileSlug, properties, createdAt, … }`.

#### Mutations (governance-gated — return `{ status: "approved" | "proposed" | "denied" }`)

```js
// Create an entity
const result = await SynapWidget.mutate("create_entity", {
  profileSlug: "task",
  title: "Follow up",
  properties: { status: "todo" },
});
// result.status === "approved" → result.id is the new entity id
// result.status === "proposed" → result.proposalId, result.reviewUrl

// Update an entity
await SynapWidget.mutate("update_entity", {
  id: "uuid",
  properties: { status: "done" },
});

// Delete an entity (always proposed for agent-generated cells)
await SynapWidget.mutate("delete_entity", { id: "uuid" });

// Create a relation
await SynapWidget.mutate("create_relation", {
  sourceEntityId: "uuid-a",
  targetEntityId: "uuid-b",
  type: "related_to",
});
```

**Always check `result.status`.** `"proposed"` is not an error — surface `result.reviewUrl` to the user.

#### Shell actions

```js
SynapWidget.navigate({ entityId: "entity-uuid" }); // open entity detail in side panel
SynapWidget.openPanel("entity-detail", { entityId: "uuid" }); // explicit panel open
SynapWidget.toast("Saved!", "success"); // 'success' | 'error' | 'info'
SynapWidget.resize(document.body.scrollHeight); // resize the iframe to content height
SynapWidget.updateContext({ viewId: "uuid" }); // update ambient context

// Subscribe to live entity changes
SynapWidget.subscribe("entity:changed", ({ entityId }) => {
  // re-fetch and re-render when any entity in the pod changes
});
```

### Common Dependency Patterns (esm.sh import map)

The `deps` map in `/cells/define` drives the import map. Each key becomes a bare specifier in the `<script type="importmap">`, resolved to `https://esm.sh/<pkg>@<version>`.

```json
// deps in the define call:
{ "recharts": "2.12.0", "d3": "7" }

// → generates this importmap inside the frame:
{
  "imports": {
    "react": "https://esm.sh/react@19",
    "react-dom/client": "https://esm.sh/react-dom@19/client",
    "react/jsx-runtime": "https://esm.sh/react@19/jsx-runtime",
    "recharts": "https://esm.sh/recharts@2.12.0",
    "d3": "https://esm.sh/d3@7"
  }
}
```

React 19 core entries are always injected by the host — never put them in `deps`.

Common library choices:

| Category | Packages (put in `deps`)                                       |
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
    <!-- importmap is injected by the host from deps — do not write one manually -->
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import { createRoot } from "react-dom/client";
      import { createElement as h, useState } from "react";

      SynapWidget.onInit(async ({ context }) => {
        const items = await SynapWidget.query("entities.list", {
          profileSlug: "deal",
          limit: 200,
        }).catch(() => []);

        createRoot(document.getElementById("root")).render(
          h("p", null, `Loaded ${(items ?? []).length} deals`)
        );

        SynapWidget.resize(document.body.scrollHeight);
      });
    </script>
  </body>
</html>
```

### Rules

- **Always call `SynapWidget.onInit()`** — the host will not send data until you register this handler.
- **Call `SynapWidget.resize()`** after rendering to prevent clipping.
- **Handle errors** — `query()` and `mutate()` can fail; always `.catch()`.
- **Check `result.status` on mutations** — `"proposed"` is governance, not an error; surface `reviewUrl`.
- **Transparent background** — `background: transparent` on `body` inherits the host surface color.
- **No external fetch** — the sandbox has no cross-origin access; all data must go through `SynapWidget`.
- **Declare all non-React imports in `deps`** — the host generates the import map from that field.

---

---

## Authentication

```
Authorization: Bearer {SYNAP_HUB_API_KEY}
X-Workspace-Id:  {workspaceId}            (optional; also pass in body/query)

Scopes:
  hub-protocol.read   → most GET endpoints
  hub-protocol.write  → all writes AND GET /channels/personal
```
