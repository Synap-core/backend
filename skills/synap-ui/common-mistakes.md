## Common mistakes — UI generation

1. **Creating a workspace without asking.** Always propose + confirm. Workspaces are too big to auto-commit.
2. **Guessing widget kinds.** Always `GET /widget-definitions` first. A `kind` that isn't in the registry won't render.
3. **Reinventing views.** Check existing views first — a kanban for tasks probably exists.
4. **Creating a new profile when UI is the real need.** Don't create `client` profile for a "contacts who are clients" view — just create a filtered view on `contact`.
5. **Putting unrelated data in one bento.** A bento tells a story ("my week", "this project", "content pipeline"). Kitchen-sink bentos overwhelm the user.
6. **Ignoring color/icon.** Profiles and workspaces both take `uiHints.icon` and `uiHints.color` — set them. Untitled gray workspaces feel like a bug.
7. **Hardcoding config for view types you haven't checked.** Each view type's `config` shape is different. Get an example from `/views` first.
8. **Forgetting entityScope implications.** A view on a pod-scope profile (`note`) will show entities from every workspace the user can access — filter appropriately if you want workspace-local results.
