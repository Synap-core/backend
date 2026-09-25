## Document embeds — live entities/views/cells inside markdown

Documents (`type: "markdown"`) can embed **live, rendering** Synap objects inline, not
just links. The browser's markdown engine parses a small set of remark **container
directives** and swaps them for real components — an entity card, a view, or a cell
— wherever they appear in the prose.

**Two grammars, one per job.** A `:::synap-*` directive EMBEDS a live object as a
block (a card, a view, a chart). A `[[kind:id|label]]` marker (`inline-patterns.md`)
NAMES a record inline, as a chip, inside a sentence. Documents use both; chat
replies use only markers. Never put a `:::synap-*` directive in a chat reply.

### Syntax

<!-- brief:start -->

A container directive: three colons, the directive name, `{attrs}` on the opening
line, three colons alone on the closing line. **Attributes are references only**
(ids and keys). A cell's settings go in an optional ` ```json ` block, the FIRST
thing inside the directive; optional markdown after it is the **fallback** a
reader shows when the object cannot be drawn (relay, exports, other agents).

````
:::synap-entity{id="ent_abc123"}
:::

:::synap-cell{cellKey="chart-bar"}
```json
{"profileSlug":"task","groupBy":"status","label":"Tasks by status","data":[{"label":"Review","value":7},{"label":"Done","value":4}],"capturedAt":"2026-09-25T10:00:00Z"}
```

Most open tasks sit in Review.
:::
````

A chart in a document is a **snapshot by default**: `data` (the numbers you
read) + `capturedAt`, with the query keys kept so a reader can "Make live".
Omit `data` only for a dashboard-style live chart.

| Directive      | Required attrs                | Body                                  | Renders                                           |
| -------------- | ----------------------------- | ------------------------------------- | ------------------------------------------------- |
| `synap-entity` | `id` (entity UUID)            | optional fallback                     | Compact entity card (`__entity-block` cell)       |
| `synap-view`   | `viewId` (view UUID)          | optional fallback                     | Embedded, read-only view (`__embedded-view` cell) |
| `synap-cell`   | `instanceId` **OR** `cellKey` | optional ` ```json ` props + fallback | A persisted cell instance, or an inline cell      |

Name a record inline with a marker: `[[entity:<id>|<label>]]`, `[[view:<id>|<label>]]`.
Only real IDs from prior tool results — never invent one. Never use a directive
in a chat reply.

<!-- brief:end -->

For `synap-cell`: an explicit `instanceId` always wins if present — it renders a
persisted cell instance from `/api/hub/cell-instances`. Otherwise `cellKey` names
the cell type and the ` ```json ` block is its config.

The props block is plain JSON, so it needs no special quoting: apostrophes,
quotes, braces and `:::` inside a JSON string are all safe. It must be a JSON
OBJECT, and the directive must be CLOSED with its own `:::` line (an unclosed
directive swallows what follows). Keep the finding itself in the prose AFTER the
embed; the fallback is a short, qualitative description of the object, not the
place for numbers that go stale.

### Charts: snapshot or live (decision D2)

A `chart-*` cell draws its data one of two ways, chosen per embed:

- **Snapshot (the default in a document).** `data` holds the numbers, and
  `capturedAt` (ISO date) says when they were taken. The chart then matches
  the sentence written about it forever, and it survives export and offline
  reading. The reader sees "Snapshot · <date>" and can **Make live**.
- **Live.** Leave `data` out: the chart runs its own query (`profileSlug` +
  its settings) each time it is opened. Use it for dashboards and monitoring
  ("what is the state now") or when the user asks for it. A live chart can be
  **Frozen** into a snapshot.

Rules for a snapshot:

- **Only numbers you actually read** (a query you ran, a count a tool
  returned). Never estimate or invent a value. If you have no measured
  numbers, write a live chart and keep exact figures out of the sentence
  beside it.
- **Keep the query keys** (`profileSlug`, `groupBy`, `aggregation`, …) next to
  `data`, so "Make live" reads the same thing.
- **`data` has the chart's shape**, which `synap_list_widgets` (surface
  `document`) shows per chart in its example:
  - line / area / profit-loss: `[{"x":"2026-09-01","y":4}]` (x = an ISO date or a number)
  - bar / pie / funnel / radar: `[{"label":"Done","value":12}]`
  - composed: `[{"x":"Sep 1","bar":4,"line":120}]`
  - gauge / ring: one number (a 0–100 % for the default `completion`)
  - scatter: `[{"x":3,"y":1200,"label":"Acme"}]`
  - sankey: `{"nodes":[{"id":"a","label":"web"},{"id":"b","label":"won"}],"links":[{"source":"a","target":"b","value":9}]}`
  - choropleth: `{"FR":12,"US":30}`
- A malformed `data` is shown to the reader as a broken chart with the reason,
  never as an empty one. `chart-live-line` is live only: never give it `data`.
- With a snapshot, the sentence MAY quote a number that is in `data`: they
  cannot drift apart. With a live chart, it may not.

### Diagrams, math and code: fences, not directives

A content LANGUAGE is a fenced block whose source IS the content: ` ```mermaid `
for a diagram, ` ```math ` for a display equation (LaTeX), any other language
for code. It has no props and no fallback, and relay and exports show its
source. `synap_list_widgets` (surface `document`) returns these as `fences`,
each with its `aiHint`: read them there rather than from memory. There is no
` ```chart ` fence (a chart is a `synap-cell`), and inline `$…$` math is off.

**Do not write the old attribute form** (`cellProps='{…}'` on the opening line).
Readers still accept it, but an apostrophe in its JSON turns the whole embed into
literal text, and the editor rewrites it into the ` ```json ` form on the next save.

Documents written this way open in the editor and save back byte for byte.
`synap_create_cell` / `POST /api/hub/cells` create a cell **definition** (a new
cell type), not an instance — never embed its id as `instanceId`.

### Rules

- **Only real IDs from prior tool results.** Never invent an entity/view/instance
  ID. Create or look it up first (`synap_create_entity`, `synap_get_entities`,
  `synap_create_view`, `POST /api/hub/cell-instances`), then embed the ID you got
  back.
- **Embeds are for DOCUMENTS.** Chat replies use `[[kind:id|label]]` markers only;
  documents use embeds for blocks and markers for inline names.
- **Embed vs. link:** embed when the reader benefits from seeing the live
  object in place — a stat card inside a report, the linked meeting entity inside
  meeting notes, a pipeline view inside a status update. Link (`entities WHERE
documentId = ?` attachment, or a plain reference to the ID) when you just need
  traceability and the reader doesn't need to see it rendered inline — most
  documents should still be _attached_ to one entity (see `writes.md`) regardless
  of whether they also embed others inline.
- A directive with a missing attribute or an unknown/deleted ID renders the same
  quiet placeholder in the browser ("This view is no longer available." / "This
  cell is no longer available." / "This item is no longer available.") — the
  reader cannot tell a typo from a deletion, so double-check the ID before
  writing the directive.

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
time, status stay current even if the entity changes later. `entityId` attaches
the new document as that entity's body; the response's `attached` field reports
the outcome (the attach is a governed entity update, so it can itself be
`proposed`, and it is `skipped` while the document is awaiting review).

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

````json
POST /api/hub/documents
{
  "userId": "{userId}",
  "workspaceId": "{workspaceId}",
  "title": "Q2 task summary",
  "type": "markdown",
  "entityId": "ent_project_eve",
  "content": "# Q2 summary\n\n:::synap-cell{cellKey=\"stat-card\"}\n```json\n{\"profileSlug\":\"task\",\"label\":\"Open tasks\"}\n```\n:::\n\nOpen tasks are trending down since [[entity:ent_project_eve|Project Eve]] started."
}
````

The props travel in the ` ```json ` block (escaped here only because `content` is
itself a JSON string). The sentence about the number sits in the prose after the
embed, and the project is named with an inline marker.

### Editing a document (`update_document`)

Never rewrite a whole document to change part of it. Read it, then patch it:

1. `synap_get_document({ documentId })` (IS: `get_document`) → `content`,
   `revision`, `sections` (`id`, `owner` `ai`|`human`, `title`) and
   `diagnostics` (embeds that will not render, each with a `fix`).
2. `synap_update_document({ documentId, baseRevision: <revision>, ops })`
   (IS: `update_document`; REST: `POST /api/hub/documents/{id}/patch`). Ops run
   in order:
   - `upsert_section {id, title, body}` — one `::::synap-section` block by id:
     rewrites YOUR section (`owner="ai"`) or appends a new one;
   - `replace_text {old, new}` — `old` must occur **exactly once**; copy it
     from `content` with enough context. 0 or 2+ matches is refused with the
     count;
   - `append {body}`;
   - `replace_all {content}` — the whole body; needs `baseRevision` and is
     always reviewed.

Refused, whatever the op: changing a section whose `owner` is `human` (the AI
never rewrites a person's words — write a new section), and removing an embed
unless you pass `allow_removing_embeds: true`. A "changed after the edit was
drafted" error (409 CONFLICT) means someone saved since you read. Nothing was
written: read again and redraft. Once an edit is applied or approved, open
editors are told (`document:content-replaced`) and reload rather than overwrite it.

The answer is usually `proposed`: the person reviews a before/after per
section. It also carries `diagnostics` for the result — advisory, never a
refusal; fix what they name (the `fix` says which tool finds the right key or
id). `synap_update_entity.content` is the same door with one `replace_all`.
