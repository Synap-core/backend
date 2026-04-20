---
name: synap-ui
description: >
  Use this skill when the user wants to BUILD interface in Synap — creating views,
  dashboards, bento layouts, or whole workspaces over their data. Triggers:
  "build me a dashboard for tracking X", "create a kanban for my projects",
  "make a CRM workspace", "I want a feed view of my articles", "design a home
  dashboard", "show my reading list as a gallery", "turn this into a
  timeline/calendar/matrix", "generate a workspace for content creation /
  sales / research / project management / fitness tracking", "arrange widgets
  on my bento", "create a command / automation trigger". This skill PRESENTS
  data — the underlying entities must already exist (use core `synap`) and
  schema extensions happen via `synap-schema`. Always propose workspace creation
  to the user before committing — workspaces are lenses on data, not silos,
  and the user decides when a new lens is warranted.
metadata:
  openclaw:
    requires:
      env: [SYNAP_HUB_API_KEY, SYNAP_POD_URL]
    primaryEnv: SYNAP_HUB_API_KEY
    homepage: https://synap.live
    capabilities: [views, bento, workspaces, widgets]
    os: [macos, linux, windows]
    userInvocable: false
---

# Synap — UI generation

You build the surfaces the user sees: views over their data, bento dashboards, full workspaces tuned for a domain. The core rule: **emergent complexity.** A workspace is a lens; a view is a lens; a bento is a composition of lenses. Everything renders through the cell system, nothing is hardcoded.

## Before you build anything

Always inventory. Never hallucinate view types, widget kinds, or profiles.

```
GET /api/hub/profiles?userId={userId}&workspaceId={workspaceId}
  → what data exists

GET /api/hub/widget-definitions?workspaceId={workspaceId}
  → [{ kind, category, label, description, configSchema, supportedContexts }]

GET /api/hub/views?userId={userId}&workspaceId={workspaceId}
  → [{ id, name, type, profileSlug, config }]
```

Widget definitions are the source of truth for which cells are installed and how to configure them. **Never guess cell kinds.** If a cell doesn't appear in the registry, don't reference it.

## Three things you can build

1. **Views** — named queries + rendering config over entities of a given profile. Kanban of tasks, gallery of articles, calendar of events.
2. **Bento dashboards** — 12-col grid compositions of cells (view-cards, entity-cards, widgets). The Home dashboard is a bento. Workspace landing pages are bentos.
3. **Workspaces** — full lenses with profiles, views, a bento, and seed entities. The biggest building block.

## View types (16 total, 12 implemented)

Pick one that matches the data's shape AND the user's intent:

| Type             | Implemented | When it fits                                               |
| ---------------- | ----------- | ---------------------------------------------------------- |
| `table`          | yes         | Dense data, many columns, sort/filter heavy                |
| `list`           | yes         | Scan-friendly, compact rows (tasks, notes)                 |
| `grid`           | yes         | Card grid, medium density                                  |
| `gallery`        | yes         | Image-forward cards (articles, bookmarks, products)        |
| `kanban`         | yes         | Status pipelines (tasks by status, deals by stage)         |
| `matrix`         | yes         | 2-axis grid (priority × urgency, effort × impact)          |
| `masonry`/`feed` | yes         | Pinterest-style, mixed-size cards; default for Library     |
| `calendar`       | yes         | Date-indexed data (events, tasks by dueDate)               |
| `flow`           | yes         | Node-edge diagrams (automations, mind maps)                |
| `bento`          | yes         | Mixed composition (a dashboard-in-view)                    |
| `branch_tree`    | yes         | Hierarchical data (project → subtasks, threads → branches) |
| `whiteboard`     | yes         | Free-form canvas                                           |
| `timeline`       | no          | (Defer)                                                    |
| `graph`          | no          | (Defer)                                                    |
| `gantt`          | no          | (Defer)                                                    |
| `mindmap`        | no          | (Defer)                                                    |

Decision: the data has statuses → `kanban`. Dates → `calendar`. Many columns → `table`. Mixed types → `masonry` or `bento`. Full reference in **`view-types.md`**.

## Creating a view

```json
POST /api/hub/views
{
  "userId":      "{userId}",
  "workspaceId": "{workspaceId}",
  "name":        "Active Tasks by Project",
  "type":        "kanban",
  "profileSlug": "task",
  "config": {
    "groupBy":  { "property": "projectId" },
    "columns":  [
      { "slug": "title" },
      { "slug": "priority" },
      { "slug": "dueDate" }
    ],
    "filters":  [
      { "property": "status", "op": "in", "value": ["todo", "in-progress"] }
    ],
    "sort":     [{ "property": "priority", "direction": "desc" }]
  }
}
```

The `config` shape varies by view type — kanban needs `groupBy`, calendar needs a date property, gallery needs an image property. When in doubt, fetch an existing view of the same type first and mirror its structure.

## Bento layouts

A bento is a 12-column react-grid-layout. Blocks reference **cells** by kind.

```json
POST /api/hub/views            // a bento is just a view with type="bento"
{
  "userId":      "{userId}",
  "workspaceId": "{workspaceId}",
  "name":        "Content Creation Home",
  "type":        "bento",
  "config": {
    "blocks": [
      { "id": "b1", "kind": "view",   "viewId":     "<kanbanId>",
        "layout": { "x": 0, "y": 0, "w": 8, "h": 4 } },
      { "id": "b2", "kind": "entity", "entityId":   "ent_current_project",
        "layout": { "x": 8, "y": 0, "w": 4, "h": 4 } },
      { "id": "b3", "kind": "widget", "widgetKind": "quick-access",
        "layout": { "x": 0, "y": 4, "w": 6, "h": 2 },
        "config": { "items": [ … ] } },
      { "id": "b4", "kind": "widget", "widgetKind": "stat-card",
        "layout": { "x": 6, "y": 4, "w": 6, "h": 2 },
        "config": { "metric": "entities_created_this_week" } }
    ]
  }
}
```

Block kinds:

- `view` — embeds a saved view by `viewId`
- `entity` — renders an entity card for a specific `entityId`
- `widget` — renders a registered cell by `widgetKind` with `config`

Full widget catalog in **`widget-catalog.md`**. Layout patterns in **`bento-recipes.md`**.

## Creating or proposing a workspace

**Always ask before creating.** Workspaces are big objects with profiles, views, members, bento, and seed data. Commit only after user confirms.

The canonical flow:

1. **Assemble a proposal** (no API call yet):

   ```js
   const proposal = {
     name: "Content Creation",
     description: "Draft, review, and publish articles",
     icon: "pen-tool",
     color: "purple",
     profiles: [                 // reuse system profiles by slug OR include custom ones
       { slug: "article", reuse: true },
       { slug: "draft",   displayName: "Draft", parentSlug: "article",
         properties: [
           { slug: "status", valueType: "string", constraints: { enum: ["idea","writing","review","published"] }, uiHints: { displayAs: "status" } },
           { slug: "wordCount", valueType: "number" },
           { slug: "publishDate", valueType: "date" }
         ]
       }
     ],
     views: [
       { name: "Pipeline", type: "kanban", profileSlug: "draft",
         config: { groupBy: { property: "status" } } },
       { name: "Published", type: "gallery", profileSlug: "article",
         config: { filters: [{ property: "status", op: "eq", value: "published" }] } }
     ],
     bento: { blocks: [ … ] },
     seedEntities: []            // optional
   }
   ```

2. **Show it to the user**. Compact, readable. "Here's what I'd create — 2 profiles, 2 views, a bento. Ship it?"

3. **On yes**, commit through `/api/hub/workspaces`:

   ```json
   POST /api/hub/workspaces
   { "userId": "{userId}", "proposal": { /* the object above */ } }
   ```

   This goes through governance — `workspace.create` is **always** proposal-gated even for agents (see `../synap/governance.md`). Expect `status: "proposed"` and tell the user they'll see it in Proposals.

4. **On no**, don't commit. Offer to adjust.

## Proposing vs. extending

Before proposing a new workspace, ask: does one of the user's existing workspaces fit? A "Content" workspace and a "Writing" workspace are the same lens. Adding a view to the existing workspace is almost always better than creating a new one.

Create new when:

- The user explicitly asks for it ("new workspace for…")
- The data and access patterns are genuinely orthogonal to existing workspaces
- A different team/collaborator set makes sense

Otherwise: add a view, add a bento block, add properties — don't multiply workspaces.

## Worked example — "Make me a CRM"

1. Inventory. User already has `person`, `contact`, `company`, `deal`, `event` profiles (all system).
2. No new profiles needed. The CRM is a **lens**, not new data.
3. Propose (before committing):
   - Workspace name: "CRM"
   - Views:
     - `Deals Pipeline` — kanban on `deal`, groupBy `stage`
     - `Contacts` — table on `contact`, columns: name, role, company, lastInteraction
     - `Companies` — gallery on `company` (logo-forward)
     - `Upcoming Meetings` — calendar on `event`, filter `relatedToContact`
   - Bento:
     - Top: `deals pipeline` view (8 cols × 4 rows)
     - Side: `stat-card` — "Deals in pipeline: $X" (4 cols × 2 rows)
     - Side: `stat-card` — "Meetings this week: N" (4 cols × 2 rows)
     - Bottom: `recent-activity` widget (12 cols × 3 rows)
4. Show to user. Confirm.
5. Commit via `POST /workspaces`.

## Arranging a bento after creation

```json
POST /api/hub/views/{bentoViewId}/arrange
{ "userId": "{userId}", "blocks": [ /* full new blocks array */ ] }
```

`bento.arrange` is auto-approved by default. Safe to run without hesitation when the user rearranges or adds widgets.

## Common mistakes

1. **Creating a workspace without asking.** Always propose + confirm. Workspaces are too big to auto-commit.
2. **Guessing widget kinds.** Always `GET /widget-definitions` first. A `kind` that isn't in the registry won't render.
3. **Reinventing views.** Check existing views first — a kanban for tasks probably exists.
4. **Creating a new profile when UI is the real need.** Don't create `client` profile for a "contacts who are clients" view — just create a filtered view on `contact`.
5. **Putting unrelated data in one bento.** A bento tells a story ("my week", "this project", "content pipeline"). Kitchen-sink bentos overwhelm the user.
6. **Ignoring color/icon.** Profiles and workspaces both take `uiHints.icon` and `uiHints.color` — set them. Untitled gray workspaces feel like a bug.
7. **Hardcoding config for view types you haven't checked.** Each view type's `config` shape is different. Get an example from `/views` first.
8. **Forgetting entityScope implications.** A view on a pod-scope profile (`note`) will show entities from every workspace the user can access — filter appropriately if you want workspace-local results.

## When you need more

- Full per-view-type `config` shapes → **`view-types.md`**
- Complete widget/cell catalog + configSchemas → **`widget-catalog.md`**
- Ready-to-reuse bento layouts for common use cases → **`bento-recipes.md`**
- Creating the underlying data → use core **`synap`** skill
- Extending profiles with new fields before building views → use **`synap-schema`** skill
