## Practices

1. **Find before you create** (`synap_find_surfaces`, then `synap_list_views` and `synap_list_cells`). Reuse or extend; never twin.
2. **Name the body and why**, in one line, before creating.
3. **Anchor everything.** A surface for one object is attached to it. Its context (anchor, project, space, goal, filters) and the brand come from the anchor: a frame reads them with `window.synap.context()`. Never pick colours, never hard-code ids or project names.
4. **Declare reads** for a generated cell (`reads` on `synap_create_cell`) and for an HTML artifact (`reads` on `synap_create_document`): the frame's `window.synap.query` answers only the ops you declared, and anything else is refused. HTML artifacts never write.
5. **Agent writes are proposals.** `proposed` is success; pass the review link on, never retry.
6. **Inspect before you hand over**: `synap_inspect_surface` (reads, tokens, accessibility, render). `unavailable` is not a pass; open it yourself for what it could not check.
7. **No frame as a kind default** before it has proven itself on one object; renders stay kind-level.
8. **Words**: Surface, View, Document, Bento, HTML artifact, Whiteboard, Cell. Never "portal" or "lens" for UI, and never the old word for a cell; "card" is only a renderer slot.
