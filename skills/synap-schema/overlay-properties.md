## Workspace overlay properties

New concept (2026-04-10+). A single profile (say `task`) can have **different fields in different workspaces** without copying the profile. Set `overlay: true` on `POST /property-defs`:

```json
POST /api/hub/property-defs
{
  "userId":      "{userId}",
  "workspaceId": "{workspaceId}",
  "profileId":   "{taskProfileId}",
  "slug":        "billableHours",
  "valueType":   "number",
  "overlay":     true               // this property only appears in this workspace
}
```

Use cases:

- "My consulting workspace needs `billableHours` on tasks; my personal workspace doesn't."
- "Our sales workspace wants a `dealSize` on contacts; engineering doesn't."

Overlays don't leak: workspace A can't see workspace B's overlay properties even though both share the profile. For the full scope model, read **`property-types.md`** §Overlay.
