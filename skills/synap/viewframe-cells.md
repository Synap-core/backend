## ViewFrame Cells — Custom View Generation

ViewFrame is the standard way to create custom data visualizations in Synap. Use it whenever an existing cell (table, kanban, list, chart) does not cover the needed chart type, 3D layout, map, or bespoke AI-generated UI.

### When to Use ViewFrame

| Situation                                                              | Action                        |
| ---------------------------------------------------------------------- | ----------------------------- |
| An existing cell or view type covers the need                          | Use the existing cell or view |
| User asks for a specific chart type, map, 3D scene, or custom layout   | Generate a ViewFrame widget   |
| User says "show X as a [funnel / heatmap / treemap / scatter / globe]" | Generate a ViewFrame widget   |

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
- Advice on colour (raw hex instead of `var(--synap-*)` tokens) and accessibility (an image with no `alt`, a clickable `div`) comes back as `advice` with the reply. It never blocks the cell; fix what it names.
- No `<script src>`, no CDN stylesheet, no web font link: the frame's security policy blocks them. Inline `<style>` tags or CSS-in-JS only. Fonts and colours come from the host's tokens (`@synap/kit`).
- An **HTML page** (a source that opens with `<`) is drawn as a page, not a module: it gets **no host modules**, so it can run inline script only and cannot `import` anything, not even `react`. To use React or `@synap/kit`, write the cell as an ES module that default-exports a component.
- Phone frames (Relay, Telegram) are not the target: they show the snapshot of a cell and a link to open it on the web or desktop, so write the cell for the web and desktop frame.

### Register a Cell via the Hub Protocol (canonical path)

**Use `POST /api/hub/cells/define` — this is the canonical Hub Protocol path for AI-generated cells.**

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

**Full AI artifact workflow:**

```
// 1. Generate the HTML/React cell
POST /api/hub/cells/define
{ "name": "Q2 Revenue Report", "rendererSource": "<!DOCTYPE html>…</html>" }
// → { "success": true, "typeKey": "generated:q2-revenue-report" }

// 2. Open it in the user's browser
synap://open/cell/generated:q2-revenue-report
```

The cell appears immediately in the side panel with "Q2 Revenue Report" as the tab title. It persists across sessions and is available from any workspace.

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

# Arrange widgets on an existing bento view
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

| Operation              | Params                                                                                                | Returns                                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lifecycle.board`      | `profileSlug` (required), `trackId`, `windowDays`, `firstN`, `column` + `cursor`, `limit`, `workedBy` | `{ lifecycle: { profileSlug, property, options }, columns: [{ key, category, count, stuck, items: [{ id, name, status, since, stuck, workedBy? }] }], live, total, doneWindowed, lostWindowed, suggestedShape, window, nextCursor }` |
| `lifecycle.throughput` | `profileSlug`, `trackId`, `bucket` (`day` · `week` · `month`), `count`                                | `{ bucket, since, buckets: [{ bucketStart, done, lost }] }`, oldest first, zeros included                                                                                                                                            |
| `attention.needsYou`   | `profileSlug`, `trackId`, `limit`                                                                     | `{ signals: [{ id, kind, title, count, occurredAt, target }] }`                                                                                                                                                                      |
| `attention.count`      | `profileSlug`, `trackId`                                                                              | `{ needsYou, decisions, blocked, review, captures, truncated, … }`                                                                                                                                                                   |
| `sessions.list`        | `profileSlug` (its things) or `entityId` (one thing), `status`, `kind` (default `work`), `limit`      | `[{ id, title, goal, status, currentStage, progress, startedAt, … }]`                                                                                                                                                                |

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

A failed read returns `{ error }`. Show it as a failure, never as an empty board. Moves still go through `update_entity` (the lifecycle property), so the status door and governance apply.

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

### Minimal Widget Template

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
