# Widget catalog — reference

Widgets (cells) are the universal rendering unit. A bento is composed of cells. Views embed cells. Side panels host cells.

**Never guess a widget kind.** Always call `GET /api/hub/widget-definitions?workspaceId={workspaceId}` first — the response is the authoritative registry for what's installed.

This file is a categorized snapshot of what typically exists in a Synap pod. Use it for planning ("can I build X?") — but verify against the registry before committing.

## How widget references work in bentos

```json
{
  "id": "block-123",
  "kind": "widget",
  "widgetKind": "stat-card",
  "config": {
    /* widget-specific, see configSchema in registry */
  },
  "layout": { "x": 0, "y": 0, "w": 4, "h": 2 }
}
```

`widgetKind` is a string matching a registered cell. `config` must validate against the cell's `configSchema` (returned by `/widget-definitions`).

## Categories

The registry tags each widget with a category:

- `core` — universal layout primitives (stat, section-header, quick-access)
- `data` — entity-driven (entity-card, entity-gallery, view embeds)
- `ai` — AI outputs (proactive cards, proposals, chat)
- `entity` — entity-detail views and editors
- `communication` — channels, threads, messages
- `governance` — proposals, approvals
- `content` — documents, articles, rich media

## Core widgets (layout primitives — always available)

### `stat-card`

Single metric on a card. Best for top-of-dashboard KPIs.

```json
{
  "widgetKind": "stat-card",
  "config": {
    "label": "Tasks completed this week",
    "metric": "count",
    "filter": {
      "profileSlug": "task",
      "properties.status": "done",
      "updatedAt.gte": "this-week"
    },
    "trend": true, // show vs. last period
    "icon": "check-circle"
  }
}
```

### `section-header`

Title + optional subtitle. Separator for bento rows.

```json
{
  "widgetKind": "section-header",
  "config": { "title": "This week", "subtitle": "Updated just now" }
}
```

### `quick-access`

Shortcut grid — a row of entity or view pins.

```json
{
  "widgetKind": "quick-access",
  "config": {
    "items": [
      { "kind": "view", "viewId": "...", "label": "Inbox" },
      {
        "kind": "entity",
        "entityId": "ent_project_...",
        "label": "Current project"
      },
      { "kind": "url", "url": "https://...", "label": "Calendar" }
    ]
  }
}
```

### `feed`

Activity feed — recent entity mutations, AI actions, proposals.

```json
{
  "widgetKind": "feed",
  "config": {
    "sources": ["entity.create", "entity.update", "proposal.approved"],
    "limit": 20,
    "filter": { "profileSlug": ["task", "note"] } // optional
  }
}
```

### `inbox`

Unread + actionable items. Proposals, mentions, due tasks.

```json
{
  "widgetKind": "inbox",
  "config": { "categories": ["proposals", "mentions", "due_today"] }
}
```

## Data widgets

### `entity-card`

One entity, rich rendering.

```json
{
  "widgetKind": "entity-card",
  "config": {
    "entityId": "ent_...",
    "fields": ["title", "status", "dueDate", "assignee"],
    "showRelations": true
  }
}
```

### `entity-gallery`

Gallery of entities filtered by a query.

```json
{
  "widgetKind": "entity-gallery",
  "config": {
    "profileSlug": "article",
    "filters": [{ "property": "status", "op": "eq", "value": "unread" }],
    "sort": [{ "property": "createdAt", "direction": "desc" }],
    "limit": 12,
    "imageProperty": "thumbnail"
  }
}
```

### `entity-spotlight`

One featured entity, large format. Often the "current project" or "today's focus."

```json
{
  "widgetKind": "entity-spotlight",
  "config": { "entityId": "ent_...", "showDocument": true }
}
```

### `view` (generic view embed)

Any saved view rendered inside a bento. Usually easier than configuring widgets individually.

```json
{
  "kind": "view",
  "viewId": "<savedViewId>",
  "layout": { "x": 0, "y": 0, "w": 12, "h": 6 }
}
```

Note: `{ "kind": "view", "viewId": … }` is a bento block type, not a widget. Use it when you have a saved view and just want to embed it.

### `view-kanban` / `view-table` / `view-calendar` / `view-grid` / `view-list`

Inline view configs — no saved view required. Good for one-off dashboard pieces.

```json
{
  "widgetKind": "view-kanban",
  "config": {
    "profileSlug": "task",
    "groupBy": { "property": "status" },
    "filters": [{ "property": "projectId", "op": "eq", "value": "ent_current" }]
  }
}
```

## Entity widgets (for entity-detail pages / side panels)

- `entity-detail` — the full entity view (fields, properties, related)
- `document-editor` — rich markdown editor for a document
- `entity-relationships` — graph/list of connected entities
- `entity-properties` — the properties panel (forms)

Mostly used inside entity pages, not bentos.

## AI widgets

### `proactive-feed`

AI nudges and insights the user's agents posted proactively.

```json
{
  "widgetKind": "proactive-feed",
  "config": { "limit": 10, "categories": ["insight", "nudge", "digest"] }
}
```

### `morning-briefing` / `weekly-digest` / `health-check` / `insight`

Proactive cards rendered individually. Usually only appear after the Proactive Intelligence Layer has posted — not manually composed by an agent.

### `ai-chat`

Embedded chat surface targeting a specific channel.

```json
{
  "widgetKind": "ai-chat",
  "config": { "channelId": "ch_...", "mode": "compact" }
}
```

### `recent-chats`

List of recent AI conversations.

### `agent-activity`

What the user's agents have been doing (actions, proposals, writes). Good for governance bentos.

## Governance widgets

- `proposals-list` — pending proposals needing review
- `proposal-detail` — single proposal card
- `proposal-timeline` — history of proposal approvals/rejections

```json
{
  "widgetKind": "proposals-list",
  "config": { "status": "pending", "limit": 10 }
}
```

## Communication widgets

- `channel` — full channel (messages + composer)
- `channel-navigator` — sidebar-style channel list
- `channel-view` — read-only channel embed
- `channel-feed` — activity-style feed of messages

## Intelligence widgets (Intelligence Service specific)

- `service-status` — IS health
- `usage` — token consumption, model usage
- `agents` — registered agents list
- `agent-detail` — one agent's config
- `skills` — installed skills
- `tasks` — IS-managed tasks (not entities)

## Workflow widgets

- `workflow-list` — all automations
- `automation-detail` / `automation-flow` / `automation-status`
- `command-detail` — one command config
- `trigger-button` — a button that runs a command
- `run-history` — past automation runs

## Layout guidelines

The bento grid is 12 columns. Typical widget sizes:

| Widget             | Typical `w`, `h` |
| ------------------ | ---------------- |
| `stat-card`        | 3×2              |
| `section-header`   | 12×1             |
| `quick-access`     | 6×2 or 12×2      |
| `view-kanban`      | 8×4 or 12×6      |
| `view-calendar`    | 8×4 or 12×6      |
| `entity-spotlight` | 4×4              |
| `entity-gallery`   | 6×4 or 12×4      |
| `feed` / `inbox`   | 4×6 or 6×6       |
| `proactive-feed`   | 4×6              |
| `proposals-list`   | 6×4              |
| `agent-activity`   | 6×4              |

Rules of thumb:

- Don't make anything shorter than 2 rows (too cramped).
- Tall narrow feeds (4×6) work better than short wide ones.
- Put `section-header` (12×1) as the first row of a visual group.
- Limit a bento to 8–12 blocks. Past that, split into a second bento or a dedicated view.

## Common mistakes

1. **Referencing a `widgetKind` that doesn't exist in the registry.** The bento will render an error block. Always fetch the registry first.
2. **Passing a `config` that doesn't match the widget's `configSchema`.** Returns a validation error; the widget shows "invalid config" in UI.
3. **Using a widget that depends on a missing profile.** If you use `entity-gallery` with `profileSlug: "podcast"` and `podcast` doesn't exist, the widget shows an empty state. Verify first.
4. **Overlapping layout rectangles.** react-grid-layout will resolve it by shifting blocks, but the output won't match your intent. Double-check `x + w <= 12` and no two blocks share the same cells.
5. **Putting an `ai-chat` widget on a dashboard.** It works but rarely what the user wants — the chat app is already one tab away. Reserve for edge cases like project-specific chat pinned to a project home.
