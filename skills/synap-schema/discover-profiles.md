## Discover profiles — never assume

**Always call `GET /api/hub/profiles?workspaceId={workspaceId}` first.** Profiles are dynamic — every pod and workspace has a different set depending on what was seeded and what the user created. Never assume a profile slug exists without verifying.

```
GET /api/hub/profiles?workspaceId={workspaceId}
  → [{ slug, displayName, entityScope, parentSlug,
       properties: [{ slug, valueType, required, ... }] }]
```

Read the response:

- `entityScope: "pod"` — visible across all workspaces
- `entityScope: "workspace"` — scoped to this workspace only (custom types, CRM profiles, template-seeded types)
- `parentSlug` — inheritance chain (e.g. `contact` extends `person`)

### Commonly seeded profiles (verify before using)

Standard pods typically include: `note`, `task`, `event`, `person`, `contact`, `company`, `item`, `bookmark`, `website`, `article`, `capture`, `file`, `anchor`, `decision`, `question`, `research`. A **project is not a profile** — it is a row in `projects`. Roles (vendor, client, …) appear as `profileKind: role`.

CRM workspaces additionally have: `deal`, `client` — but **only** when a CRM workspace was created.  
Custom workspace templates (devplane, content, etc.) add their own profiles entirely.

Before creating a new profile: **does one of these already fit?** A podcast episode is arguably an `article`. A meeting is an `event`. A book to read is an `article` or `bookmark`. Err on the side of reuse + extension, not creation.
