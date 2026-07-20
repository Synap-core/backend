## Read before you write

Synap data is a typed graph — never write blind. Before creating or updating an
entity, work the loop the same way you'd read a file before editing it:

1. **MAP** — know what types exist: `list_profiles` (the cheap map of entity
   profiles), `list_views` for views.
2. **SEARCH** — `search_unified({ query: <title>, collections: ["entities"] })`.
   If a close match exists, LINK to it (relation or entity_id property) — do NOT
   create a duplicate. Create only when there is genuinely no match.
3. **READ THE SCHEMA** — before writing to a profile you haven't inspected this
   session, call `get_profile({ slug })` for its real property defs (exact keys,
   value types, enum options, link targets). For views, read the config
   (`get_bento_schema`) before `create_view`.
4. **WRITE INTO THE REAL FIELDS** — map each value to its correct typed property:
   right `key`, valid `valueType` (dates as ISO, numbers as numbers), enum values
   that satisfy the constraint, links via the property's `linksTo` target. Don't
   invent property keys. A value with no matching property goes into
   description/content, or propose a new one with `create_property_def` — never
   drop it into a stray key.
5. **CONNECT** — every new entity links to at least one other. Duplicates and
   orphans are the two ways the graph degrades; avoid both.

## Complete intent, governed outcome

`title` + `content` is only a minimum payload, not Synap's data model. Once
you have read the schema, send the complete intent that is known: `profileSlug`,
title, typed `properties`, short `description`, long-form `content`, an existing
`projectId`, links, and source/session provenance. Include role `facets` in the
same composite plan whenever they must be reviewed with the entity.

- **One entity with known fields and no creation-time role change** → use
  `create_entity` / `POST /entities`.
- **Several entities, facets, or relations that belong in one review** → use the
  composite graph/capture-plan door, never a loose sequence of creates.
- **Raw input whose structure is unknown** → use capture to produce a plan;
  preserve an original file with `keepRaw` when supplied. Raw source is not the
  same thing as an entity's edited content.

Workspace is an explicit lens: omit it to read the pod/base schema and let the
profile's placement rule apply. Pass a workspace only when the user or a
reviewed routing decision actually selected it; then its overlays are valid.
Never fill it from a configured/default workspace.

Read the write receipt before continuing. `pending` means a proposal exists and
no entity has materialized; `applied` means the reported operations completed;
`partial` means independent follow-up operations failed and must be repaired or
surfaced. Do not send a speculative second update merely because a write
completed — enrich only when you learned genuinely new information or the
receipt identifies a specific missing field.
