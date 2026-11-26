---
name: surfaces
description: >-
  Use this skill whenever you make, change, find or suggest UI over the user's Synap pod data:
  a dashboard, a list or board of records, a page, a report to share, a pitch deck, a one-pager,
  a brainstorm, a way a kind of thing looks, or an extra screen on one project, deal, person or goal.
  Triggers: "build me a dashboard for X", "show all my deals", "make a kanban of tasks",
  "write a memo / spec / brief", "make a report for the board", "pitch deck for investors",
  "a one-pager I can send", "brainstorm Y with me", "map how these connect",
  "make deals look different", "give the Fundraising project an investor radar",
  "a chart the catalog does not have", "what UI does this project have". It picks the one
  right body (View, Document, Bento, HTML artifact, Whiteboard, renderer binding, attached
  surface, new Cell), anchors it, and hands it over. For view configs and bento
  layouts it points to synap-ui's references; for the design of a screen, to synap-design.
metadata:
  synap:
    requires:
      env: [SYNAP_HUB_API_KEY, SYNAP_POD_URL]
    primaryEnv: SYNAP_HUB_API_KEY
    homepage: https://synap.live
    capabilities:
      [surfaces, views, documents, bento, html, whiteboard, cells, renderers]
    os: [macos, linux, windows]
    userInvocable: false
---

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

---

## Which body

| The intent is to…                                                                                   | Body                       | Door                                                                                                                                       | Not                                 |
| --------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| see or edit many records of one kind                                                                | View                       | `synap_create_view` (type from `system/synap-ui/view-types`; a kind with a lifecycle → `pipeline` with `config.profileSlug`)               | a bento or HTML that redraws a list |
| write or read mostly text: spec, memo, brief, research, notes, a status read-out, a report's source | Document                   | `synap_create_document` (markdown; live embeds `:::synap-view`, `:::synap-entity`, `:::synap-cell`)                                        | HTML                                |
| monitor or operate something living: health, pipeline numbers, KPIs, a project cockpit, a radar     | Bento                      | `synap_create_view` with `type: "bento"` and catalog cells; for one object, `attachTo` it (or `synap_create_surface` with `body: "bento"`) | a document full of embeds           |
| present, explain, pitch, announce, or share outside the pod with a custom design                    | HTML artifact              | `synap_create_document` with `type: "html"`                                                                                                | a bento screenshot                  |
| think, brainstorm, map ideas, work together live                                                    | Whiteboard                 | `synap_create_view` with `type: "whiteboard"`, then `synap_update_view_content`                                                            | a document                          |
| make a kind look different everywhere                                                               | renderer binding (renders) | `synap_promote_cell_to_renderer` with `profileSlug` and `slot`                                                                             | a per-object frame                  |
| give ONE object an extra screen                                                                     | attached surface           | `synap_create_surface` with the object as `anchor`, or `synap_attach_surface` for one that exists                                          | a kind default                      |
| show a visual unit the catalog does not have                                                        | new Cell type              | `synap_create_cell`, then place, embed or attach it                                                                                        | one-off HTML                        |

**Tie-breakers.** Internal and mostly text → Document. Numbers that change → Bento. Audience outside the pod → HTML artifact. Unfinished thinking → Whiteboard. Read once → Document; watched every day → Bento. Who builds it (a person or you) never changes the body.

**Reports**: write the report as a Document first (pod skill `reports/markdown-first`); when it goes outside, generate its HTML artifact from it.

**Decks**: "pitch deck for investors" is an HTML artifact deck (one page per slide), attached to the project it is for, its colours from the brand kit. When the person wants to co-edit it live, it is a whiteboard whose artboards a presenter plays.

## The body ladder (cheapest first)

saved View → Bento of catalog cells → a generated Cell on declared reads → an HTML artifact → an external app.

Stop at the first rung that serves the intent. A funnel, a stat, a list, a chart that the catalog has is a catalog cell, never a generated one.

---

## Examples

| Prompt                                               | Body                                                             | Why                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| "Show all deals"                                     | View (table on deal)                                             | many records of one kind            |
| "Show my deals by stage"                             | View `pipeline` on deal                                          | the kind declares a lifecycle       |
| "What's due this week?"                              | View (calendar, or a list filtered on the due date)              | records with dates                  |
| "A board of my tasks I can drag between columns"     | View (kanban, or pipeline when the kind has a lifecycle)         | edit many records                   |
| "Make a dashboard for my sales"                      | Bento in the sales space                                         | numbers that change                 |
| "Make a dashboard for the Fundraising project"       | Bento attached to the project                                    | monitor; one object                 |
| "I want to watch project X every morning"            | Bento attached to project X                                      | watched over time                   |
| "Where do things stand on project X?"                | Document (a status read-out with live embeds)                    | read once                           |
| "Write a memo about the pricing change"              | Document                                                         | internal text                       |
| "Show me a summary comparing my top 5 leads"         | Document (internal); an HTML artifact if it goes to a client     | mostly text                         |
| "Pitch deck for investors"                           | HTML artifact deck attached to the project                       | outside audience, custom design     |
| "A one-pager I can send to a prospect"               | HTML artifact                                                    | outside audience                    |
| "Write the Q3 report for the board"                  | Document, then its HTML artifact                                 | report: markdown first              |
| "Brainstorm names with me"                           | Whiteboard                                                       | unfinished thinking                 |
| "Map how our onboarding steps connect"               | Whiteboard                                                       | mapping ideas, not records          |
| "Turn this whiteboard into slides for Monday"        | the same Whiteboard, its artboards played by the presenter       | the presenter is a mode, not a body |
| "Make deals look different everywhere"               | renderer binding on deal (slot card)                             | kind-wide look                      |
| "Make the Posts kind's own dashboard"                | renderer binding on post, slot `dashboard`                       | a kind's page, not one object       |
| "Make this deal's page show its email thread on top" | attached surface on that deal                                    | one object, not the kind            |
| "Give the Fundraising project an investor radar"     | attached Bento with a radar cell                                 | one object, not the kind            |
| "Show deals as a funnel chart"                       | catalog cell `chart-funnel` on a bento or embedded in a document | the catalog has it                  |
| "A cohort heatmap the catalog does not have"         | new Cell type, then place it                                     | new visual unit                     |
| "Health of my pod: errors, queue, cost"              | Bento                                                            | monitor and operate                 |
| "Publish our roadmap on the website"                 | a Site or an external app over an exposed view                   | audience outside, live data         |

---

## Practices

1. **Find before you create** (`synap_find_surfaces`, then `synap_list_views` and `synap_list_cells`). Reuse or extend; never twin.
2. **Name the body and why**, in one line, before creating.
3. **Anchor everything.** A surface for one object is attached to it. Its context (anchor, project, space, goal, filters) and the brand come from the anchor: a frame reads them with `window.synap.context()`. Never pick colours, never hard-code ids or project names.
4. **Declare reads** for a generated cell (`reads` on `synap_create_cell`) and for an HTML artifact (`reads` on `synap_create_document`): the frame's `window.synap.query` answers only the ops you declared, and anything else is refused. HTML artifacts never write.
5. **Agent writes are proposals.** `proposed` is success; pass the review link on, never retry.
6. **Check before you hand over**: open what you made and read what it shows and the errors it reports.
7. **No frame as a kind default** before it has proven itself on one object; renders stay kind-level.
8. **Words**: Surface, View, Document, Bento, HTML artifact, Whiteboard, Cell. Never "portal" or "lens" for UI, and never the old word for a cell; "card" is only a renderer slot.

---

## HTML artifacts

An HTML artifact is a designed page or deck to present, explain, pitch or share outside the pod.

- **Create**: `synap_create_document` with `type: "html"`, a `title` and `content`, a whole self-contained page (inline every script, style, font and image; no CDN; at most 2 MB, a bigger page shows as source only). Pass `attachTo: {kind, id}` to make it for one object (the deal, the project), or `synap_create_surface` with `body: "html"`. The receipt's `warnings` name what will not run.
- **Never an entity's body**: a body is read as markdown, so `entityId` is refused for html. Attach it instead.
- **Edit**: replace the page with `synap_update_document` (read it first for its `revision`). An edit is a proposal; readers see the new page once it is approved.
- **Data**: read-only, through `window.synap.query(op, params)` on the ops you declared in `reads` (`[{op, params?}]`, `"*"` = any value of that param); every other read is refused. The page's context (anchor, space, project, goal, filters, brand, locale, theme) comes from `window.synap.context()`. Open an object with `window.synap.open(kind, id)` from a click. Never fetch the pod yourself, never write.
- **Where it runs**: inside the pod, at `/open/<id>` (or on the object it is attached to), in an isolated frame, with the reader's own access. A published mode (data frozen at share time, for readers outside the pod) and addressable blocks (patch one slide instead of the whole page) are not available yet: today an edit replaces the page.
- **Brand**: draw with the `--synap-*` variables the host injects, then the brand's CSS; never hard-code colours. Shapes and the full list of reads: "Cell authoring" below (an HTML artifact reads through the same bridge as a cell drawn as a page).
- **Reports**: write the Document first, then generate the HTML artifact from it when it goes outside.

---

## Cells

- One unit, one name: a **cell type** (the definition) and a **cell instance** (a placement). The same cell works as a bento block and as a document embed (`:::synap-cell`).
- In a bento's config a cell is placed inline as a block `{kind: "cell", cellKey, props}`; the other block kinds are `view` (`viewId`) and `entity` (`entityId`).
- **List what exists**: `synap_list_cells` (`placement: "bento"` or `"document"`). Never guess a key.
- **Configure a catalog cell before you generate one.** Generate a new cell type with `synap_create_cell` only when the catalog lacks the visual unit. It reads only what it declares (`reads`), draws with the host's tokens, and lands as a proposal. The recipe, the frame and its bridge are in "Cell authoring" below.
- **Show it**: `placeOn: {viewId}` puts it on a bento in the same call; embed it in a document; attach it to ONE object (`synap_attach_surface`, or `synap_create_surface` with `body: "cell"`).
- **Promote it to a kind's renderer** (`synap_promote_cell_to_renderer`) only once it has proven itself; for one object, attach it instead.
- **"Make this my Posts dashboard"** = a cell bound to the kind's `dashboard` slot: `synap_create_cell` a frame over the intent reads (`lifecycle.board`, `lifecycle.throughput`, `attention.needsYou`, `attention.count`, `sessions.list`, declared in `reads`), then `synap_promote_cell_to_renderer` with `profileSlug: "post"` and `slot: "dashboard"`. On a kind with a lifecycle the cell fills the Dashboard tab and the Pipeline tab stays the board. A board drawn from a playbook reads `flow.of`.
- **References**: block shapes and layouts in `system/synap-ui/bento-layouts` and `system/synap-ui/bento-recipes`; view configs in `system/synap-ui/view-types`; embed grammar in `system/synap/document-embeds`; the design of a screen in `synap-design`.

---

## Cell authoring: the frame, the recipe, the bridge

A generated cell is drawn in a sandboxed frame (ViewFrame). Make one only when no catalog cell or view type (table, kanban, list, chart) covers the needed chart type, 3D layout, map, or bespoke UI. Which body to make in the first place: "Which body" above.

### When to Use ViewFrame

| Situation                                                                                                                  | Action                        |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| An existing cell or view type covers the need: check `synap_list_cells` first (a funnel and most charts are catalog cells) | Use the existing cell or view |
| The catalog lacks the visual unit (a 3D scene, a bespoke map or layout, a chart it does not list)                          | Generate a ViewFrame cell     |

A report, a summary or a page to share is not a cell: write it as a Document, then generate its HTML artifact from it (`synap_create_document` type `html`).

### Default vs. generated — never the reflex, always the explicit ask

Every kind already renders as a familiar, kind-shaped card — its built-in `entity-card` (small block) / `entity-detail` (full page) / `entity-profile` (dashboard) renderer. That built-in is the DEFAULT for everyone, including brand-new user-defined kinds (which get an automatic card built from the schema — no generation needed). **Never generate a frame renderer as a kind's default presentation.** Generate one ONLY when the user explicitly asks for a custom look — a specific chart type, a redesigned card, a bespoke layout — and bind it PER KIND (one profile's one renderer slot), never as a blanket replacement for every kind. The sandbox's egress holes (see Security below) are still open, so treat "generate a view/card" as a deliberate, scoped request, not something to reach for by default.

After binding, tell the user where the result lives: **"⋯ → Customize display"** on that kind's page (Renderer Studio itself now lives in Builder mode / Settings, not a designer mode you build). That is the one place a human reverts it or picks something else — never invent a second, agent-only way to switch it back.

### What ViewFrame Is

- A sandboxed iframe that renders **one ES module** that default-exports a React component (or plain JS)
- Keep generated cells self-contained. The frame never loads code from the network (no CDN, no esm.sh): React and the shared kit come from the host, and any other library has to be bundled into the cell's own source.
- The host injects a `SynapWidget` bridge for data access and shell actions
- Security: `sandbox="allow-scripts allow-modals"` — no `allow-popups`, no `allow-same-origin`, no cookies, no pod token

### Authoring contract

A ViewFrame cell is **one self-contained ES module** (inline in `rendererSource`):

- The module **default-exports a React component** (or calls `SynapWidget.onInit()` for plain JS).
- The only bare imports that resolve are the ones the host provides: `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, `react/jsx-dev-runtime` and `@synap/kit` (see "What the frame provides" below). Any other bare import (`recharts`, `d3`, `three`, …) fails in the frame.
- **No `import` of local files and no `import` from a URL.** A third-party library must be bundled into the source before you define the cell (`synap cell build <entry> --bundle-deps`), never fetched at runtime.
- Leave `deps` out (or `{}`). A cell that declares runtime `deps`, names `esm.sh`, imports anything the host does not provide, or loads code or a stylesheet from the network is **refused when you define it** (`synap_create_cell`, `POST /cells/define`): nothing is saved or proposed, and the error names the line and the fix.
- A person approves **exactly the content** a cell proposal holds: its source, its mechanism, its `deps` and its egress. Changing any of them is a new approval: define the cell again (a new proposal), or revise the pending one. The stored cell records the fingerprint of the content it holds.
- Advice on colour (raw hex instead of `var(--synap-*)` tokens) and accessibility (an image with no `alt`, a clickable `div`) comes back as `advice` with the reply. It never blocks the cell; fix what it names.
- No `<script src>`, no CDN stylesheet, no web font link: the frame's security policy blocks them. Inline `<style>` tags or CSS-in-JS only. Fonts and colours come from the host's tokens (`@synap/kit`).
- An **HTML page** (a source that opens with `<`) is drawn as a page, not a module: it gets **no host modules**, so it can run inline script only and cannot `import` anything, not even `react`. To use React or `@synap/kit`, write the cell as an ES module that default-exports a component.
- Write the cell for the web and desktop frame. The phone (Relay) runs an ES-module cell bound as a kind's `detail` renderer, on that thing's page, with the same `SynapWidget` bridge (queries and the four governed writes); an HTML page, or a cell in another slot, shows the generic page there. The phone frame allows no approved outside host: a cell that needs one renders blank there.

### Define a cell: the one recipe

1. **Check what exists**: `synap_list_cells` (REST `GET /api/hub/widget-definitions`). Define only what is genuinely new; a cell definition is permanent.
2. **Write the source** as an **ES module** that default-exports a React component (drawn in the frame, with the host's React and `@synap/kit`), or as an **HTML page** (a source that opens with `<`: drawn as a page, inline script only, no `import`). You do not pick the mechanism: the pod reads it from the source.
3. **Define it with `synap_create_cell`** `{ name, rendererSource, reads?, description?, workspaceId?, contentKind?, viewTypes?, placeOn? }`: the agent door. `reads` declares the ops the frame may query (`[{op, params?}]`); any other read is refused. A client without MCP calls the same door over REST, `POST /api/hub/cells/define` (below); both run one write path.
4. **Show it**: `placeOn: { viewId }` adds it to a bento in the same call, `synap_attach_surface` puts it on ONE object, or `synap_promote_cell_to_renderer` binds it as a kind's renderer. Until it is placed, attached or bound it shows nowhere. For one object, attach it; the per-object renderer targets below are still accepted:

   | Target                        | Call                                                                              | Slots                                 |
   | ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------- |
   | a kind's records (every deal) | `{ profileSlug: "deal", slot, cellKey }` (or `target: { kind: "profile", slug }`) | `card`, `detail`, `list`, `dashboard` |
   | one capability's page         | `{ target: { kind: "capability", id }, slot, cellKey }`                           | `detail`, `dashboard`                 |
   | one playbook's page           | `{ target: { kind: "playbook", id }, slot: "detail", cellKey }`                   | `detail`                              |
   | one view's page               | `{ target: { kind: "view", id }, slot: "detail", cellKey }`                       | `detail`                              |

   `scope`: `workspace` (default, needs `workspaceId`) = in that space only; `pod` = everywhere (for one object: its own page, the usual choice); `user` = only you (not for a capability). The cell must exist (yours from `synap_create_cell` may still be pending: bind the `typeKey` its reply returns, in the same breath; an accented name is folded, `Page cédant` -> `generated:page-cedant`). `clear: true` (no `cellKey`) unbinds the slot. An applied bind replies `nowBound`, what the page shows now; an agent's bind is a proposal.

5. An agent's define lands as a proposal: `status: "proposed"` is success; pass on `reviewUrl`, never retry.

### The same door over REST: `POST /api/hub/cells/define`

It is idempotent (upserts on typeKey) and pod-global by default (no workspaceId needed). **It IS governed for agent callers** — `POST /cells/define` runs `checkPermissionOrPropose({ resource: "cell", action: "define", trustLevel: "generated" })`; a `status: "proposed"` response is the normal outcome for AI-generated renderer source, not an error — surface `reviewUrl` and keep going. Only an operator-initiated define auto-applies.

```
POST /api/hub/cells/define
Authorization: Bearer {SYNAP_HUB_API_KEY}
Content-Type: application/json

{
  "name": "Deal Stage Funnel",
  "rendererSource": "<!DOCTYPE html>…</html>",
  "typeKey": "deal-stage-funnel",        // optional — derived from name if omitted
  "description": "Funnel chart of deal pipeline stages",  // optional
  "defaultSize": { "w": 8, "h": 6 },    // optional
  "deps": {}                             // optional; leave empty: the frame refuses runtime deps
}
```

**`deps`:** a `deps` map that names anything the host does not provide is refused (400, nothing proposed): the frame loads no runtime dependency. Send `{}` or omit it, and bundle any library into `rendererSource` instead.

**`workspaceId` is intentionally omitted** — cells defined without it are pod-global (`workspaceId IS NULL`), visible in every workspace the user owns. Pass `workspaceId` only when you explicitly want a cell scoped to a single workspace.

Response: `{ "success": true, "typeKey": "generated:deal-stage-funnel" }`

The typeKey is auto-prefixed `generated:` when not explicitly provided.

**List cells (all pod-global + optionally workspace-specific):**

```
GET /api/hub/cells                         — pod-global only
GET /api/hub/cells?workspaceId={id}        — pod-global + workspace-scoped
Authorization: Bearer {SYNAP_HUB_API_KEY}
```

**Delete a cell:**

```
DELETE /api/hub/cells/{typeKey}            — pod-global row
DELETE /api/hub/cells/{typeKey}?workspaceId={id}  — workspace-scoped row
Authorization: Bearer {SYNAP_HUB_API_KEY}
```

**Open the cell in the browser (deep link):**

```
synap://open/cell/{typeKey}
```

The browser receives this deep link, looks the typeKey up in the cell registry (which polls `widget_definitions` every 10s), and opens it as a side panel tab with the cell's registered `meta.name` as the tab title.

> **Note:** `POST /api/hub/widget-definitions` (tRPC path) still works but is the internal/admin path. Use `POST /api/hub/cells/define` for all agent-generated cells.

### CLI commands (when running as Claude Code or another terminal agent)

```bash
# Build a multi-file cell source into a single ES module bundle.
# --bundle-deps inlines every third-party library (only react and react-dom
# stay external, the host provides them). Always pass it: without it the CLI
# leaves libraries external and the frame refuses the cell.
synap cell build <entry> --out ./dist/my-chart.js --bundle-deps

# Push a built cell to the pod (no --deps: the bundle has none)
synap cell define \
  --name "My Chart" \
  --file ./dist/my-chart.js \
  [--type-key my-chart] \
  [--workspace <id>]

# Document operations
synap doc create --title "Q2 Report" --file ./report.md
synap doc update <docId> --file ./updated-report.md

# Arrange cells on an existing bento view
echo '[{"key":"generated:my-chart","x":0,"y":0,"w":8,"h":6}]' | synap view arrange <viewId>
```

### The SynapWidget Bridge (inside the iframe)

`window.SynapWidget` is injected automatically — do NOT import or `<script>` it.

#### Queries (read-only, always approved)

```js
SynapWidget.onInit(async ({ config, context }) => {
  // context: { workspaceId, viewId?, entityId?, sdkVersion }

  // List entities
  const deals = await SynapWidget.query("entities.list", {
    profileSlug: "deal",
    limit: 200,
  });

  // Get a single entity
  const entity = await SynapWidget.query("entities.get", { id: "uuid" });

  // List views
  const views = await SynapWidget.query("views.list", {
    workspaceId: context.workspaceId,
  });

  // List profiles
  const profiles = await SynapWidget.query("profiles.list", {});

  render(deals ?? []);
  SynapWidget.resize(document.body.scrollHeight);
});
```

All `query()` calls return a Promise. Entity shape: `{ id, title, profileSlug, properties, createdAt, … }`.

#### Intent reads (a kind's pipeline, goal, needs-you, sessions)

The same reads a kind's own page makes, so a frame can be that kind's dashboard. The host stamps the lens (the active space and project); a `workspaceId` / `projectId` you pass is ignored. `trackId` narrows to one goal.

| Operation              | Params                                                                                                                    | Returns                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lifecycle.board`      | `profileSlug` (required), `trackId`, `windowDays`, `firstN`, `column` + `cursor`, `limit`, `workedBy`                     | `{ lifecycle: { profileSlug, property, options }, columns: [{ key, category, count, stuck, items: [{ id, name, status, since, stuck, workedBy? }] }], live, total, doneWindowed, lostWindowed, suggestedShape, window, nextCursor }`                                                                                                                         |
| `flow.of`              | `profileSlug` (a kind or a role, required), `trackId`, `windowDays`, `firstN` (cards per state, at most 50), `properties` | `{ profileSlug, profileKind, states: [{ key, label, category, owners: [{ playbookId, playbookName, stageKey, stageName }], count, stuck, cards: [{ id, name, since, stuck, workedBy, next }] }], unclassified, flows, totals, window, withheld }`: the states in declared order with the playbook stage that owns each. Draw a board from a playbook from it |
| `lifecycle.throughput` | `profileSlug`, `trackId`, `bucket` (`day` · `week` · `month`), `count`                                                    | `{ bucket, since, buckets: [{ bucketStart, done, lost }] }`, oldest first, zeros included                                                                                                                                                                                                                                                                    |
| `attention.needsYou`   | `profileSlug`, `trackId`, `limit`                                                                                         | `{ signals: [{ id, kind, title, count, occurredAt, target }] }`                                                                                                                                                                                                                                                                                              |
| `attention.count`      | `profileSlug`, `trackId`                                                                                                  | `{ needsYou, decisions, blocked, review, captures, truncated, … }`                                                                                                                                                                                                                                                                                           |
| `sessions.list`        | `profileSlug` (its things) or `entityId` (one thing), `status`, `kind` (default `work`), `limit`                          | `[{ id, title, goal, status, currentStage, progress, startedAt, … }]`                                                                                                                                                                                                                                                                                        |

```js
const board = await SynapWidget.query("lifecycle.board", {
  profileSlug: "post",
  firstN: 5,
});
if (board?.error) return showError(board.error); // 404 = unknown kind, 412 = no lifecycle
const month = await SynapWidget.query("lifecycle.throughput", {
  profileSlug: "post",
  bucket: "month",
  count: 1,
});
```

A board drawn from a playbook, in an HTML page (`window.synap.query`, the same ops): one column per state, in declared order, headed by the stage that owns it.

```html
<div id="board"></div>
<script>
  window.synap.query("flow.of", { profileSlug: "deal", firstN: 5 }).then(
    (flow) => {
      document.getElementById("board").replaceChildren(
        ...flow.states.map((state) => {
          const col = document.createElement("section");
          const owner = state.owners[0];
          col.append(
            Object.assign(document.createElement("h3"), {
              textContent: `${state.label} · ${state.count}`,
            }),
            Object.assign(document.createElement("p"), {
              textContent: owner ? owner.stageName : "",
            }),
            ...state.cards.map((card) =>
              Object.assign(document.createElement("div"), {
                textContent: card.name ?? "",
              })
            )
          );
          return col;
        })
      );
    },
    (err) => {
      document.getElementById("board").textContent = err.message; // a failure, never an empty board
    }
  );
</script>
```

A failed read returns `{ error }`. Show it as a failure, never as an empty board. Moves still go through `update_entity` (the lifecycle property), so the status door and governance apply.

#### Work reads (a view per type of work)

A view per type of work (its state and plan, the work running now, what finished and what it showed, how the week went against the intent) reads ONE object by its id, the same read that object's own page makes. Each answers what this viewer may read; an object they cannot see is an error, never an empty answer. The id is a param; the space is not (the host still stamps it on the other reads).

| Operation            | Params                     | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions.get`       | `id` (a session, required) | `{ continuation: { session: { id, displayTitle, goal, status, statusLabel, currentStage, progress }, nextMove, userMustDecide, openRoomQuestions, blockedBy, waitingOn, workUnits, room, gates, live, stageRuns }, outcomes: { status, counts: { met, total }, outcomes: [{ key, label, kind, owner, met, retired, state }], inputs: [{ key, label, need, open, answered, blocksOutcomeKey }] }, cost }`: what the session must yield (criteria are outcomes of kind `fact`), what it waits on from the person, its next move. `outcomes.status: "unavailable"` = not read, not empty |
| `playbook.process`   | `playbookId` (required)    | `{ playbook, when, steps, checks: { criteria, gates }, moves, needs, skills, runs: { counts, recent }, health, unavailable }`: the playbook seen whole. A part named in `unavailable` was not read                                                                                                                                                                                                                                                                                                                                                                                    |
| `playbook.scorecard` | `playbookId` (required)    | `{ runs: { total, closed, evaluated, reopened, instantiated, attached }, escalations, overrides, criteria: [{ key, statement, required, sessions, passed, failed, unmeasured, passRate, overrides }] }`: how this viewer's runs of it went. `passRate: null` = nothing measured, not 0                                                                                                                                                                                                                                                                                                |
| `project.pillars`    | `id` (a project, required) | `{ mainGoal, pillars, rootHealth }`: where the project stands, pillar by pillar. A part that could not be read is `{ status: "unavailable" }`                                                                                                                                                                                                                                                                                                                                                                                                                                         |

#### Open an object from an HTML page

A page knows no address: no pod URL reaches the frame. To open a session, an entity, a document, a playbook, a goal (`track`) or a proposal, ask the host by kind and id; it opens the object where it opens everywhere (the console's page, the app's route). Nothing comes back. Call it from a click: without one the host may ignore it.

```html
<button id="open">Open the session</button>
<script>
  document
    .getElementById("open")
    .addEventListener("click", () => window.synap.open("session", sessionId));
  // window.synap.opens lists the kinds a page may open.
</script>
```

#### Tokens in an HTML page

The host writes its design tokens into the frame before the page: every `--synap-*` variable, at the value the reader's theme gives it (light, dark, a theme). Draw with `var(--synap-…)` and the page follows the reader's theme; never copy token values into the page, and never link a stylesheet (the frame loads nothing from the network). Your own styles still win where you set them.

#### Mutations (governance-gated — return `{ status: "approved" | "proposed" | "denied" }`)

```js
// Create an entity
const result = await SynapWidget.mutate("create_entity", {
  profileSlug: "task",
  title: "Follow up",
  properties: { status: "todo" },
});
// result.status === "approved" → result.id is the new entity id
// result.status === "proposed" → result.proposalId, result.reviewUrl

// Update an entity
await SynapWidget.mutate("update_entity", {
  id: "uuid",
  properties: { status: "done" },
});

// Delete an entity (always proposed for agent-generated cells)
await SynapWidget.mutate("delete_entity", { id: "uuid" });

// Create a relation
await SynapWidget.mutate("create_relation", {
  sourceEntityId: "uuid-a",
  targetEntityId: "uuid-b",
  type: "relates_to",
});
```

**Always check `result.status`.** `"proposed"` is not an error — surface `result.reviewUrl` to the user.

#### Shell actions

```js
SynapWidget.navigate({ entityId: "entity-uuid" }); // open entity detail in side panel
SynapWidget.openPanel("entity-detail", { entityId: "uuid" }); // explicit panel open
SynapWidget.toast("Saved!", "success"); // 'success' | 'error' | 'info'
SynapWidget.resize(document.body.scrollHeight); // resize the iframe to content height
SynapWidget.updateContext({ viewId: "uuid" }); // update ambient context

// Subscribe to live entity changes
SynapWidget.subscribe("entity:changed", ({ entityId }) => {
  // re-fetch and re-render when any entity in the pod changes
});
```

### What the frame provides

The host hands every frame these modules from its own bundle, with no network:

- `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, `react/jsx-dev-runtime`: one React 19 build, the host's.
- `@synap/kit`: the shared components and helpers a space package is built against. It exports exactly these names, and nothing else: `LensPageView`, `SYNAP_CHANGED_EVENT`, `SpatialAppHeader`, `SpatialButton`, `SpatialPageFrame`, `encodeActivityScope`, `encodeLensScope`, `installFrameBridge`, `lensActivityScope`, `resolveActionLabel`, `resolveDestinationLabel`, `resolveObjectNoun`, `useLensPageClock`, `useLensPageModelOf`. Do not import a name that is not in this list.
- `window.SynapWidget`: the data and shell bridge (below). Data reaches the cell only through it.

A charting, map or 3D library is not provided. Draw with plain SVG or canvas in the cell's own source, or bundle the library at build time with `synap cell build --bundle-deps`. Never name `recharts`, `d3` or any other package in `deps`.

### Minimal Cell Template

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * {
        box-sizing: border-box;
        margin: 0;
      }
      body {
        font-family: -apple-system, sans-serif;
        padding: 16px;
        background: transparent;
      }
    </style>
    <!-- a page gets no host modules: inline script only, no import, no importmap -->
  </head>
  <body>
    <p id="root"></p>
    <script>
      SynapWidget.onInit(async ({ context }) => {
        const items = await SynapWidget.query("entities.list", {
          profileSlug: "deal",
          limit: 200,
        }).catch(() => []);

        document.getElementById("root").textContent =
          `Loaded ${(items ?? []).length} deals`;

        SynapWidget.resize(document.body.scrollHeight);
      });
    </script>
  </body>
</html>
```

### Rules

- **Always call `SynapWidget.onInit()`** — the host will not send data until you register this handler.
- **Call `SynapWidget.resize()`** after rendering to prevent clipping.
- **Handle errors** — `query()` and `mutate()` can fail; always `.catch()`.
- **Check `result.status` on mutations** — `"proposed"` is governance, not an error; surface `reviewUrl`.
- **Transparent background** — `background: transparent` on `body` inherits the host surface color.
- **No external fetch, no CDN** — the sandbox has no network for code or data; all data must go through `SynapWidget`.
- **Import only what the host provides** — React and `@synap/kit`, in an ES-module cell (a page imports nothing). Bundle anything else into the source; never declare it in `deps`, never load it from a CDN.

---
