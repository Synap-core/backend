## Linking — the core principle

**Never create orphan entities.** A task alone is near-useless. A task linked to a project, an assignee, and the source document shows up in traversals, context panels, and downstream queries.

Two ways to connect. Pick one:

**Way 1 — entity_id properties (fast path, auto-syncs).** Set the property when creating the entity. For system profiles this auto-creates a row in the relations table.

```json
POST /api/hub/entities
{
  "userId": "{userId}",
  "workspaceId": "{workspaceId}",
  "profileSlug": "task",
  "title": "Design new onboarding flow",
  "properties": {
    "status": "todo",
    "priority": "high",
    "projectId": "ent_abc",    // auto-creates belongs_to_project relation
    "assignee":  "usr_def"     // auto-creates assigned_to relation
  }
}
```

**Way 2 — explicit relations.** For custom links, after-the-fact connections, or anything without a matching entity_id property.

```json
POST /api/hub/relations
{
  "userId": "{userId}",
  "sourceEntityId": "ent_task",
  "targetEntityId": "ent_document",
  "type": "references"
}
```

For auto-sync mapping, conventional relation types, and edge cases, read **`linking.md`**.
