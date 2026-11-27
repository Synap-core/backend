## HTML artifacts

An HTML artifact is a designed page or deck to present, explain, pitch or share outside the pod.

- **Create**: `synap_create_document` with `type: "html"`, a `title` and `content`, a whole self-contained page (inline every script, style, font and image; no CDN; at most 2 MB: a bigger page is refused and nothing is written). Pass `attachTo: {kind, id}` to make it for one object (the deal, the project), or `synap_create_surface` with `body: "html"`. The receipt's `warnings` name what will not run.
- **Never an entity's body**: a body is read as markdown, so `entityId` is refused for html. Attach it instead.
- **Edit**: replace the page with `synap_update_document` (read it first for its `revision`). An edit is a proposal; readers see the new page once it is approved.
- **Data**: read-only, through `window.synap.query(op, params)` on the ops you declared in `reads` (`[{op, params?}]`, `"*"` = any value of that param); every other read is refused. The page's context (anchor, space, project, goal, filters, brand, locale, theme) comes from `window.synap.context()`. Open an object with `window.synap.open(kind, id)` from a click. Never fetch the pod yourself, never write.
- **Where it runs**: inside the pod, at `/open/<id>` (or on the object it is attached to), in an isolated frame, with the reader's own access. A published mode (data frozen at share time, for readers outside the pod) and addressable blocks (patch one slide instead of the whole page) are not available yet: today an edit replaces the page.
- **Brand**: draw with the `--synap-*` variables the host injects, then the brand's CSS; never hard-code colours. Shapes and the full list of reads: "Cell authoring" below (an HTML artifact reads through the same bridge as a cell drawn as a page).
- **Reports**: write the Document first, then generate the HTML artifact from it when it goes outside.
