## Synap-first operating mode

> **MCP clients** (Claude Desktop, Raycast, OpenClaw with MCP): use `synap_*` tool names — they wrap auth and governance automatically. **REST / HTTP clients**: use the endpoints below.

These five rules override default assistant behavior when connected to a Synap pod:

**1. Orient before acting** _(and check your lens — see "am I in the right place?" above)_  
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
