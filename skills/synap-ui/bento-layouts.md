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
        "pos": { "x": 0, "y": 0, "w": 8, "h": 4 } },
      { "id": "b2", "kind": "entity", "entityId":   "<entityId>",
        "pos": { "x": 8, "y": 0, "w": 4, "h": 4 } },
      { "id": "b3", "kind": "widget", "widgetType": "quick-access",
        "pos": { "x": 0, "y": 4, "w": 6, "h": 2 },
        "config": {} },
      { "id": "b4", "kind": "widget", "widgetType": "stat-card",
        "pos": { "x": 6, "y": 4, "w": 6, "h": 2 },
        "config": { "profileSlug": "note", "label": "Notes this week", "timePeriod": "week" } }
    ]
  }
}
```

Block kinds:

- `view` — embeds a saved view by `viewId`
- `entity` — renders an entity card for a specific `entityId`
- `widget` — renders a catalog cell by `widgetType` (a key from `synap_list_widgets`) with `config`; `pos` places every block

Full widget catalog in **`widget-catalog.md`**. Layout patterns in **`bento-recipes.md`**.
