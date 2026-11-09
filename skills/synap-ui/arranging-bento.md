## Arranging a bento after creation

```json
POST /api/hub/views/{bentoViewId}/arrange
{ "userId": "{userId}", "blocks": [ /* full new blocks array */ ] }
```

`bento.arrange` is auto-approved by default. Safe to run without hesitation when the user rearranges or adds widgets. On MCP there is no arrange tool: edit the bento with `synap_update_view` (see "Which door").

Call `synap_list_widgets` first. Only place keys from that list. `stat-card` needs `profileSlug`. `view` / `view-table` need a saved `viewId`. `entity-count` is a legacy alias of `stat-card` — prefer `stat-card`.
