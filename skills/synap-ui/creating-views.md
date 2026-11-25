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
    "groupByField": "projectId",
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

The `config` shape varies by view type — kanban needs `groupByField` (a property key, a string; `groupBy` is not read), calendar needs a date property, gallery needs an image property. When in doubt, fetch an existing view of the same type first and mirror its structure.

### Which door (MCP)

- Create a view → `synap_create_view`.
- A kind's lifecycle as a board → `synap_create_view` with `type: "pipeline"` and `config: { profileSlug }`. The columns are the kind's declared statuses, never config: a kind with no lifecycle is refused, so declare it first (`synap_declare_lifecycle`).
- Change a view after create (rename it, a bento's `config.blocks`, a kanban's grouping) → `synap_update_view` with the whole new config. Each bento block is stored as `{ id, kind: "widget", widgetType, config, pos: { x, y, w, h } }` (a recipe's `{ key, config, x, y, w, h }` is `widgetType: key`, `pos: { x, y, w, h }`). Every widget you add or change is checked against the widget catalog before anything is filed (blocks kept unchanged are not); an agent's edit is a proposal.
- Whiteboard shapes → `synap_update_view_content`.
- What a space opens on → `synap_set_start_page`: a cell `synap_list_widgets` lists for that space, or a website `url` (with `podAppClientId` for a pod app).

The Hub REST twins: `POST /views`, `PATCH /views/:viewId`, `POST /views/:viewId/arrange`.
