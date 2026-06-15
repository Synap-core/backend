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
