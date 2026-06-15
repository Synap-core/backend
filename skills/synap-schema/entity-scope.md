## Entity scope (pod-wide vs. workspace-scoped)

Profiles have an `entityScope` that determines where entities of that type live:

- `entityScope: "pod"` — entities are pod-wide, visible in every workspace the user can access. Good for people, companies, notes, articles — things that cross contexts.
- `entityScope: "workspace"` — entities live in the workspace they were created in. Good for deals, files, workspace-specific artifacts.

Defaults to `workspace` if not set on the profile. The user can toggle this per profile in ProfileEditor Settings. If you're creating a profile for something clearly pod-wide (a person, a podcast the user follows, a book in their library), set `entityScope: "pod"` explicitly.
