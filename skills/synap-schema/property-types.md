# Property types — reference

Every property on a profile has a `valueType`. This is the authoritative list, what each type stores, and how to configure it.

## Value types

### `string`

Plain text.

```json
{
  "slug": "email",
  "valueType": "string",
  "constraints": { "maxLength": 200, "pattern": "^.+@.+\\..+$" },
  "uiHints": { "inputType": "email" }
}
```

**uiHints.inputType variants:** `email`, `phone`, `url`, `person`, `richtext`, `select`, `datetime`, `datetime-local`.
**uiHints.displayAs variants:** `status`, `priority`, `progress`, `person` — used by list/table views for special badges.

### `number`

Integer or float.

```json
{
  "slug": "price",
  "valueType": "number",
  "constraints": { "min": 0, "max": 1000000 },
  "uiHints": { "format": "currency", "displayName": "Price" }
}
```

**uiHints.format:** `locale`, `currency`, `percent`, `compact`.

### `boolean`

True/false.

```json
{
  "slug": "isArchived",
  "valueType": "boolean",
  "uiHints": { "displayName": "Archived" }
}
```

### `date`

ISO 8601 date or datetime.

```json
{
  "slug": "dueDate",
  "valueType": "date",
  "uiHints": { "includeTime": false, "displayName": "Due" }
}
```

Set `includeTime: true` for datetime; false for date-only. Don't store durations as dates — use `number` in seconds/minutes.

### `entity_id`

**The important one.** A reference to another entity by UUID. Triggers the auto-sync behaviour (see `../synap/linking.md`).

```json
{
  "slug": "projectId",
  "valueType": "entity_id",
  "constraints": { "targetProfileSlug": "project" },
  "uiHints": { "linkedProfileSlug": "project", "displayName": "Project" }
}
```

**Always set `targetProfileSlug`** (or `targetProfileSlugs: [...]` for multi-target). Without it, UI can't render a picker and auto-sync defaults to `related_to`.

For linking to users (workspace members), use:

```json
{
  "slug": "assignee",
  "valueType": "entity_id",
  "constraints": { "targetProfileSlug": "person" },
  "uiHints": { "inputType": "person", "linkedTable": "workspace_members" }
}
```

### `array`

List of primitives OR list of entity references.

For tags / free-text lists:

```json
{
  "slug": "tags",
  "valueType": "array",
  "uiHints": { "itemValueType": "string" }
}
```

For multi-entity lists (e.g., event attendees):

```json
{
  "slug": "attendees",
  "valueType": "array",
  "uiHints": { "itemValueType": "entity_id", "linkedProfileSlug": "person" }
}
```

Arrays of entity IDs **don't auto-sync** — if you want bidirectional linking for each item, create explicit relations.

### `object`

Arbitrary JSON. Only for data that genuinely has no fixed schema.

```json
{ "slug": "metadata", "valueType": "object" }
```

Avoid when possible. Objects don't index well and can't be filtered in views. Prefer breaking out properties.

### `secret`

Like `string` but masked in UI, encrypted at rest, never returned in list responses.

```json
{ "slug": "apiToken", "valueType": "secret" }
```

Use for credentials stored on an entity (e.g., a connector's OAuth refresh token). Never put actual user data here — use `string`.

## Constraints

The `constraints` object is value-type specific:

| valueType   | Supported constraints                                         |
| ----------- | ------------------------------------------------------------- |
| `string`    | `minLength`, `maxLength`, `pattern` (regex), `enum: string[]` |
| `number`    | `min`, `max`, `integer: true`, `enum: number[]`               |
| `date`      | `min` (ISO), `max` (ISO)                                      |
| `entity_id` | `targetProfileSlug`, `targetProfileSlugs` (multi)             |
| `array`     | `minItems`, `maxItems`, `uniqueItems: true`                   |
| `object`    | (none — prefer breaking into typed properties)                |

Violations return a 400 from `POST /entities` with `{ error: "validation", field: "slug", issue: "..." }`.

## uiHints reference

```ts
{
  displayName?: string          // Label in UI forms and views
  placeholder?: string          // Input placeholder
  inputType?: "email" | "phone" | "url" | "person" | "richtext"
             | "datetime" | "datetime-local" | "select"
  displayAs?: "status" | "priority" | "progress" | "person"
  format?:    "locale" | "currency" | "percent" | "compact"
  includeTime?: boolean         // date only
  linkedProfileSlug?: string    // entity_id rendering
  linkedTable?: "workspace_members" | "free_text"
  itemValueType?: "string" | "number" | "boolean" | "date" | "entity_id" | "url"
  pluginHints?: Record<string, unknown>  // freeform for custom cells
}
```

uiHints are cosmetic — they change rendering, not validation. If you need enforcement, use `constraints`.

## Scope — three layers

Every property def has two scope dimensions:

| `profileId` | `workspaceId` | Layer             | Who sees it                            |
| ----------- | ------------- | ----------------- | -------------------------------------- |
| null        | null          | Global            | Every workspace, every profile         |
| set         | null          | Profile-base      | Every workspace that uses this profile |
| set         | set           | Workspace overlay | Only that workspace                    |

The rendering rule for a given `(profile, workspace)`:

```
visible = global  ∪  profile-base  ∪  this-workspace's overlays on this profile
```

Other workspaces' overlays are filtered out at SQL level.

### When to use each

- **Global** (rare): properties that apply to all entity types (e.g., `createdBy`, `tags`). System only.
- **Profile-base** (default): the property should appear for everyone using this profile. Creating a property for a workspace-owned profile → profile-base.
- **Overlay**: the property is specific to one workspace extending a shared profile. Pass `overlay: true` in `POST /property-defs`.

If you're extending a pod-wide profile (like `task` or `contact`) with a workspace-specific field, you **must** use overlay — otherwise you'd pollute every workspace.

Entities can carry overlay property values even in workspaces that don't see the overlay — the values are preserved but invisible. This is by design.

## Inheritance

If a profile has `parentProfileSlug`, it inherits the parent's property defs. Own properties override parent properties by slug.

Example: `contact` has `parentProfileSlug: "person"`. A contact entity has both `person.email` and `contact.role`. Set `email` on a contact and you satisfy the parent schema.

When creating a child profile, don't re-declare the parent's properties. Only add what's new.

## Validation semantics

On `POST /entities` and `PATCH /entities`:

1. Compute effective properties = profile-base ∪ global ∪ workspace overlays.
2. For each property in the request body, check the def exists and the value passes `valueType` + `constraints`.
3. Unknown properties (not in any layer) are stored in JSONB but never rendered. Avoid — they rot.

Properties not in the request body are not cleared. Use `PATCH` with `{ "properties": { "x": null } }` to explicitly unset.

## Performance note

Every entity_id property is indexed via `entity_property_index.value_entity_id` for fast reverse-lookup ("find all entities whose `projectId` is X"). This is what makes Way 1 cheap at scale. Inventing a string property with UUIDs inside will work but won't be indexed — use `entity_id`.

## Common mistakes

- Using `string` for what should be `entity_id` (loses auto-sync + reverse-lookup).
- Omitting `constraints.targetProfileSlug` on `entity_id` props (breaks pickers, breaks auto-sync routing).
- Creating an `array` of entity_ids and expecting bidirectional linking (it doesn't — use explicit relations).
- Using `object` when two `string` properties would suffice.
- Reusing `tags` as an entity_id list (tags is free-text by convention; make a new `relatedProjects` property instead).
- Overriding parent profile properties with weaker types (child `email` as `object` when parent is `string`) — creates validation drift.
