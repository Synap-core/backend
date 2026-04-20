# Linking — reference

Two mechanisms connect entities in Synap. This file covers when to use which, auto-sync behaviour, and relation conventions.

## Auto-sync table (ENTITY_ID properties → relations)

When a profile property has `valueType: "entity_id"`, setting it on entity creation or update automatically writes a row in the `relations` table. No second call needed.

Known system-profile auto-syncs:

| Profile  | Property    | Target profile | Auto-relation type   |
| -------- | ----------- | -------------- | -------------------- |
| task     | `projectId` | project        | `belongs_to_project` |
| task     | `assignee`  | person         | `assigned_to`        |
| contact  | `companyId` | company        | `works_at`           |
| deal     | `contactId` | contact        | `deal_for`           |
| deal     | `companyId` | company        | `deal_with`          |
| document | `entityId`  | (any)          | `attached_to`        |
| anchor   | `channelId` | (channel)      | `anchored_in`        |

Custom profiles: if you created a property with `valueType: "entity_id"`, the auto-sync kicks in, but the relation type defaults to `related_to` unless the profile defines a `relationDefinition`. When precision matters, create the relation explicitly (Way 2) with a specific `type`.

**Do not trust this table to stay current.** Always verify with `GET /api/hub/profiles` — the returned profile includes `properties[].valueType` and `properties[].targetProfileSlug`. Any property with `valueType: "entity_id"` is an auto-sync candidate.

## Way 1 — set the property

```json
POST /api/hub/entities
{
  "userId": "{userId}",
  "workspaceId": "{workspaceId}",
  "profileSlug": "task",
  "title": "Finalize Q2 plan",
  "properties": {
    "projectId": "ent_project_q2",   // one call, two rows written
    "assignee":  "usr_antoine"
  }
}
```

After this single call, these all work:

```
GET /entities/ent_project_q2/connections  → task appears
GET /relations?entityId=ent_project_q2     → belongs_to_project row appears
GET /graph/traverse?entityId=ent_project_q2 → task included as node
```

Use Way 1 whenever a matching entity_id property exists on the profile. It is cheaper and semantically typed.

## Way 2 — explicit relations

For:

- Links between two already-existing entities (after creation)
- Custom connections where no entity_id property exists
- Cross-type links not captured by the schema (e.g., task → document, entity → bookmark)
- Links involving custom profiles without a relationDefinition

```json
POST /api/hub/relations
{
  "userId":        "{userId}",
  "workspaceId":   "{workspaceId}",
  "sourceEntityId": "ent_source",
  "targetEntityId": "ent_target",
  "type":          "references"
}
```

## Conventional relation types

String-typed, case-insensitive by convention. Use these first before inventing new ones — workspace UI often renders known types specially.

| Type           | Direction       | When                                              |
| -------------- | --------------- | ------------------------------------------------- |
| `related_to`   | bidirectional   | Generic association, no stronger label fits       |
| `parent_of`    | source → target | Hierarchy (project parent of sub-project)         |
| `child_of`     | source → target | Hierarchy (inverse of parent_of)                  |
| `belongs_to`   | source → target | Membership                                        |
| `authored_by`  | source → target | Note/document authored by a person                |
| `depends_on`   | source → target | Task blocked by another task, project needs input |
| `references`   | source → target | Task references a document, note cites an article |
| `mentions`     | source → target | Entity mentioned within another entity            |
| `works_with`   | bidirectional   | People who collaborate                            |
| `part_of`      | source → target | Component relationship                            |
| `from_meeting` | source → target | Any entity extracted from a meeting/event         |
| `anchored_in`  | source → target | Anchor (pinned chat message) in a channel         |

If none fits, invent a snake_case verb. Keep it short and symmetric with existing verbs. Don't create `related-to-this-specific-thing` — prefer a generic `related_to` plus a more specific property or document.

## Decision table

| Situation                                              | Use                                    |
| ------------------------------------------------------ | -------------------------------------- |
| Profile has matching `valueType: "entity_id"` property | Way 1 — set the property               |
| Linking two already-existing entities                  | Way 2 — create a relation              |
| Custom connection, no matching property                | Way 2                                  |
| Unsure whether a property exists                       | `GET /profiles` first                  |
| Linking a document to its parent entity                | Use `entityId` on the document (Way 1) |
| Multi-party link (entity A ↔ entity B ↔ entity C)      | Two relations, both Way 2              |

## Reading the graph

```
# The complete picture — graph relations + property-derived links + thread refs
GET /api/hub/entities/{id}/connections
  → { connections: [{ entityId, entity, label, direction,
                      source: "graph"|"property"|"thread" }] }

# Raw graph relations only
GET /api/hub/relations?entityId={id}

# BFS neighborhood
GET /api/hub/graph/traverse?entityId={id}&maxDepth=2
  → { nodes: Entity[], edges: Relation[] }
```

**Prefer `/entities/{id}/connections`** when you want "everything connected to X" — it unifies property-derived links (which the raw relations table doesn't always surface for custom profiles) with graph relations and thread anchors.

`/graph/traverse` is best for "what's in the 2-hop neighborhood of this entity" — good for context gathering, but expensive at `maxDepth ≥ 3`.

## Common mistakes

- **Creating an orphan, then forgetting to link it.** Every `POST /entities` should include properties that link, OR be immediately followed by a `POST /relations`. Never close the operation with a disconnected node.
- **Double-linking.** If you set `properties.projectId` AND also `POST /relations` with type `belongs_to_project`, the auto-sync already did it. Don't duplicate.
- **Using `related_to` when a specific verb fits.** `related_to` is the fallback. `authored_by`, `depends_on`, `references` carry more meaning to both the user and downstream views.
- **Inverting direction.** Source is "the thing doing the action or owning the relationship." `task depends_on task` means the source is blocked by the target. Check twice.
