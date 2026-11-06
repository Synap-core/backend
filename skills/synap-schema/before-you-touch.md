## Apps are views of pod state

Model first, UI second. An app built on the pod never hard-codes a status, a status order, a stage or step list, or a status colour: it reads them from the declared lifecycle of the kind and from the playbook bound to the entity, and moving work is a pod write (status move, session or playbook action), never app-local state. For any new use case, consolidate the operation first (workspace, kinds, lifecycles, relations, linked playbooks), then draw the UI as a representation of it. Load `rules/apps-are-views-of-pod-state` (founder, 6 Nov 2026).

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
