## Creating properties

```json
POST /api/hub/property-defs
{
  "userId":      "{userId}",
  "workspaceId": "{workspaceId}",
  "profileId":   "{profileId}",    // the profile this property belongs to
  "slug":        "durationMinutes",
  "valueType":   "number",
  "constraints": { "min": 0, "max": 600 },
  "uiHints":     { "format": "compact", "displayName": "Duration" }
}
```

Value types: `string`, `number`, `boolean`, `date`, `entity_id`, `array`, `object`, `secret`. Full reference in **`property-types.md`**.

For linking properties, always use `entity_id` with `targetProfileSlug` in constraints:

```json
{
  "slug": "hostId",
  "valueType": "entity_id",
  "constraints": { "targetProfileSlug": "person" },
  "uiHints": { "displayName": "Host" }
}
```

This enables auto-sync (see `../synap/linking.md`) — the property becomes a typed link that shows up in graph traversals automatically.
