## Quick reference — 90% of tasks in 30 lines

```bash
# CLI (preferred — auth automatic, --json = clean output)
synap orient --json                                    # discover userId + workspaces + projects
synap lens                                             # where am I? workspace + project + session (this Claude session)
synap use <workspace-name-or-id>                       # focus a workspace (this session)
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
POST   /api/hub/entities          body: { userId, workspaceId?, profileSlug, title, description?, properties?, content?, projectId?, facets?, source? }
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
GET /api/hub/discover?userId={userId}&profileSlugs=task
→ { profiles: [{ slug, displayName, scope, properties: [{ slug, type, required, defaultValue?, constraints?, targetProfileSlug? }], createCommand }], commands: {...} }
```

Call the summary tier once at session start, then load only the profile schemas
needed for a write. Omit `workspaceId` for base/pod schema; add it only to see
that workspace's overlays. Do not rely on a static property list — it will drift.

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
