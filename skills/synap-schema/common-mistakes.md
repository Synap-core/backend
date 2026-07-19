## Common mistakes — schema extension

1. **Creating a profile that already exists (e.g., `meeting` when `event` fits).** Always inventory first.
2. **Declaring properties inline on the profile object.** Properties are separate rows; use `POST /property-defs`.
3. **Using `string` for what should be `entity_id`.** If the field refers to another entity (host of a podcast), use `entity_id` + `targetProfileSlug` — enables auto-sync and link UX.
4. **Using `array` of strings for tags.** Tags are a built-in concept; reuse the `tags` property on `note`/`project` instead of creating a parallel field.
5. **Forgetting `entityScope`.** Defaults to `workspace`. If the thing is pod-wide (people, books, podcasts), set it explicitly.
6. **Creating an overlay when a base property is wanted.** Overlays only appear in one workspace. If the user wants the field everywhere, don't set `overlay: true`.
7. **Creating a custom profile when extension would work.** `client extends contact` is cleaner than a parallel `client` profile.
