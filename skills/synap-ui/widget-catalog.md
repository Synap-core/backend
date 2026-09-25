# Widget catalog — reference

Widgets (cells) are the universal rendering unit. A bento is composed of cells. Views embed cells. Documents embed cells.

**Never guess a widget key.** Call `synap_list_widgets` (or `GET /api/hub/widget-definitions?workspaceId={workspaceId}`) first. That list IS the catalog: every built-in the pod knows (stat-card, entity-list, chart-*, view, …) plus the `cell:<pkg>:<key>` and `generated:<slug>` cells installed on the pod. Each entry carries its `requiredConfig`, `propsSchema`, `aiHint` and default size. A key it does not list is refused on arrange.

- `synap_list_widgets` (default `surface: "bento"`) — what you may place in a dashboard.
- `synap_list_widgets({ surface: "document" })` — what you may embed in a document, with an `exampleDirective` for each.

This file explains HOW widgets are referenced. It deliberately does not list the keys: the list above is generated from the catalog, and a copy here would drift.

## How widget references work in bentos

You place widgets with `POST /api/hub/views/{bentoViewId}/arrange` (IS: `arrange_workspace`) as `{ key, config, x, y, w, h }`. The pod stores each as a bento block:

```json
{
  "id": "block-123",
  "kind": "widget",
  "widgetType": "stat-card",
  "config": { "profileSlug": "task", "label": "Open tasks" },
  "pos": { "x": 0, "y": 0, "w": 3, "h": 3 }
}
```

`widgetType` is the catalog key (`typeKey` in the list). `config` must carry every key in that entry's `requiredConfig`; the rest of `propsSchema` is optional.

## The rules the list cannot tell you

- **Counts:** `stat-card` + `profileSlug`. Never `entity-count` (a legacy alias).
- **Saved views:** `view` needs `config.viewId` (a view UUID from `synap_list_views`). A `profileSlug` alone renders nothing. No saved view for that profile? Use `entity-list` + `profileSlug`.
- **Charts:** `chart-*` read a profile (`profileSlug`) and group or aggregate it. Pick the chart from the question: share of a whole → `chart-pie`, comparison → `chart-bar`, trend over time → `chart-line`.
- **`aiPlaceable: false` entries are not listed for a reason:** they need host context (a channel, a session) the pod cannot supply. Don't try to place one.

## Layout guidelines

The bento grid is 12 columns. Each list entry carries a `defaultSize`; start from it.

- Don't make anything shorter than 2 rows (too cramped).
- Tall narrow feeds (4×6) work better than short wide ones.
- Put `section-header` (12×1) as the first row of a visual group.
- Limit a bento to 8–12 blocks. Past that, split into a second bento or a dedicated view.

## Common mistakes

1. **Placing a key that is not in `synap_list_widgets`.** Arrange refuses it. Always fetch the list first.
2. **Leaving a `requiredConfig` key empty.** Arrange refuses it and names the missing key.
3. **Using a widget that depends on a missing profile.** `entity-gallery` with `profileSlug: "podcast"` when `podcast` doesn't exist shows an empty state. Verify with `synap_list_profiles` first.
4. **Overlapping layout rectangles.** The grid resolves it by shifting blocks, but the output won't match your intent. Check `x + w <= 12` and that no two blocks share cells.
