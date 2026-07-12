## Document embeds — live entities/views/cells inside markdown

Documents (`type: "markdown"`) can embed **live, rendering** Synap objects inline, not
just links. The browser's markdown engine parses a small set of remark **container
directives** and swaps them for real components — an entity card, a view, or a cell
— wherever they appear in the prose.

**This is a DOCUMENTS-only mechanism.** It is unrelated to the `[[kind:id|label]]`
inline chips described in `inline-patterns.md` — those render **only** in Companion
chat replies. Never put a `:::synap-*` directive in a chat reply, and never put a
`[[…]]` chip in a document's `content`. Different surface, different grammar.

### Syntax

<!-- brief:start -->

A container directive: three colons, the directive name, `{attrs}` on the opening
line, three colons alone on the closing line.

```
:::synap-entity{id="ent_abc123"}
:::
```

| Directive      | Required attrs                                | Optional attrs | Renders                                           |
| -------------- | --------------------------------------------- | -------------- | ------------------------------------------------- |
| `synap-entity` | `id` (entity UUID)                            | —              | Compact entity card (`__entity-block` cell)       |
| `synap-view`   | `viewId` (view UUID)                          | —              | Embedded, read-only view (`__embedded-view` cell) |
| `synap-cell`   | `instanceId` **OR** (`cellKey` + `cellProps`) | —              | A persisted cell instance, or an inline cell ref  |

Only real IDs from prior tool results — never invent one. This is a
DOCUMENTS-only grammar: never use it in a chat reply, and never use a
`[[kind:id|label]]` chip inside a document's `content`.

<!-- brief:end -->

For `synap-cell`: an explicit `instanceId` always wins if present — it renders a
persisted cell instance from `/api/hub/cells`. Otherwise the pair `cellKey` +
`cellProps` builds an inline ref (`cellRefFromLegacy`). `cellProps` is a JSON string,
e.g. `cellProps='{"profileSlug":"task"}'`.

When you write a document's `content` directly (via `synap_create_document` /
`POST /api/hub/documents`), you're writing raw markdown text — quote `cellProps`'
JSON with single quotes (`cellProps='{"profileSlug":"task"}'`) so the inner `"`
characters don't collide with the directive's own `key="value"` quoting; the
markdown renderer (remark-directive) parses this directly, no escaping needed.

One caveat: if a human later opens the document in the rich-text editor, its
Tiptap round-trip serializer re-emits every directive as `key="value"` and
**drops any attribute value containing `"` or `}`** (it would otherwise corrupt
the directive) — so an inline `cellProps` blob can be silently lost on the next
editor save. For a cell you expect to survive editing, create it first
(`synap_create_cell` / `POST /api/hub/cells`) and embed it by `instanceId`
instead of inlining `cellProps`.

### Rules

- **Only real IDs from prior tool results.** Never invent an entity/view/instance
  ID. Create or look it up first (`synap_create_entity`, `synap_get_entities`,
  `synap_create_view`, `synap_create_cell`), then embed the ID you got back.
- **Embeds are for DOCUMENTS.** The `[[…]]` inline chips are for Companion chat
  replies. Do not mix the two grammars across surfaces.
- **Embed vs. link:** embed when the reader benefits from seeing the live
  object in place — a stat card inside a report, the linked meeting entity inside
  meeting notes, a pipeline view inside a status update. Link (`entities WHERE
documentId = ?` attachment, or a plain reference to the ID) when you just need
  traceability and the reader doesn't need to see it rendered inline — most
  documents should still be _attached_ to one entity (see `writes.md`) regardless
  of whether they also embed others inline.
- A directive with a missing/invalid required attribute renders a visible error
  block in the browser (`Error: View ID is required` / `Error: Cell type is
required`) — always double-check the ID before writing the directive.

### Worked example 1 — meeting notes embedding the meeting entity

```json
POST /api/hub/documents
{
  "userId": "{userId}",
  "workspaceId": "{workspaceId}",
  "title": "Meeting notes — 2026-07-12",
  "type": "markdown",
  "entityId": "ent_event_kickoff",
  "content": "# Kickoff meeting\n\n:::synap-entity{id=\"ent_event_kickoff\"}\n:::\n\n## Decisions\n- Ship the pilot by August 1\n\n## Action items\n- [ ] Draft the rollout plan"
}
```

The event entity renders as a live card at the top of the notes — attendees,
time, status stay current even if the entity changes later.

### Worked example 2 — status report embedding a pipeline view

```json
POST /api/hub/documents
{
  "userId": "{userId}",
  "workspaceId": "{workspaceId}",
  "title": "Weekly deals update",
  "type": "markdown",
  "entityId": "ent_project_eve",
  "content": "# Weekly update\n\nThree deals moved to negotiating this week.\n\n:::synap-view{viewId=\"view_deals_pipeline\"}\n:::\n\nSee the board above for the live state."
}
```

### Worked example 3 — report embedding an inline stat cell

```json
POST /api/hub/documents
{
  "userId": "{userId}",
  "workspaceId": "{workspaceId}",
  "title": "Q2 task summary",
  "type": "markdown",
  "entityId": "ent_project_eve",
  "content": "# Q2 summary\n\n:::synap-cell{cellKey=\"stat-card\" cellProps='{\"profileSlug\":\"task\"}'}\n:::\n\nOpen tasks are trending down."
}
```

Note the mixed quoting: the directive's own attribute values use double quotes
(`cellKey="stat-card"`), so the outer `cellProps` value uses single quotes to hold
its JSON — the JSON itself must not contain any `"` once flattened into the
attribute string, or the serializer will drop it. When in doubt, prefer a
persisted `instanceId` over inline `cellProps`.
