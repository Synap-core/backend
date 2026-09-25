# Bento recipes — reference

Ready-to-adapt layouts for the most common user asks. Each recipe is the `widgets` array you send to `POST /api/hub/views/{bentoViewId}/arrange` (IS: `arrange_workspace`): `{ key, config, x, y, w, h }` on the 12-column grid. Arrange validates every key against the catalog and refuses a missing required config, so a recipe that arranges cleanly renders.

Before using one:

1. `synap_list_widgets` — confirm each key is listed for this workspace (and read its `requiredConfig`).
2. `synap_list_profiles` — swap the example `profileSlug`s for ones that exist.
3. A `view` block needs a saved view: `synap_list_views` for its `viewId`, or `synap_create_view` first.

---

## Recipe: Personal home dashboard

_User asks: "Give me a home dashboard."_

What matters today, quick access, recent activity.

```json
[
  {
    "key": "greeting",
    "config": { "showDate": true },
    "x": 0,
    "y": 0,
    "w": 8,
    "h": 2
  },
  { "key": "quick-access", "config": {}, "x": 8, "y": 0, "w": 4, "h": 2 },
  {
    "key": "stat-card",
    "config": { "profileSlug": "task", "label": "Open tasks" },
    "x": 0,
    "y": 2,
    "w": 3,
    "h": 3
  },
  {
    "key": "stat-card",
    "config": {
      "profileSlug": "note",
      "label": "Notes this week",
      "timePeriod": "week"
    },
    "x": 3,
    "y": 2,
    "w": 3,
    "h": 3
  },
  { "key": "inbox", "config": { "limit": 8 }, "x": 6, "y": 2, "w": 6, "h": 6 },
  {
    "key": "entity-list",
    "config": {
      "profileSlug": "task",
      "title": "Next up",
      "sortField": "priority",
      "sortDirection": "desc",
      "limit": 10
    },
    "x": 0,
    "y": 5,
    "w": 6,
    "h": 6
  },
  { "key": "feed", "config": { "limit": 20 }, "x": 0, "y": 11, "w": 12, "h": 4 }
]
```

## Recipe: Project overview

_User asks: "Make a page for project X."_

Pair the bento with a kanban **view** of the project's tasks (create it first, then embed its id).

```json
[
  {
    "key": "section-header",
    "config": { "title": "Project X" },
    "x": 0,
    "y": 0,
    "w": 12,
    "h": 2
  },
  {
    "key": "view",
    "config": { "viewId": "<tasks kanban viewId>", "layout": "kanban" },
    "x": 0,
    "y": 2,
    "w": 8,
    "h": 8
  },
  {
    "key": "chart-pie",
    "config": {
      "profileSlug": "task",
      "groupBy": "status",
      "label": "Tasks by status"
    },
    "x": 8,
    "y": 2,
    "w": 4,
    "h": 5
  },
  {
    "key": "entity-gallery",
    "config": { "profileSlug": "file", "title": "Files", "limit": 6 },
    "x": 8,
    "y": 7,
    "w": 4,
    "h": 4
  }
]
```

## Recipe: CRM home

_User asks: "Build me a CRM dashboard."_

```json
[
  {
    "key": "stat-card",
    "config": {
      "profileSlug": "deal",
      "aggregation": "sum",
      "field": "value",
      "label": "Pipeline value"
    },
    "x": 0,
    "y": 0,
    "w": 3,
    "h": 3
  },
  {
    "key": "stat-card",
    "config": { "profileSlug": "deal", "label": "Open deals" },
    "x": 3,
    "y": 0,
    "w": 3,
    "h": 3
  },
  {
    "key": "stat-card",
    "config": { "profileSlug": "contact", "label": "Contacts" },
    "x": 6,
    "y": 0,
    "w": 3,
    "h": 3
  },
  {
    "key": "chart-bar",
    "config": {
      "profileSlug": "deal",
      "groupBy": "stage",
      "aggregation": "sum",
      "valueField": "value",
      "label": "Value by stage"
    },
    "x": 0,
    "y": 3,
    "w": 6,
    "h": 5
  },
  {
    "key": "view",
    "config": { "viewId": "<deals kanban viewId>", "layout": "kanban" },
    "x": 6,
    "y": 3,
    "w": 6,
    "h": 8
  },
  {
    "key": "calendar",
    "config": {
      "profileSlug": "event",
      "dateField": "startDate",
      "endDateField": "endDate",
      "defaultView": "timeGridWeek"
    },
    "x": 0,
    "y": 8,
    "w": 6,
    "h": 8
  },
  {
    "key": "entity-list",
    "config": {
      "profileSlug": "contact",
      "title": "Recently contacted",
      "sortField": "lastInteractionAt",
      "sortDirection": "desc",
      "limit": 10
    },
    "x": 6,
    "y": 11,
    "w": 6,
    "h": 5
  }
]
```

## Recipe: Content pipeline

_User asks: "Help me manage my content."_

```json
[
  {
    "key": "view",
    "config": { "viewId": "<drafts kanban viewId>", "layout": "kanban" },
    "x": 0,
    "y": 0,
    "w": 12,
    "h": 8
  },
  {
    "key": "stat-card",
    "config": {
      "profileSlug": "draft",
      "label": "Published this month",
      "timePeriod": "month"
    },
    "x": 0,
    "y": 8,
    "w": 4,
    "h": 3
  },
  {
    "key": "chart-line",
    "config": {
      "profileSlug": "draft",
      "timePeriod": "week",
      "label": "Drafts per week"
    },
    "x": 4,
    "y": 8,
    "w": 8,
    "h": 5
  }
]
```

## Recipe: Reading list

_User asks: "Show me my reading list."_

```json
[
  {
    "key": "stat-card",
    "config": { "profileSlug": "article", "label": "Unread" },
    "x": 0,
    "y": 0,
    "w": 4,
    "h": 3
  },
  {
    "key": "entity-spotlight",
    "config": { "profileSlug": "article", "seed": "daily" },
    "x": 4,
    "y": 0,
    "w": 8,
    "h": 3
  },
  {
    "key": "entity-gallery",
    "config": { "profileSlug": "article", "title": "To read", "limit": 12 },
    "x": 0,
    "y": 3,
    "w": 8,
    "h": 6
  },
  {
    "key": "entity-list",
    "config": {
      "profileSlug": "article",
      "title": "Recently read",
      "sortField": "readAt",
      "sortDirection": "desc",
      "limit": 10
    },
    "x": 8,
    "y": 3,
    "w": 4,
    "h": 6
  }
]
```

## Recipe: Daily briefing

_User asks: "What should I look at every morning?"_

```json
[
  {
    "key": "greeting",
    "config": { "showDate": true, "showCapturedToday": true },
    "x": 0,
    "y": 0,
    "w": 12,
    "h": 2
  },
  {
    "key": "entity-list",
    "config": {
      "profileSlug": "task",
      "title": "Due soon",
      "sortField": "dueDate",
      "sortDirection": "asc",
      "limit": 8
    },
    "x": 0,
    "y": 2,
    "w": 6,
    "h": 6
  },
  {
    "key": "calendar",
    "config": {
      "profileSlug": "event",
      "dateField": "startDate",
      "defaultView": "timeGridDay"
    },
    "x": 6,
    "y": 2,
    "w": 6,
    "h": 6
  },
  { "key": "inbox", "config": { "limit": 6 }, "x": 0, "y": 8, "w": 12, "h": 4 }
]
```

## Recipe: Governance dashboard

_User asks: "What are my agents doing?"_

```json
[
  {
    "key": "section-header",
    "config": { "title": "Needs your review" },
    "x": 0,
    "y": 0,
    "w": 12,
    "h": 2
  },
  {
    "key": "proposals-list",
    "config": { "status": "pending", "limit": 10 },
    "x": 0,
    "y": 2,
    "w": 6,
    "h": 8
  },
  {
    "key": "proposals-list",
    "config": { "status": "approved", "layout": "timeline", "limit": 20 },
    "x": 6,
    "y": 2,
    "w": 6,
    "h": 8
  }
]
```

---

## Composition tips

- **Row-by-row thinking.** Each row is one visual theme. Mixing themes in the same row confuses the eye.
- **Start from `defaultSize`.** Each entry in `synap_list_widgets` carries one; it's easier to shrink an oversized block than to realize a tight block feels cramped.
- **Use `section-header` between themes.** Readers parse visual separators faster than mental ones.
- **Keep stat-cards together in a strip.** Four stats at 3×3 each = one clean row. Four stats scattered = noise.
- **End with the feed.** Activity feeds work best as the last row — they're where the eye lands for recency.
- **One primary view per bento.** The user should know what the bento is "about" at a glance. If you have two headline views, split into two bentos.
- **Show, don't hide.** Top-left gets the most attention — put the answer there.
