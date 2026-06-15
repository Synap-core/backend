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
