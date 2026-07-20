---
name: synap-schema
description: >
  Use this skill when the user needs to extend Synap's data model — defining a
  new type of thing (entity profile) or adding/modifying fields (property defs)
  on existing types. Triggers: "I need a new type for podcasts/recipes/workouts/
  clients/books/plants/investments", "add a priority field to tasks", "create a
  property for tracking budget", "I want to track Y and it's not in my current
  schema", defining custom relations, setting up a profile for a specific domain
  (real estate, music production, research, fitness, cooking). Also triggers on:
  "do I already have a profile for X?", "what fields does <profile> have?",
  extending an existing profile with workspace-specific overlay properties.
  Do NOT use this skill for creating instances of existing types — the core
  `synap` skill handles that. This skill changes the SCHEMA, not the data.
metadata:
  openclaw:
    requires:
      env: [SYNAP_HUB_API_KEY, SYNAP_POD_URL]
    primaryEnv: SYNAP_HUB_API_KEY
    homepage: https://synap.live
    capabilities: [schema, profiles, properties]
    os: [macos, linux, windows]
    userInvocable: false
---

# Synap — schema extension

You extend a user's Synap pod schema: new entity profiles, new properties on existing profiles, overlay properties scoped to one workspace. The core rule: **reuse before extending.** Creating duplicate profiles fractures the graph.

---

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

---

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

---

## Discover profiles — never assume

**Always call `GET /api/hub/profiles?workspaceId={workspaceId}` first.** Profiles are dynamic — every pod and workspace has a different set depending on what was seeded and what the user created. Never assume a profile slug exists without verifying.

```
GET /api/hub/profiles?workspaceId={workspaceId}
  → [{ slug, displayName, entityScope, parentSlug,
       properties: [{ slug, valueType, required, ... }] }]
```

Read the response:

- `entityScope: "pod"` — visible across all workspaces
- `entityScope: "workspace"` — scoped to this workspace only (custom types, CRM profiles, template-seeded types)
- `parentSlug` — inheritance chain (e.g. `contact` extends `person`)

### Commonly seeded profiles (verify before using)

Standard pods typically include: `note`, `task`, `project`, `event`, `person`, `contact`, `company`, `bookmark`, `website`, `article`, `capture`, `file`, `anchor`, `decision`, `question`, `research`

CRM workspaces additionally have: `deal`, `client` — but **only** when a CRM workspace was created.  
Custom workspace templates (devplane, content, etc.) add their own profiles entirely.

Before creating a new profile: **does one of these already fit?** A podcast episode is arguably an `article`. A meeting is an `event`. A book to read is an `article` or `bookmark`. Err on the side of reuse + extension, not creation.

---

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

---

## Creating a new profile

```json
POST /api/hub/profiles
{
  "userId":          "{userId}",
  "workspaceId":     "{workspaceId}",
  "slug":            "podcast_episode",     // snake_case, unique
  "displayName":     "Podcast Episode",
  "description":     "An episode of a podcast the user listens to",
  "parentProfileId": "<id of article or null>",  // optional, enables inheritance
  "defaultValues":   { "status": "queued" },
  "uiHints":         { "icon": "mic", "color": "purple" }
}
```

Then add properties one by one (see below). You do NOT declare properties inline on the profile — they're separate rows.

---

## Creating properties

```json
POST /api/hub/property-defs
{
  "userId":      "{userId}",
  "workspaceId": "{workspaceId}",
  "profileId":   "{profileId}",    // the profile this property belongs to
  "slug":        "durationMinutes",
  "valueType":   "number",
  "constraints": { "min": 0, "max": 600 },
  "uiHints":     { "format": "compact", "displayName": "Duration" }
}
```

Value types: `string`, `number`, `boolean`, `date`, `entity_id`, `array`, `object`, `secret`. Full reference in **`property-types.md`**.

For linking properties, always use `entity_id` with `targetProfileSlug` in constraints:

```json
{
  "slug": "hostId",
  "valueType": "entity_id",
  "constraints": { "targetProfileSlug": "person" },
  "uiHints": { "displayName": "Host" }
}
```

This enables auto-sync (see `../synap/linking.md`) — the property becomes a typed link that shows up in graph traversals automatically.

---

## Workspace overlay properties

New concept (2026-04-10+). A single profile (say `task`) can have **different fields in different workspaces** without copying the profile. Set `overlay: true` on `POST /property-defs`:

```json
POST /api/hub/property-defs
{
  "userId":      "{userId}",
  "workspaceId": "{workspaceId}",
  "profileId":   "{taskProfileId}",
  "slug":        "billableHours",
  "valueType":   "number",
  "overlay":     true               // this property only appears in this workspace
}
```

Use cases:

- "My consulting workspace needs `billableHours` on tasks; my personal workspace doesn't."
- "Our sales workspace wants a `dealSize` on contacts; engineering doesn't."

Overlays don't leak: workspace A can't see workspace B's overlay properties even though both share the profile. For the full scope model, read **`property-types.md`** §Overlay.

---

## Entity scope (pod-wide vs. workspace-scoped)

Profiles have an `entityScope` that determines where entities of that type live:

- `entityScope: "pod"` — entities are pod-wide, visible in every workspace the user can access. Good for people, companies, notes, articles — things that cross contexts.
- `entityScope: "workspace"` — entities live in the workspace they were created in. Good for deals, files, workspace-specific artifacts.

Defaults to `workspace` if not set on the profile. The user can toggle this per profile in ProfileEditor Settings. If you're creating a profile for something clearly pod-wide (a person, a podcast the user follows, a book in their library), set `entityScope: "pod"` explicitly.

---

## Custom relations

If the user wants a typed edge that isn't in the convention list (see `../synap/linking.md`), you can define it:

```json
POST /api/hub/relation-defs
{
  "userId":        "{userId}",
  "workspaceId":   "{workspaceId}",
  "slug":          "mentored_by",
  "displayName":   "Mentored by",
  "sourceProfileSlug": "person",
  "targetProfileSlug": "person",
  "bidirectional": false
}
```

Defining a relation def is rarely worth it — `related_to` + a property usually suffices. Only create one when the relationship is semantic enough that UI should treat it specially (e.g., show "mentored by Jane" on a person's profile card).

---

## Worked example — "I want to track podcasts I listen to"

1. Inventory. `GET /profiles` → no `podcast` profile, no `podcast_episode`.
2. Decide scope. Podcasts/episodes are pod-wide (same podcast across workspaces).
3. Create two profiles (podcast + episode) or one (episode only, with the show as a string property)? Decide based on the user's intent. If they want to group episodes by show → two profiles. If one-level is enough → one.
4. For two profiles:

   ```
   POST /profiles { slug: "podcast", displayName: "Podcast", entityScope: "pod", uiHints: { icon: "radio" } }
   POST /profiles { slug: "podcast_episode", displayName: "Podcast Episode", parentProfileId: <articleId>, entityScope: "pod" }
   ```

5. Add properties on `podcast`:

   ```
   POST /property-defs { slug: "host",      valueType: "string" }
   POST /property-defs { slug: "rssUrl",    valueType: "string", uiHints: { inputType: "url" } }
   POST /property-defs { slug: "category",  valueType: "string" }
   ```

6. Add properties on `podcast_episode`:

   ```
   POST /property-defs { slug: "podcastId",       valueType: "entity_id", constraints: { targetProfileSlug: "podcast" } }
   POST /property-defs { slug: "durationMinutes", valueType: "number" }
   POST /property-defs { slug: "listenedAt",      valueType: "date" }
   POST /property-defs { slug: "rating",          valueType: "number", constraints: { min: 1, max: 5 } }
   ```

7. Tell the user. "I added `podcast` and `podcast_episode` to your pod with linking between them. You can create your first episode now, or want me to also add a view for it?" (Hand off to the `synap-ui` skill if they say yes.)

---

## Common mistakes — schema extension

1. **Creating a profile that already exists (e.g., `meeting` when `event` fits).** Always inventory first.
2. **Declaring properties inline on the profile object.** Properties are separate rows; use `POST /property-defs`.
3. **Using `string` for what should be `entity_id`.** If the field refers to another entity (host of a podcast), use `entity_id` + `targetProfileSlug` — enables auto-sync and link UX.
4. **Using `array` of strings for tags.** Tags are a built-in concept; reuse the `tags` property on `note`/`project` instead of creating a parallel field.
5. **Forgetting `entityScope`.** Defaults to `workspace`. If the thing is pod-wide (people, books, podcasts), set it explicitly.
6. **Creating an overlay when a base property is wanted.** Overlays only appear in one workspace. If the user wants the field everywhere, don't set `overlay: true`.
7. **Creating a custom profile when extension would work.** `client extends contact` is cleaner than a parallel `client` profile.

---

## When you need more — schema extension

- Full `valueType` reference + constraints + uiHints → **`property-types.md`**
- Inheritance, overlay scope semantics, pod-wide caveats → **`property-types.md`** §Scope
- Creating views over the new profile → install the **`synap-ui`** skill
- Creating instances of the new profile → use the core **`synap`** skill
