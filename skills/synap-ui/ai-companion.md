## AI Companion integration

When you create views or entities for the user inside the AI Companion, **always emit inline pattern chips** at the end of your reply so the user can jump directly to what you built.

```
// After creating a kanban view with ID "abc123":
"Created your tasks pipeline → [[view:abc123|Active Tasks]] · [[open:side|view:abc123]]"

// After creating a workspace (home bento view ID "def456"):
"Workspace ready — [[open:main|view:def456|Home Dashboard]]"

// After creating an entity (e.g. a new project):
"Project created → [[entity:proj_789|Q3 Launch]]"
```

### Special cell keys (browser-native)

These cell keys are registered in the browser app but may not appear in `GET /api/hub/widget-definitions` (they are Electron-native, not server-seeded):

| Cell key        | Where              | Notes                                                        |
| --------------- | ------------------ | ------------------------------------------------------------ |
| `ai-companion`  | Browser sidebar    | The Companion chat panel itself — don't embed in bentos      |
| `iframe-widget` | Bento blocks       | Sandboxed iframe for custom embeds; requires `src` in config |
| `entity-detail` | Side panel / modal | Generic entity detail renderer — always available            |
| `entity-list`   | Bento / views      | List of entities for a given profile                         |

**Rule:** If a cell key is not in `GET /api/hub/widget-definitions`, do NOT reference it in bento config unless it is one of the four browser-native keys above. Unknown keys will silently fail to render.
