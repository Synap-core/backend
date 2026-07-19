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
