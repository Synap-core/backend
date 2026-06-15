## Garden the graph — writes tell you their impact (the circling of action)

A write is no longer blind. When you create or update an entity, the response tells you what it did to the graph — **READ it and act**, so the graph stays connected instead of accumulating isolated, duplicated nodes.

**On create**, the response carries a `resolution` block:

- `existingSameProfile` — an entity with this exact name ALREADY exists as the same profile. Prefer **updating** it (`synap set entity <id>` · `PATCH /api/hub/entities/:id` · `update_entity`) over creating a duplicate.
- `autoConnected` — same-name entities of a DIFFERENT profile are facets of one real thing, and the system has already woven them together with a `same_subject` relation. Acknowledge it; add a more specific relation if the real relationship is narrower than "same subject".
- `suggestions` — entities worth linking. Create the relations that genuinely apply (`synap create relation` · `POST /api/hub/relations` · `create_relation`).

**On update**, the response carries an `impact` block — the entity's immediate relation neighbors. Read it and resolve secondary effects: supersede a now-stale entity, update its dependents, re-link.

**The circling of action** for any structural write (updating the vision, the architecture, a decision record, a codebase map):

1. **Write** — the response shows collisions + connections; don't ignore it.
2. **If it already exists** (`existingSameProfile`) → update it, don't duplicate.
3. **The same-name facets are auto-woven** (`autoConnected`) → extend the links where the relationship is more specific than `same_subject`.
4. **Act on `suggestions`** → link what genuinely relates.
5. **On update** → resolve the `impact` neighbors (supersede / update / re-link).

The principle: **more data is better when it is structured.** The graph now helps you keep it structured — never leave an entity isolated, never blindly overwrite. (Matching is exact-name today; it will deepen over time — so still link deliberately when you know two things relate but their names differ.)
