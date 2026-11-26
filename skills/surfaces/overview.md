# Surfaces: one way to make UI on any pod object

Every UI on a pod is a **Surface**: a body anchored to an object (an entity, a kind, a space, a project, a goal, a playbook, a session). It opens with that object's context and brand.

- **Derived body**: the **View**, computed from a query and a config.
- **Composed bodies**: **Document** (text with live embeds), **Bento** (a responsive grid to monitor and operate), **HTML artifact** (a designed page or deck, read-only data), **Whiteboard** (a canvas to think together). Presenter is a mode that plays a document or a board as slides; it is not a body.
- Everything placed inside a composed body is a **Block**, one of three kinds: `view` (a saved view), `entity` (one record) or `cell` (a catalog or generated cell, `cellKey` + `props`).
- Two relations: **renders** = a kind's default look per slot (list, detail, card, dashboard), kind-level only; **attached** = 0..n extra surfaces on one object.

## The path: find, choose, create anchored, check, hand over

1. **Find.** `synap_find_surfaces` with the anchor `{kind, id}` lists what the object already carries: its kind's renderers, the surfaces attached to it, its body document, views pinned to it, its home or start page, session outputs and Sites. A store it could not read comes back under `unavailable`: that is not "nothing there". Then `synap_list_views` and `synap_list_cells`. Reuse or extend; never make a twin.
2. **Choose the body** with the table in "Which body", and say in one line which one and why.
3. **Create it anchored.** For ONE object: `synap_create_surface` with `anchor`, `body`, `title` and the body's `spec`, or pass `attachTo: {kind, id}` to `synap_create_view` or `synap_create_document`. To put a surface that already exists on one more object: `synap_attach_surface` (`detach: true` takes it off). Work for a whole space (a list of every deal, the space's own dashboard) is created in that space with `synap_create_view` or `synap_create_document`.
4. **Check it** before you hand it over: open it and read what it shows and the errors it reports (an inspect door that does this for you is not available yet).
5. **Hand over**: give the person the open link the reply carries, `/open/<kind>/<id>?surface=<id>` for an attached surface, `/open/<id>` otherwise. An agent's write is a proposal: `proposed` is success; pass the review link on, never retry.
