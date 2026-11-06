## Apps are views of pod state

Model first, UI second. An app built on the pod never hard-codes a status, a status order, a stage or step list, or a status colour: it reads them from the declared lifecycle of the kind and from the playbook bound to the entity, and moving work is a pod write (status move, session or playbook action), never app-local state. For any new use case, consolidate the operation first (workspace, kinds, lifecycles, relations, linked playbooks), then draw the UI as a representation of it. Load `rules/apps-are-views-of-pod-state` (founder, 6 Nov 2026).

## Before you build anything

Always inventory. Never hallucinate view types, widget kinds, or profiles.

```
GET /api/hub/manifest
  → static capability map: view types, bento block kinds, inline patterns, browser-native cells
    (call once per session — no DB queries, safe to cache)

GET /api/hub/profiles?userId={userId}&workspaceId={workspaceId}
  → what data exists

GET /api/hub/widget-definitions?workspaceId={workspaceId}
  → [{ kind, category, label, description, configSchema, supportedContexts }]

GET /api/hub/views?userId={userId}&workspaceId={workspaceId}
  → [{ id, name, type, profileSlug, config }]
```

Widget definitions are the source of truth for which cells are installed and how to configure them. **Never guess cell kinds.** If a cell doesn't appear in the registry, don't reference it (unless it's a browser-native cell from the manifest).
