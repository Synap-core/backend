# Linking — reference

Two mechanisms connect entities in Synap. This file covers when to use which, auto-sync behaviour, and relation conventions.

## Auto-sync table (ENTITY_ID properties → relations)

When a profile property has `valueType: "entity_id"`, setting it on entity creation or update automatically writes a row in the `relations` table. No second call needed.

Known system-profile auto-syncs:

| Profile | Property    | Target profile | Auto-relation type   |
| ------- | ----------- | -------------- | -------------------- |
| task    | `projectId` | project        | `belongs_to_project` |
| task    | `assignee`  | person         | `assigned_to`        |
| contact | `companyId` | company        | `works_at`           |
| deal    | `contactId` | contact        | `deal_for`           |

Custom profiles: an `entity_id` property does NOT create an edge on its own. Auto-sync writes a relation only when the property def is mapped to a relation def (its `relationDefId`), and the edge then takes THAT def's slug. An unmapped `entity_id` property stores the id and creates no relation at all — there is no default or fallback type. When you need the edge, create it explicitly (Way 2) with an existing relation-def slug; `synap_list_profiles` returns them under `relationTypes`.

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

## Relation types — use the pod's, never invent one

A relation's `type` must be the slug of a relation definition the pod has. `synap_list_profiles` returns them under `relationTypes` (custom ones a workspace added included) — read it before linking. The defaults every pod ships:

| Type                                        | Direction       | When                                                                                                                                                                                      |
| ------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relates_to`                                | bidirectional   | Generic association, when no stronger type fits                                                                                                                                           |
| `references`                                | source → target | A task references a document, a note cites an article                                                                                                                                     |
| `mentions`                                  | source → target | One entity is mentioned within another's content                                                                                                                                          |
| `links_to`                                  | source → target | A hyperlink or explicit pointer                                                                                                                                                           |
| `parent_of`                                 | source → target | Entity hierarchy (a kind instance of another). Not nested projects — those do not exist. A method in a project is a track; a unit of work is a session.                                   |
| `belongs_to_project`                        | source → target | An entity filed into a project (prefer the `projectId` property — Way 1)                                                                                                                  |
| `assigned_to`                               | source → target | A task/project assigned to a person                                                                                                                                                       |
| `created_by`                                | source → target | A note/document authored or created by a person                                                                                                                                           |
| `blocks` / `depends_on`                     | source → target | A DEPENDENCY: the source blocks / waits on the target. Dependencies are becoming ONE `blocked_by` edge across kinds (session · entity · track); these two slugs are its entity-side names |
| `tagged_with`                               | source → target | Categorization by a tag entity                                                                                                                                                            |
| `attended_by`                               | source → target | An event's participant                                                                                                                                                                    |
| `works_at` · `works_on` · `affiliated_with` | source → target | A person and an organization / a project they contribute to / an affiliation                                                                                                              |
| `knows` · `met_at` · `discussed_with`       | person → target | People who know each other / where they met / who they talked with                                                                                                                        |
| `deal_for`                                  | source → target | A sales deal for a contact                                                                                                                                                                |
| `has_skill`                                 | source → target | A person's skill                                                                                                                                                                          |

**No fitting type? Do not invent one.** A slug that is not a relation definition is refused or lands as a link nobody can read. Use `relates_to` plus a more specific property or document, or — if the relationship recurs and deserves a name — propose a new relation definition (it is a schema change, reviewed like one).

## Decision table

| Situation                                              | Use                       |
| ------------------------------------------------------ | ------------------------- |
| Profile has matching `valueType: "entity_id"` property | Way 1 — set the property  |
| Linking two already-existing entities                  | Way 2 — create a relation |
| Custom connection, no matching property                | Way 2                     |
| Unsure whether a property exists                       | `GET /profiles` first     |
| Linking a document to the entity it is about           | Way 2 — `references`      |
| Multi-party link (entity A ↔ entity B ↔ entity C)      | Two relations, both Way 2 |

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

- **Spinning up a new project instead of linking into an existing one.** A project is a **commitment with gravity**, not a folder for a task, plan, repo, or theme (those are entities). Before `create_project`, search existing projects and file the entity into one via `belongs_to_project` (Way 1 `projectId`, or Way 2 relation). Near-duplicate project names are rejected server-side with the existing candidates, and an agent-created project also requires **≥5 existing entities** as evidence.
- **Creating an orphan, then forgetting to link it.** Every `POST /entities` should include properties that link, OR be immediately followed by a `POST /relations`. Never close the operation with a disconnected node.
- **Double-linking.** If you set `properties.projectId` AND also `POST /relations` with type `belongs_to_project`, the auto-sync already did it. Don't duplicate.
- **Using `relates_to` when a specific type fits.** `relates_to` is the fallback. `created_by`, `depends_on`, `references` carry more meaning to both the user and downstream views.
- **Inventing a relation type.** `child_of`, `belongs_to`, `authored_by`, `part_of`, `works_with` are NOT relation types here — use `parent_of` (from the parent), `belongs_to_project`, `created_by`, `parent_of` / `relates_to`, `knows`. Check `relationTypes` first.
- **Inverting direction.** Source is "the thing doing the action or owning the relationship." `task depends_on task` means the source is blocked by the target. Check twice.
