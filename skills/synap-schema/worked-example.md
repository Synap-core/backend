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
