## Four things you can build

Tailored UI is pod-native first (founder, 9 Nov 2026): one of the four below, or an HTML page bound as a kind's renderer, shown on the desktop. A standalone site or app only when the person asks for one (`system/synap-app/overview`).

1. **Views** — named queries + rendering config over entities of a given profile. Kanban of tasks, gallery of articles, calendar of events.
2. **Bento dashboards** — 12-col grid compositions of cells (view-cards, entity-cards, widgets). The Home dashboard is a bento. Workspace landing pages are bentos.
3. **Workspaces** — full lenses with profiles, views, a bento, and seed entities. The biggest building block.
4. **New cell types** (Capability B) — AI can define entirely new rendering cells when no existing widget covers the need. Cells run in a sandboxed frame. One recipe, in `system/synap/viewframe-cells` ("Define a cell: the one recipe"): check `synap_list_widgets`, write an ES module or an HTML page (the pod picks how it is drawn), define it with `synap_create_cell`, then place it on a bento (`placeOn`) or bind it as the renderer of a kind, a capability, a playbook or a view (`synap_promote_cell_to_renderer`, the target table is in that recipe). An agent's define is a proposal: `proposed` is success.

   - Leave `deps` out. The frame loads no code from the network (no CDN, no esm.sh): React and `@synap/kit` come from the host, and a cell that declares runtime `deps` is refused on web and desktop. Bundle any library into the source (`synap cell build --bundle-deps`); the same chapter lists what the frame provides and the in-frame query/mutate/shell-actions API.
   - **"Make this my Posts dashboard"** = a cell bound to the kind's `dashboard` slot, not a new workspace:
     1. `create_cell` a frame that reads what the kind's own page reads, through the bridge's intent reads: `lifecycle.board`, `lifecycle.throughput`, `attention.needsYou`, `attention.count`, `sessions.list` (params and shapes: `synap` skill, ViewFrame Cells → "Intent reads"). Never pre-fetch rows into the source.
     2. `promote_cell_to_renderer({ profileSlug: "post", slot: "dashboard", cellKey })`. `dashboard` is the `entity-profile` content kind. It is governed, so `proposed` is success.
     - On a kind with a lifecycle the cell fills the **Dashboard** tab and the Pipeline tab stays the board (its moves and card frame are the kind's). On a kind without one, the cell is the page.
     - **A board drawn from a playbook or a pipeline reads `flow.of`**, in a cell too: `window.synap.query("flow.of", { profileSlug })` returns the kind's states in declared order, the playbook stage that owns each, and the things in each (params and shape: `synap` skill, ViewFrame Cells → "Intent reads"). An app outside the frame reads the same `flow.of` (tRPC, Hub `GET /api/hub/flow`). No status list or stage list is written by hand.
     - A saved view can take the same slot from the app (Keep → Become renderer of… → Whole profile dashboard). Any view type renders there.
