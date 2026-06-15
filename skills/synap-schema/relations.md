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
