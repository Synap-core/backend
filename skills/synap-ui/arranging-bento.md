## Arranging a bento after creation

```json
POST /api/hub/views/{bentoViewId}/arrange
{ "userId": "{userId}", "blocks": [ /* full new blocks array */ ] }
```

`bento.arrange` is auto-approved by default. Safe to run without hesitation when the user rearranges or adds widgets.
