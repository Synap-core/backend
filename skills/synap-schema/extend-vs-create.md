## When to extend an existing profile vs. create a new one vs. attach a facet

There are three moves, not two. Before extending or creating, ask whether the thing is really a **role** the entity plays rather than a new kind of entity at all — that's a facet, and it's the move people skip.

**Kind + Facets, the rule:** one entity = one kind (`profiles.profileKind = 'kind'`). Roles the entity plays — client, partner, investor, prospect — are role-profiles (`profileKind = 'role'`, `applicableKinds[]`) attached via `entity_facets`: additive, workspace-lensed, NOT entities. A facet cascades with its parent entity; only promote a role to a full kind if it accrues its own independent life.

**The litmus test:**

- Both sides of a connection are independently-alive kinds → it's a **relation** (e.g. person "works at" company — two entities, linked).
- One side is just wearing a hat with no independent lifecycle → it's a **facet** (e.g. "client" on a company — attach the role, don't create a new entity).
- The connection itself accrues its own multi-entity lifecycle (stages, money, deadlines, outcomes) → it gets **promoted to its own kind**. `deal` is the precedent: a buyer × seller × stage relationship-thing has its own life (pipeline stage, amount, close date) independent of either party, so it's kept as a primary kind, never a facet.

Attach when:

- The thing is a role/hat the entity is wearing (client, partner, investor, prospect, sponsor) — it has no properties or lifecycle independent of the parent entity
- AI-driven creation: resolve identity FIRST (strong signals — email, phone, url) before creating anything; if the entity already exists, `attach_facet` the new role onto it — never spin up a second entity for a hat

Extend when:

- The thing fits an existing category (a `client` **facet** is the role; if you instead need a distinct persisted sub-kind with its own fields, consider inheritance)
- The user needs 1–3 extra fields on an existing type
- The new fields are workspace-specific (use an overlay, see below)

Create new when:

- None of the system profiles fits, and it's not a role of an existing entity
- The thing has a clearly distinct set of properties (10+ fields)
- The domain model genuinely calls for a new first-class type (recipe, workout, podcast episode, investment, plant, medication, vehicle, property listing…)
- It's a relationship-thing that accrues its own independent lifecycle (the `deal` precedent above)

Prefer **inheritance** over new profiles when a system parent fits. `contact extends person` is the pattern — a new `client` profile can `parentProfileSlug: "contact"` and only add the fields that differ. But if `client` is really just a role a `company` or `person` plays (no independent properties of its own), it shouldn't be a profile at all — it's a facet, attached via `attach_facet`, never a second entity.
