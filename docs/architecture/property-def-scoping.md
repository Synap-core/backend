# Property definition scoping

> Verified against code on 2026-10-20 (backend@cc4b2d81).

A property definition (`property_defs` row) can be global, belong to a profile,
or be a workspace's private addition to a profile. This page explains the three
scopes, how reads filter them, and how to debug "why doesn't my workspace see
this property?".

## The three scopes

| `profile_id` | `workspace_id` | Meaning                                                  |
| ------------ | -------------- | -------------------------------------------------------- |
| NULL         | NULL           | Global def: any profile, any workspace                   |
| set          | NULL           | Profile base: this profile, every workspace              |
| set          | set            | Workspace overlay: this profile, seen only by this space |
| NULL         | set            | Invalid; `PropertyDefRepository.create` stores NULL/NULL |

Overlays exist so a workspace can extend a profile it does not own (for example
add `investmentThesis` to the pod-wide `person`) without that field appearing in
every other workspace that renders `person`.

**Read rule.** When workspace W reads the defs of profile P it gets the global
defs, P's base defs, and W's own overlays on P. It never sees another
workspace's overlays.

## Schema

`property_defs` has `slug`, `profile_id` (FK `profiles`, cascade),
`workspace_id` (FK `workspaces`, cascade), `value_type`, `constraints`,
`ui_hints`, `relation_def_id` and `target_profile_id`. Uniqueness is enforced by
three mutually exclusive partial unique indexes, defined in
`packages/database/migrations/0000_baseline_schema.sql` (originally migration
0065):

- `property_defs_global_slug_uniq` on `(slug)` where both are NULL;
- `property_defs_profile_base_slug_uniq` on `(slug, profile_id)` where only
  `profile_id` is set;
- `property_defs_workspace_overlay_slug_uniq` on `(slug, profile_id, workspace_id)`
  where both are set.

The same slug can therefore exist once globally, once per profile, and once per
(profile, workspace) overlay.

The `profile_properties` junction (profile, property def, `required`,
`default_value`, `display_order`) has no workspace column on purpose: the def
carries the scope, and every read joins through `property_defs`. A second copy
of the scope would be a second source of truth.

## Read path

All effective-property reads go through
`ProfileResolutionService.getEffectiveProperties(profileId, workspaceId?)`
(`packages/database/src/services/profile-resolution-service.ts`):

1. walk the profile hierarchy (root to leaf);
2. load every `profile_properties` row for that hierarchy in one query;
3. load the referenced defs with `PropertyDefRepository.getManyByIds(ids, workspaceId)`,
   which applies the workspace filter in SQL;
4. merge in hierarchy order; a child overrides `required`, `defaultValue` and
   `displayOrder`.

The `workspaceId` argument has three meanings, used consistently by
`getManyByIds`, `listForProfiles` and `getBySlug`:

| Value       | Effect                                              |
| ----------- | --------------------------------------------------- |
| `undefined` | No workspace filter (admin and debug paths only)    |
| `null`      | Base and global defs only                           |
| a UUID      | Base and global defs plus that workspace's overlays |

User-facing reads must pass a workspace. Omitting it is reserved for admin
listings.

## Write path

- **Template install / reconcile**
  (`packages/database/src/utils/reconcile-workspace-from-definition.ts`): when a
  template creates a profile, its property defs are written as base defs (the
  profile row already carries its own scope). When the template reuses an
  existing pod profile, the template's extra properties are written as overlays
  of the workspace being created (`overlayWorkspaceId = profileIsReused ? workspaceId : null`).
- **API.** The tRPC `propertyDefs.create` procedure
  (`packages/api/src/routers/property-defs.ts`) and Hub Protocol
  `POST /api/hub/property-defs` (`routers/hub-protocol/rest/profiles.ts`) take
  `overlay: boolean`; with a `profileId` and `overlay: true` the def becomes an
  overlay of the calling workspace. The hub route clamps the workspace to the
  caller's confined workspace.
- `propertyDefs.get` takes `workspaceScope: 'any' | 'base' | 'current'` so a
  caller can address one scope deterministically; `'any'` (the default) returns
  the first match and is nondeterministic once overlays exist.
- `POST /api/hub/property-defs` is slug-idempotent and never edits an existing
  def; `PATCH /api/hub/property-defs/{id}` is the one edit door, and an agent
  caller gets a proposal.

## Writing an entity property another workspace owns

`validateProperties` reads defs through the writer's workspace lens. A key that
is another workspace's overlay is treated as an unknown property: it is stored
in the entity's JSONB properties but not validated or indexed in
`entity_property_index`. This is deliberate: rejecting the write would reveal
that another workspace has that field.

## Debug queries

Every def on a profile, by scope:

```sql
SELECT pd.slug,
       CASE WHEN pd.profile_id IS NULL AND pd.workspace_id IS NULL THEN 'global'
            WHEN pd.workspace_id IS NULL THEN 'profile-base'
            ELSE 'overlay' END AS scope,
       pd.workspace_id, w.name AS workspace_name
FROM property_defs pd
LEFT JOIN workspaces w ON w.id = pd.workspace_id
WHERE pd.profile_id = (SELECT id FROM profiles WHERE slug = 'person' LIMIT 1)
ORDER BY pd.workspace_id NULLS FIRST, pd.slug;
```

What workspace X sees on profile Y (profile-linked defs only):

```sql
SELECT pd.slug, pd.value_type, pd.workspace_id IS NOT NULL AS is_overlay
FROM property_defs pd
WHERE pd.profile_id = :profile_id
  AND (pd.workspace_id IS NULL OR pd.workspace_id = :workspace_id)
ORDER BY pd.slug;
```

Check that the scoping indexes exist on a pod:

```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'property_defs';
```

## Common questions

- **A field I added in one workspace is missing in another.** Expected: it is an
  overlay. If every workspace should see it, it must be a base def
  (`overlay: false`).
- **I need every def regardless of workspace.** Call the repository without a
  `workspaceId` (`listForProfiles(ids)` or `getManyByIds(ids)`); keep that to
  admin paths.

## History

- 2026-04: "Phase 2" added `workspace_id` (migration 0065) and split slug
  uniqueness by profile (migration 0064). Before it, defs were global or
  profile-scoped, and a workspace that extended a shared profile leaked the field
  to every workspace.
- 2026-04-10: a follow-up pass routed automation entity updates through the
  repository, removed a duplicate property merge from view filter compilation
  (`ViewFilterCompiler.buildPropertyMetaMap`), and added the `overlay` and
  `workspaceScope` API parameters.
