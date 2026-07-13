## ViewFrame Cells — Custom View Generation

ViewFrame is the standard way to create custom data visualizations in Synap. Use it whenever an existing cell (table, kanban, list, chart) does not cover the needed chart type, 3D layout, map, or bespoke AI-generated UI.

### When to Use ViewFrame

| Situation                                                              | Action                        |
| ---------------------------------------------------------------------- | ----------------------------- |
| An existing cell or view type covers the need                          | Use the existing cell or view |
| User asks for a specific chart type, map, 3D scene, or custom layout   | Generate a ViewFrame widget   |
| User says "show X as a [funnel / heatmap / treemap / scatter / globe]" | Generate a ViewFrame widget   |

### What ViewFrame Is

- A sandboxed iframe that renders **one ES module** that default-exports a React component (or plain JS)
- Keep generated cells self-contained. The CLI can analyse bare imports into a
  `deps` map, but the current Hub `cells/define` persistence path does not yet
  retain that map, so external runtime dependencies are not a reliable contract.
- The host injects a `SynapWidget` bridge for data access and shell actions
- Security: `sandbox="allow-scripts allow-modals allow-popups"`, no `allow-same-origin`, no cookies, no pod token

### Authoring contract

A ViewFrame cell is **one self-contained ES module** (inline in `rendererSource`):

- The module **default-exports a React component** (or calls `SynapWidget.onInit()` for plain JS).
- Bare imports (`"react"`, `"recharts"`, etc.) are resolved via the esm.sh import map generated from `deps`.
- **No bundler, no `import` of local files** — everything is either inlined or declared in `deps`.
- External CSS is not supported; inline `<style>` tags or CSS-in-JS only.

### Register a Cell via the Hub Protocol (canonical path)

**Use `POST /api/hub/cells/define` — this is the canonical Hub Protocol path for AI-generated cells.**

It is idempotent (upserts on typeKey), pod-global by default (no workspaceId needed), and immediately available across all of the user's workspaces without any proposal step.

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
  "deps": { "recharts": "2.12.0" }    // accepted for forward compatibility; not persisted yet
}
```

**`deps` status:** the CLI accepts a JSON map for forward compatibility, but
the current server stores `{}`. Do not make a generated cell depend on an
external package until the persistence contract is upgraded and verified.

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
{ "name": "Q2 Revenue Report", "rendererSource": "<!DOCTYPE html>…</html>",
  "deps": { "recharts": "2.12.0" } }
// → { "success": true, "typeKey": "generated:q2-revenue-report" }

// 2. Open it in the user's browser
synap://open/cell/generated:q2-revenue-report
```

The cell appears immediately in the side panel with "Q2 Revenue Report" as the tab title. It persists across sessions and is available from any workspace.

> **Note:** `POST /api/hub/widget-definitions` (tRPC path) still works but is the internal/admin path. Use `POST /api/hub/cells/define` for all agent-generated cells.

### CLI commands (when running as Claude Code / OpenClaw agent)

```bash
# Build a multi-file cell source into a single ES module bundle
synap cell build <entry> --out ./dist/my-chart.js
# → writes the bundle and prints the inferred deps JSON

# Push a built cell (source + deps) to the pod
synap cell define \
  --name "My Chart" \
  --file ./dist/my-chart.js \
  --deps '{"recharts":"2.12.0"}' \
  [--type-key my-chart] \
  [--workspace <id>]

# Document operations
synap doc create --title "Q2 Report" --file ./report.md
synap doc update <docId> --file ./updated-report.md

# Arrange widgets on an existing bento view
synap view arrange <viewId> --blocks '[{"id":"b1","kind":"widget","widgetKind":"generated:my-chart","layout":{"x":0,"y":0,"w":8,"h":6}}]'
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
  type: "related_to",
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

### Common Dependency Patterns (esm.sh import map)

The `deps` map in `/cells/define` drives the import map. Each key becomes a bare specifier in the `<script type="importmap">`, resolved to `https://esm.sh/<pkg>@<version>`.

```json
// deps in the define call:
{ "recharts": "2.12.0", "d3": "7" }

// → generates this importmap inside the frame:
{
  "imports": {
    "react": "https://esm.sh/react@19",
    "react-dom/client": "https://esm.sh/react-dom@19/client",
    "react/jsx-runtime": "https://esm.sh/react@19/jsx-runtime",
    "recharts": "https://esm.sh/recharts@2.12.0",
    "d3": "https://esm.sh/d3@7"
  }
}
```

React 19 core entries are always injected by the host — never put them in `deps`.

Common library choices:

| Category | Packages (put in `deps`)                                       |
| -------- | -------------------------------------------------------------- |
| Data viz | `recharts@2.12.0`, `d3@7`, `chart.js@4`, `observable-plot@0.6` |
| Tables   | `@tanstack/react-table@8`                                      |
| 3D       | `three@0.165.0`, `@react-three/fiber@8`, `@react-three/drei@9` |
| Maps     | `leaflet@1.9.4`, `react-leaflet@4`                             |

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
    <!-- importmap is injected by the host from deps — do not write one manually -->
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import { createRoot } from "react-dom/client";
      import { createElement as h, useState } from "react";

      SynapWidget.onInit(async ({ context }) => {
        const items = await SynapWidget.query("entities.list", {
          profileSlug: "deal",
          limit: 200,
        }).catch(() => []);

        createRoot(document.getElementById("root")).render(
          h("p", null, `Loaded ${(items ?? []).length} deals`)
        );

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
- **No external fetch** — the sandbox has no cross-origin access; all data must go through `SynapWidget`.
- **Declare all non-React imports in `deps`** — the host generates the import map from that field.

---
