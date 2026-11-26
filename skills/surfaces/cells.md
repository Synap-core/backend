## Cells

- One unit, one name: a **cell type** (the definition) and a **cell instance** (a placement). The same cell works as a bento block and as a document embed (`:::synap-cell`).
- In a bento's config a cell is placed inline as a block `{kind: "cell", cellKey, props}`; the other block kinds are `view` (`viewId`) and `entity` (`entityId`).
- **List what exists**: `synap_list_cells` (`placement: "bento"` or `"document"`). Never guess a key.
- **Configure a catalog cell before you generate one.** Generate a new cell type with `synap_create_cell` only when the catalog lacks the visual unit. It reads only what it declares (`reads`), draws with the host's tokens, and lands as a proposal. The recipe, the frame and its bridge are in "Cell authoring" below.
- **Show it**: `placeOn: {viewId}` puts it on a bento in the same call; embed it in a document; attach it to ONE object (`synap_attach_surface`, or `synap_create_surface` with `body: "cell"`).
- **Promote it to a kind's renderer** (`synap_promote_cell_to_renderer`) only once it has proven itself; for one object, attach it instead.
- **"Make this my Posts dashboard"** = a cell bound to the kind's `dashboard` slot: `synap_create_cell` a frame over the intent reads (`lifecycle.board`, `lifecycle.throughput`, `attention.needsYou`, `attention.count`, `sessions.list`, declared in `reads`), then `synap_promote_cell_to_renderer` with `profileSlug: "post"` and `slot: "dashboard"`. On a kind with a lifecycle the cell fills the Dashboard tab and the Pipeline tab stays the board. A board drawn from a playbook reads `flow.of`.
- **References**: block shapes and layouts in `system/synap-ui/bento-layouts` and `system/synap-ui/bento-recipes`; view configs in `system/synap-ui/view-types`; embed grammar in `system/synap/document-embeds`; the design of a screen in `synap-design`.
