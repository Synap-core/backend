## Before you touch anything

Always inventory first. Never assume the schema is empty.

```
GET /api/hub/profiles?userId={userId}&workspaceId={workspaceId}
  → [{ slug, displayName, entityScope, parentProfileSlug,
       properties: [{ slug, valueType, constraints, uiHints, targetProfileSlug? }] }]

GET /api/hub/property-defs?userId={userId}&workspaceId={workspaceId}&profileId={profileId}
  → [{ slug, valueType, constraints, uiHints, workspaceId /* null=base, uuid=overlay */ }]
```

The `synap` skill's `scripts/orient.sh` already fetches profiles — reuse its output.
